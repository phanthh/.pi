import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface AskOption {
	label: string;
	value: string;
	description?: string;
	/** Prompt only: recommendation confidence 0-100 (0 = not recommended, 50 = unsure, 100 = certainly best). */
	confidence?: number;
}

interface PromptQuestion {
	kind: "prompt";
	question: string;
	details?: string;
	options: AskOption[];
	multiSelect: boolean;
	required: boolean;
}

interface QuizQuestion {
	kind: "quiz";
	question: string;
	details?: string;
	options: AskOption[];
	multiSelect: boolean;
	correctValues: string[];
	explanation: string;
}

type Question = PromptQuestion | QuizQuestion;
type AskStatus = "answered" | "queued" | "withdrawn" | "cancelled" | "unavailable";
type PromptMode = "text" | "single-select" | "multi-select";

interface PromptResponse {
	kind: "prompt";
	question: string;
	mode: PromptMode;
	required: boolean;
	answered: boolean;
	selectedValues: string[];
	selectedLabels: string[];
	text?: string;
	other?: string;
}

interface QuizResponse {
	kind: "quiz";
	question: string;
	multiSelect: boolean;
	selectedValues: string[];
	selectedLabels: string[];
	correctValues: string[];
	correct: boolean;
	explanation: string;
	dontKnow: boolean;
}

type AskResponse = PromptResponse | QuizResponse;

interface AskResultDetails {
	status: AskStatus;
	responses: AskResponse[];
	score?: { correct: number; total: number };
	message?: string;
	/** Deferred questions queued by this call. */
	queued?: { id: string; question: string }[];
}

/** Session entry (pi.appendEntry) tracking deferred questions; pending set = replay over current branch. */
type DeferredEntry =
	| { op: "ask"; items: { id: string; question: PromptQuestion }[] }
	| { op: "withdraw"; ids: string[] }; // agent withdrew

interface DeferredAnswer {
	id: string;
	response: PromptResponse;
	dismissed: boolean;
}

const DEFERRED_ENTRY = "ask-deferred";
const ANSWERS_MESSAGE = "ask-answers";
/** globalThis counter > 0 while a non-blocking UI prompt is open. Read by tmux-indicator, idle-timer. */
const NON_BLOCKING_UI_KEY = "__piNonBlockingUi";

interface QuestionState {
	focus: number;
	selected: Set<number>;
	dontKnow: boolean;
	text: string;
	other: string;
	editingOther: boolean;
	/** Deferred only: user left the decision to the agent. */
	dismissed: boolean;
}

const CommonOptionProperties = {
	value: Type.Optional(
		Type.String({ description: "Machine-readable value. Defaults to label; quiz answer keys refer to this value." }),
	),
	description: Type.Optional(Type.String({ description: "Optional detail shown below option." })),
};

const RECOMMENDED_LABEL = /\(\s*recommended\s*\)/i;

const PromptOptionSchema = Type.Object({
	label: Type.String({ description: 'Display label. Never write "(Recommended)"; use confidence instead.' }),
	...CommonOptionProperties,
	confidence: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: 100,
			description:
				"Your recommendation confidence for this option, 0-100: 0 = not recommended, 50 = maybe best, unsure, 100 = certainly best. Scored per option, need not sum to 100.",
		}),
	),
});

const QuizOptionSchema = Type.Object({
	label: Type.String({ description: 'Display label. Never append "(Recommended)" or otherwise recommend an answer.' }),
	...CommonOptionProperties,
});

const CommonQuestionProperties = {
	question: Type.String({ description: "Question shown to user." }),
	details: Type.Optional(Type.String({ description: "Optional context or instructions shown below question." })),
};

const PromptQuestionSchema = Type.Object({
	kind: Type.Literal("prompt"),
	...CommonQuestionProperties,
	options: Type.Optional(
		Type.Array(PromptOptionSchema, {
			description:
				"Choice options. Omit or pass [] for free text. Choice prompts automatically include Other.",
		}),
	),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple choices. Only applies when options exist." })),
	required: Type.Optional(Type.Boolean({ description: "Block batch submission until answered. Defaults to true." })),
});

const QuizQuestionSchema = Type.Object({
	kind: Type.Literal("quiz"),
	...CommonQuestionProperties,
	options: Type.Array(QuizOptionSchema, {
		minItems: 2,
		description: "At least two balanced answer choices. Display order is always shuffled.",
	}),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple answers." })),
	correctAnswer: Type.Union([Type.String(), Type.Array(Type.String())], {
		description: "Correct option value, or values for a multi-select quiz. Keys are option values, not labels.",
	}),
	explanation: Type.String({ description: "Required explanation shown only after submission." }),
});

const AskParams = Type.Object({
	questions: Type.Optional(
		Type.Array(Type.Union([PromptQuestionSchema, QuizQuestionSchema]), {
			minItems: 1,
			maxItems: 8,
			description: "One to eight independent prompt or quiz questions. Omit when using withdraw.",
		}),
	),
	blocking: Type.Optional(
		Type.Boolean({
			description:
				"true = pause until the user answers now. Default false = deferred: questions queue, call returns at once, answers arrive later as a message. Quizzes always block.",
		}),
	),
	withdraw: Type.Optional(
		Type.Array(Type.String(), {
			minItems: 1,
			description: "Ids of pending deferred questions (e.g. D3) that became moot. Use without questions.",
		}),
	),
});

function shuffled<T>(values: T[]): T[] {
	const result = [...values];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}

function normalizeOption(
	raw: unknown,
	location: string,
	kind: Question["kind"],
): { option?: AskOption; error?: string } {
	if (!raw || typeof raw !== "object") return { error: `${location} must be an object` };
	const value = raw as Record<string, unknown>;
	if (typeof value.label !== "string" || !value.label.trim()) {
		return { error: `${location}.label must be nonempty` };
	}
	if (RECOMMENDED_LABEL.test(value.label)) {
		return {
			error:
				kind === "quiz"
					? `${location}.label must not recommend an answer`
					: `${location}.label must not contain "(Recommended)"; set confidence (0-100) instead`,
		};
	}
	if (value.confidence !== undefined) {
		if (kind === "quiz") return { error: `${location}.confidence is not allowed on quiz options` };
		if (typeof value.confidence !== "number" || !Number.isInteger(value.confidence) || value.confidence < 0 || value.confidence > 100) {
			return { error: `${location}.confidence must be an integer from 0 to 100` };
		}
	}
	if (value.value !== undefined && (typeof value.value !== "string" || !value.value.trim())) {
		return { error: `${location}.value must be nonempty when provided` };
	}
	if (value.description !== undefined && typeof value.description !== "string") {
		return { error: `${location}.description must be a string` };
	}
	return {
		option: {
			label: value.label.trim(),
			value: typeof value.value === "string" ? value.value.trim() : value.label.trim(),
			description:
				typeof value.description === "string" && value.description.trim() ? value.description.trim() : undefined,
			confidence: typeof value.confidence === "number" ? value.confidence : undefined,
		},
	};
}

/** Runtime validation protects custom providers which do not enforce the TypeBox schema. */
export function normalizeQuestions(raw: unknown): { questions?: Question[]; error?: string } {
	if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) {
		return { error: "questions must contain between 1 and 8 items" };
	}

	const questions: Question[] = [];
	for (let index = 0; index < raw.length; index++) {
		const location = `questions[${index}]`;
		const item = raw[index];
		if (!item || typeof item !== "object") return { error: `${location} must be an object` };
		const value = item as Record<string, unknown>;
		if (value.kind !== "prompt" && value.kind !== "quiz") {
			return { error: `${location}.kind must be prompt or quiz` };
		}
		if (typeof value.question !== "string" || !value.question.trim()) {
			return { error: `${location}.question must be nonempty` };
		}
		if (value.details !== undefined && typeof value.details !== "string") {
			return { error: `${location}.details must be a string` };
		}
		if (value.options !== undefined && !Array.isArray(value.options)) {
			return { error: `${location}.options must be an array` };
		}
		if (value.multiSelect !== undefined && typeof value.multiSelect !== "boolean") {
			return { error: `${location}.multiSelect must be a boolean` };
		}
		if (value.kind === "prompt" && value.required !== undefined && typeof value.required !== "boolean") {
			return { error: `${location}.required must be a boolean` };
		}

		const options: AskOption[] = [];
		for (let optionIndex = 0; optionIndex < ((value.options as unknown[] | undefined)?.length ?? 0); optionIndex++) {
			const normalized = normalizeOption(
				(value.options as unknown[])[optionIndex],
				`${location}.options[${optionIndex}]`,
				value.kind,
			);
			if (normalized.error) return { error: normalized.error };
			options.push(normalized.option!);
		}
		const duplicate = options.find((option, optionIndex) =>
			options.slice(0, optionIndex).some((previous) => previous.value === option.value),
		);
		if (duplicate) return { error: `${location}.options contains duplicate value ${JSON.stringify(duplicate.value)}` };

		const common = {
			question: value.question.trim(),
			details: typeof value.details === "string" && value.details.trim() ? value.details.trim() : undefined,
			options,
			multiSelect: value.multiSelect === true && options.length > 0,
		};
		if (value.kind === "prompt") {
			questions.push({ kind: "prompt", ...common, required: value.required !== false });
			continue;
		}

		if (options.length < 2) return { error: `${location}.options must contain at least 2 options` };
		if (typeof value.explanation !== "string" || !value.explanation.trim()) {
			return { error: `${location}.explanation must be nonempty` };
		}
		if (typeof value.correctAnswer !== "string" && !Array.isArray(value.correctAnswer)) {
			return { error: `${location}.correctAnswer must be a string or string array` };
		}
		const rawAnswers = Array.isArray(value.correctAnswer) ? value.correctAnswer : [value.correctAnswer];
		if (rawAnswers.some((answer) => typeof answer !== "string" || !answer.trim())) {
			return { error: `${location}.correctAnswer values must be nonempty strings` };
		}
		const correctValues = rawAnswers.map((answer) => (answer as string).trim());
		if (new Set(correctValues).size !== correctValues.length) {
			return { error: `${location}.correctAnswer contains duplicate values` };
		}
		if (common.multiSelect ? correctValues.length < 1 : correctValues.length !== 1) {
			return {
				error: common.multiSelect
					? `${location}.correctAnswer must contain at least one value`
					: `${location}.correctAnswer must contain exactly one value for a single-select quiz`,
			};
		}
		const unknownAnswer = correctValues.find((answer) => !options.some((option) => option.value === answer));
		if (unknownAnswer !== undefined) {
			return { error: `${location}.correctAnswer value ${JSON.stringify(unknownAnswer)} does not match an option value` };
		}
		questions.push({
			kind: "quiz",
			...common,
			options: shuffled(options),
			correctValues,
			explanation: value.explanation.trim(),
		});
	}
	return { questions };
}

export function exactSetEqual(left: string[], right: string[]): boolean {
	return left.length === right.length && new Set(left).size === left.length && left.every((value) => right.includes(value));
}

function createEditorTheme(theme: any): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}

/** `▰▰▰▱▱ 62` badge, colored by tier: ≥75 success, ≥40 warning, else muted. */
function confidenceBadge(theme: any, confidence: number): string {
	const filled = Math.round(confidence / 20);
	const color = confidence >= 75 ? "success" : confidence >= 40 ? "warning" : "muted";
	return theme.fg(color, `${"▰".repeat(filled)}${"▱".repeat(5 - filled)} ${confidence}`);
}

function addWrapped(lines: string[], text: string, width: number, indent = ""): void {
	const contentWidth = Math.max(1, width - visibleWidth(indent));
	for (const line of wrapTextWithAnsi(text, contentWidth)) {
		lines.push(truncateToWidth(`${indent}${line}`, width));
	}
}

function promptMode(question: PromptQuestion): PromptMode {
	if (question.options.length === 0) return "text";
	return question.multiSelect ? "multi-select" : "single-select";
}

function isAnswered(question: Question, state: QuestionState): boolean {
	if (question.kind === "quiz") return state.dontKnow || state.selected.size > 0;
	// Deferred free text is typed via the "Answer" row, which stores into `other`.
	if (question.options.length === 0) return state.text.trim().length > 0 || state.other.trim().length > 0;
	return state.selected.size > 0 || state.other.trim().length > 0;
}

function isResolved(question: Question, state: QuestionState): boolean {
	return state.dismissed || isAnswered(question, state);
}

function canSubmit(questions: Question[], states: QuestionState[]): boolean {
	return questions.every((question, index) =>
		question.kind === "quiz" || question.required ? isAnswered(question, states[index]) : true,
	);
}

function responseFor(question: Question, state: QuestionState): AskResponse {
	const selectedOptions = [...state.selected]
		.sort((a, b) => a - b)
		.map((index) => question.options[index])
		.filter((option): option is AskOption => option !== undefined);
	const selectedValues = selectedOptions.map((option) => option.value);
	const selectedLabels = selectedOptions.map((option) => option.label);
	if (question.kind === "quiz") {
		return {
			kind: "quiz",
			question: question.question,
			multiSelect: question.multiSelect,
			selectedValues,
			selectedLabels,
			correctValues: question.correctValues,
			correct: !state.dontKnow && exactSetEqual(selectedValues, question.correctValues),
			explanation: question.explanation,
			dontKnow: state.dontKnow,
		};
	}
	return {
		kind: "prompt",
		question: question.question,
		mode: promptMode(question),
		required: question.required,
		answered: isAnswered(question, state),
		selectedValues,
		selectedLabels,
		...(question.options.length === 0
			? state.text.trim() || state.other.trim()
				? { text: state.text.trim() || state.other.trim() }
				: {}
			: state.other.trim()
				? { other: state.other.trim() }
				: {}),
	};
}

function promptAnswerText(response: PromptResponse): string {
	if (!response.answered) return "Answer: (unanswered)";
	if (response.mode === "text") return `Answer: ${response.text}`;
	const values = [...response.selectedValues, ...(response.other ? [`Other: ${response.other}`] : [])];
	return `Answer values: ${values.join(", ")}`;
}

function promptAnswerLabels(response: PromptResponse): string {
	return response.mode === "text"
		? (response.text ?? "")
		: [...response.selectedLabels, ...(response.other ? [`Other: ${response.other}`] : [])].join(", ");
}

function oneLine(text: string, max = 160): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function resultText(responses: AskResponse[], score: { correct: number; total: number }): string {
	const lines = responses.map((response, index) => {
		const prefix = `Q${index + 1}: ${response.question}`;
		if (response.kind === "prompt") return `${prefix}\n${promptAnswerText(response)}`;
		const selected = response.dontKnow ? "I don't know" : response.selectedValues.join(", ");
		return `${prefix}\nSelected values: ${selected}\nCorrect values: ${response.correctValues.join(", ")}\nCorrect: ${response.correct ? "yes" : "no"}\nExplanation: ${response.explanation}`;
	});
	if (score.total > 0) lines.push(`Quiz score: ${score.correct}/${score.total}`);
	return lines.join("\n\n");
}

function unavailableResult(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { status: "unavailable", responses: [], message } as AskResultDetails,
	};
}

function cancelledResult() {
	const message = "User cancelled the question batch";
	return {
		content: [{ type: "text" as const, text: message }],
		details: { status: "cancelled", responses: [], message } as AskResultDetails,
	};
}

/**
 * `deferred`: user-opened answer view over pending deferred prompts. Partial submit, a
 * "Dismiss" row per question, free text via an "Answer" row, tab labels = `labels`, and no
 * `blocked` status (nobody is waiting on it).
 */
export async function showQuestions(
	ctx: ExtensionContext,
	questions: Question[],
	signal?: AbortSignal,
	opts?: { deferred?: boolean; labels?: string[] },
): Promise<QuestionState[] | null> {
	const deferred = opts?.deferred === true;
	const submittable = (states: QuestionState[]) => deferred || canSubmit(questions, states);
	return ctx.ui.custom<QuestionState[] | null>((tui: any, theme: any, _kb: any, done: (result: QuestionState[] | null) => void) => {
		let finished = false;
		const finish = (result: QuestionState[] | null) => {
			if (finished) return;
			finished = true;
			signal?.removeEventListener("abort", abort);
			done(result);
		};
		const abort = () => finish(null);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();

		let currentTab = 0;
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;
		let submitWarning = false;
		const states: QuestionState[] = questions.map(() => ({
			focus: 0,
			selected: new Set<number>(),
			dontKnow: false,
			text: "",
			other: "",
			editingOther: false,
			dismissed: false,
		}));
		const editors = questions.map(() => new Editor(tui, createEditorTheme(theme)));

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function advance() {
			currentTab = Math.min(questions.length, currentTab + 1);
			submitWarning = false;
			refresh();
		}

		const isFreeText = (index: number) =>
			!deferred && questions[index].kind === "prompt" && questions[index].options.length === 0;
		const hasDismissRow = (question: Question) => deferred && question.kind === "prompt";
		const isEditing = (index: number) =>
			index < questions.length && (isFreeText(index) || states[index].editingOther);

		/** Store editor text into state (Enter or leaving the tab). Returns whether it is non-empty. */
		function save(index: number, value: string): boolean {
			const question = questions[index];
			const state = states[index];
			const trimmed = value.trim();
			if (isFreeText(index)) {
				state.text = trimmed;
				// Editor clears itself on submit; keep the saved answer visible and editable.
				editors[index].setText(trimmed);
				return Boolean(trimmed);
			}
			state.other = trimmed;
			state.editingOther = false;
			if (trimmed) state.dismissed = false;
			if (trimmed && !question.multiSelect) state.selected.clear();
			return Boolean(trimmed);
		}

		for (let index = 0; index < questions.length; index++) {
			editors[index].onSubmit = (value) => {
				if (save(index, value)) advance();
				else refresh();
			};
		}

		function moveTab(delta: number) {
			if (isEditing(currentTab)) save(currentTab, editors[currentTab].getText());
			currentTab = (currentTab + delta + questions.length + 1) % (questions.length + 1);
			submitWarning = false;
			refresh();
		}

		function handleInput(data: string) {
			if (matchesKey(data, Key.escape)) {
				finish(null);
				return;
			}
			// While editing, ←/→ move the cursor; only Tab/Shift-Tab switch tabs.
			const arrowsSwitch = !isEditing(currentTab);
			if (matchesKey(data, Key.tab) || (arrowsSwitch && matchesKey(data, Key.right))) {
				moveTab(1);
				return;
			}
			if (matchesKey(data, Key.shift("tab")) || (arrowsSwitch && matchesKey(data, Key.left))) {
				moveTab(-1);
				return;
			}

			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter)) {
					if (submittable(states)) finish(states);
					else {
						submitWarning = true;
						refresh();
					}
				}
				return;
			}

			const question = questions[currentTab];
			const state = states[currentTab];
			const editor = editors[currentTab];
			if (isEditing(currentTab)) {
				editor.handleInput(data);
				refresh();
				return;
			}

			const itemCount = question.options.length + 1 + (hasDismissRow(question) ? 1 : 0);
			if (matchesKey(data, Key.up)) {
				state.focus = Math.max(0, state.focus - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				state.focus = Math.min(itemCount - 1, state.focus + 1);
				refresh();
				return;
			}

			const isExtra = state.focus === question.options.length;
			const isDismiss = hasDismissRow(question) && state.focus === question.options.length + 1;
			const toggle = () => {
				if (isDismiss) {
					state.dismissed = !state.dismissed;
					if (state.dismissed) {
						state.selected.clear();
						state.other = "";
						editor.setText("");
					}
				} else if (question.kind === "quiz" && isExtra) {
					state.selected.clear();
					state.dontKnow = true;
				} else if (question.kind === "prompt" && isExtra) {
					if (question.multiSelect && state.other) {
						state.other = "";
						state.editingOther = false;
						editor.setText("");
					} else {
						state.editingOther = true;
						editor.setText(state.other);
					}
				} else if (question.multiSelect) {
					state.dontKnow = false;
					state.dismissed = false;
					if (state.selected.has(state.focus)) state.selected.delete(state.focus);
					else state.selected.add(state.focus);
				} else {
					state.dontKnow = false;
					state.dismissed = false;
					state.other = "";
					state.selected.clear();
					state.selected.add(state.focus);
				}
				refresh();
			};

			if (matchesKey(data, Key.space) && question.multiSelect) {
				toggle();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				toggle();
				if ((!question.multiSelect || (isDismiss && state.dismissed)) && !state.editingOther) advance();
			}
		}

		function render(width: number): string[] {
			const renderWidth = Math.max(1, width);
			if (cachedLines && cachedWidth === renderWidth) return cachedLines;
			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, renderWidth));

			add(theme.fg("accent", "─".repeat(renderWidth)));
			const tabs = questions.map((question, index) => {
				const complete = isResolved(question, states[index]);
				const mark = states[index].dismissed ? "×" : complete ? "■" : "□";
				const label = `${mark} ${opts?.labels?.[index] ?? `Q${index + 1}`}`;
				return index === currentTab
					? theme.bg("selectedBg", theme.fg("text", ` ${label} `))
					: theme.fg(complete ? "success" : "muted", ` ${label} `);
			});
			const submitLabel = " ✓ Submit ";
			tabs.push(
				currentTab === questions.length
					? theme.bg("selectedBg", theme.fg("text", submitLabel))
					: theme.fg(submittable(states) ? "success" : "dim", submitLabel),
			);
			addWrapped(lines, tabs.join(" "), renderWidth, " ");
			lines.push("");

			if (currentTab === questions.length) {
				addWrapped(lines, theme.fg("accent", theme.bold("Review and submit")), renderWidth, " ");
				lines.push("");
				questions.forEach((question, index) => {
					const state = states[index];
					let summary = deferred ? "(stays pending)" : "(unanswered)";
					if (state.dismissed) summary = "Dismissed — agent decides";
					else if (question.kind === "prompt" && question.options.length === 0) summary = state.text || state.other || summary;
					else if (state.dontKnow) summary = "I don't know";
					else {
						const labels = [...state.selected].sort((a, b) => a - b).map((i) => question.options[i]?.label);
						if (state.other) labels.push(`Other: ${state.other}`);
						if (labels.length) summary = labels.join(", ");
					}
					const label = opts?.labels?.[index] ?? `Q${index + 1}`;
					addWrapped(lines, theme.fg("muted", `${label}: `) + theme.fg("text", summary), renderWidth, " ");
				});
				lines.push("");
				if (deferred) {
					const resolved = questions.filter((question, index) => isResolved(question, states[index])).length;
					add(
						resolved
							? theme.fg("success", ` Press Enter to send ${resolved}; the rest stay pending`)
							: theme.fg("muted", " Nothing answered yet; Esc closes"),
					);
				} else if (canSubmit(questions, states)) add(theme.fg("success", " Press Enter to submit"));
				else {
					const missing = questions
						.map((question, index) => ({ question, index }))
						.filter(({ question, index }) =>
							(question.kind === "quiz" || question.required) && !isAnswered(question, states[index]),
						)
						.map(({ index }) => `Q${index + 1}`)
						.join(", ");
					add(theme.fg("warning", ` Required unanswered: ${missing}`));
					if (submitWarning) add(theme.fg("warning", " Complete required prompts and all quizzes."));
				}
			} else {
				const question = questions[currentTab];
				const state = states[currentTab];
				addWrapped(lines, theme.fg("text", question.question), renderWidth, " ");
				if (question.details) {
					lines.push("");
					addWrapped(lines, theme.fg("muted", question.details), renderWidth, " ");
				}
				lines.push("");

				if (isFreeText(currentTab)) {
					add(theme.fg("muted", " Your answer:"));
					for (const line of editors[currentTab].render(Math.max(1, renderWidth - 2))) add(` ${line}`);
				} else {
					question.options.forEach((option, index) => {
						const focused = state.focus === index;
						const checked = state.selected.has(index);
						const marker = question.multiSelect ? (checked ? "[x]" : "[ ]") : checked ? "(●)" : "( )";
						const prefix = focused ? theme.fg("accent", "> ") : "  ";
						const text = `${marker} ${option.label}`;
						const badge = option.confidence === undefined ? "" : `  ${confidenceBadge(theme, option.confidence)}`;
						addWrapped(
							lines,
							(focused ? theme.fg("accent", text) : theme.fg(checked ? "success" : "text", text)) + badge,
							renderWidth,
							prefix,
						);
						if (option.description) addWrapped(lines, theme.fg("muted", option.description), renderWidth, "      ");
					});
					const extraFocused = state.focus === question.options.length;
					const isOther = question.kind === "prompt";
					const extraChecked = isOther ? Boolean(state.other) : state.dontKnow;
					const marker = question.multiSelect ? (extraChecked ? "[x]" : "[ ]") : extraChecked ? "(●)" : "( )";
					const otherName = question.options.length === 0 ? "Answer" : "Other";
					const label = isOther ? `${otherName}${state.other ? ` — ${state.other}` : ""}` : "I don't know";
					addWrapped(
						lines,
						extraFocused ? theme.fg("accent", `${marker} ${label}`) : theme.fg(extraChecked ? "success" : "text", `${marker} ${label}`),
						renderWidth,
						extraFocused ? theme.fg("accent", "> ") : "  ",
					);
					if (hasDismissRow(question)) {
						const focused = state.focus === question.options.length + 1;
						const text = `${question.multiSelect ? (state.dismissed ? "[x]" : "[ ]") : state.dismissed ? "(●)" : "( )"} Dismiss — agent decides`;
						addWrapped(
							lines,
							focused ? theme.fg("accent", text) : theme.fg(state.dismissed ? "warning" : "muted", text),
							renderWidth,
							focused ? theme.fg("accent", "> ") : "  ",
						);
					}
					if (state.editingOther) {
						lines.push("");
						add(theme.fg("muted", question.options.length === 0 ? " Your answer:" : " Other answer:"));
						for (const line of editors[currentTab].render(Math.max(1, renderWidth - 2))) add(` ${line}`);
					}
				}
			}

			lines.push("");
			addWrapped(
				lines,
				theme.fg(
					"dim",
					(isEditing(currentTab)
						? "Enter save • Tab/Shift-Tab tabs"
						: "Tab/Shift-Tab or ←→ tabs • ↑↓ select • Space toggle multi • Enter select/save") +
						(deferred ? " • Esc close (nothing sent)" : " • Esc cancel all"),
				),
				renderWidth,
				" ",
			);
			add(theme.fg("accent", "─".repeat(renderWidth)));
			cachedLines = lines.map((line) => truncateToWidth(line, renderWidth));
			cachedWidth = renderWidth;
			return cachedLines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	}, deferred ? undefined : {
		blocked: {
			kind: "question",
			message: questions.length === 1 ? questions[0].question : `${questions.length} questions`,
		},
	});
}

// Shared UI mutex. Pop-up tools must not run multiple ctx.ui.custom/editor calls concurrently.
const SHARED_UI_LOCK_KEY = "__piSharedUiLock";
function getSharedUiLock() {
	const global = globalThis as any;
	if (!global[SHARED_UI_LOCK_KEY]) {
		let chain: Promise<void> = Promise.resolve();
		global[SHARED_UI_LOCK_KEY] = {
			withLock<T>(fn: () => T | Promise<T>): Promise<T> {
				const previous = chain;
				let release: () => void;
				chain = new Promise<void>((resolve) => {
					release = resolve;
				});
				return previous.then(fn).finally(() => release!());
			},
		};
	}
	return global[SHARED_UI_LOCK_KEY] as { withLock<T>(fn: () => T | Promise<T>): Promise<T> };
}
const sharedUiLock = getSharedUiLock();

type SessionCtx = Pick<ExtensionContext, "sessionManager">;

function deferredEntries(entries: ReturnType<SessionCtx["sessionManager"]["getEntries"]>): DeferredEntry[] {
	const result: DeferredEntry[] = [];
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === DEFERRED_ENTRY && entry.data) result.push(entry.data as DeferredEntry);
	}
	return result;
}

/**
 * Answers submitted via /questions but not yet in the session. A steered message can still be
 * dropped (Esc clears the agent queue), so answered = an `ask-answers` message on the branch;
 * until then ids are only hidden. Cleared on agent_settled → dropped ones become pending again.
 */
const inFlight = new Set<string>();

/** Pending deferred questions on the current branch, oldest first. */
function pendingQuestions(ctx: SessionCtx): { id: string; question: PromptQuestion }[] {
	const pending = new Map<string, PromptQuestion>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom_message" && entry.customType === ANSWERS_MESSAGE) {
			for (const answer of (entry.details as { answers?: DeferredAnswer[] } | undefined)?.answers ?? []) {
				pending.delete(answer.id);
			}
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== DEFERRED_ENTRY || !entry.data) continue;
		const data = entry.data as DeferredEntry;
		if (data.op === "ask") for (const item of data.items) pending.set(item.id, item.question);
		else for (const id of data.ids) pending.delete(id);
	}
	return [...pending].filter(([id]) => !inFlight.has(id)).map(([id, question]) => ({ id, question }));
}

/** Ids are unique across the whole session (all branches), so a D-number never means two questions. */
function nextDeferredNumber(ctx: SessionCtx): number {
	let max = 0;
	for (const data of deferredEntries(ctx.sessionManager.getEntries())) {
		if (data.op !== "ask") continue;
		for (const item of data.items) max = Math.max(max, Number(item.id.slice(1)) || 0);
	}
	return max + 1;
}

function answersText(answers: DeferredAnswer[]): string {
	const blocks = answers.map(
		(answer) =>
			`${answer.id}: ${answer.response.question}\n${answer.dismissed ? "Dismissed: user left this to you; decide yourself." : promptAnswerText(answer.response)}`,
	);
	return `User answered deferred ask questions. Reconcile any work done under different assumptions.\n\n${blocks.join("\n\n")}`;
}

export default function ask(pi: ExtensionAPI) {
	const showPendingStatus = (ctx: ExtensionContext) => {
		const count = pendingQuestions(ctx).length;
		ctx.ui.setStatus("ask", count ? `❓ ${count}` : undefined);
	};

	pi.on("session_start", async (_event, ctx) => {
		inFlight.clear();
		showPendingStatus(ctx);
	});
	// Queues are delivered or cleared by now: answers that never landed become pending again.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!inFlight.size) return;
		inFlight.clear();
		showPendingStatus(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => showPendingStatus(ctx));

	// Keeps pending ids visible after compaction so the agent can withdraw instead of re-asking.
	pi.on("before_agent_start", async (event, ctx) => {
		const sections = event.systemPromptOptions.sections;
		const pending = pendingQuestions(ctx);
		if (!pending.length) {
			delete sections.pending_questions;
			return;
		}
		sections.pending_questions = [
			"Deferred ask questions still waiting for the user. Answers arrive later as a message. Do not re-ask them. Withdraw moot ones with ask({ withdraw: [ids] }).",
			...pending.map(({ id, question }) => `- ${id}: ${oneLine(question.question)}`),
		].join("\n");
	});

	pi.registerMessageRenderer<{ answers?: DeferredAnswer[] }>(ANSWERS_MESSAGE, (message, _options, theme) => {
		const lines = [theme.fg("accent", theme.bold("↩ deferred answers"))];
		for (const answer of message.details?.answers ?? []) {
			lines.push(theme.fg("accent", `${answer.id}: ${answer.response.question}`));
			lines.push(
				answer.dismissed
					? theme.fg("warning", "  × dismissed — agent decides")
					: `${theme.fg("success", "✓ ")}${promptAnswerLabels(answer.response)}`,
			);
		}
		return new Text(lines.join("\n"), 0, 0);
	});

	pi.registerCommand("questions", {
		description: "Answer or dismiss pending deferred ask questions",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("/questions requires interactive TUI mode", "error");
				return;
			}
			await sharedUiLock.withLock(async () => {
				const pending = pendingQuestions(ctx);
				if (!pending.length) {
					ctx.ui.notify("No pending questions.", "info");
					return;
				}
				// Pi emits ui_prompt_start for every ctx.ui.custom; this flag tells waiting-state
				// consumers (tmux-indicator, idle-timer) that nobody is blocked on this one.
				const g = globalThis as any;
				g[NON_BLOCKING_UI_KEY] = (g[NON_BLOCKING_UI_KEY] ?? 0) + 1;
				const states = await showQuestions(
					ctx,
					pending.map((item) => item.question),
					undefined,
					{ deferred: true, labels: pending.map((item) => item.id) },
				).finally(() => {
					g[NON_BLOCKING_UI_KEY]--;
				});
				if (!states) return;
				// Agent may have withdrawn some while the modal was open: drop those answers.
				const stillPending = new Set(pendingQuestions(ctx).map((item) => item.id));
				const answers: DeferredAnswer[] = [];
				pending.forEach(({ id, question }, index) => {
					const state = states[index];
					if (!stillPending.has(id) || !isResolved(question, state)) return;
					answers.push({ id, response: responseFor(question, state) as PromptResponse, dismissed: state.dismissed });
				});
				if (!answers.length) return;
				for (const answer of answers) inFlight.add(answer.id);
				showPendingStatus(ctx);
				// steer → lands mid-run before the next LLM call; triggerTurn → wakes an idle agent.
				pi.sendMessage(
					{ customType: ANSWERS_MESSAGE, content: answersText(answers), display: true, details: { answers } },
					{ deliverAs: "steer", triggerTurn: true },
				);
			});
		},
	});

	const withdraw = (raw: unknown, ctx: ExtensionContext) => {
		if (!Array.isArray(raw) || raw.length === 0 || raw.some((id) => typeof id !== "string" || !id.trim())) {
			return unavailableResult("Invalid ask request: withdraw must be a nonempty array of ids");
		}
		const ids = [...new Set(raw.map((id) => (id as string).trim()))];
		const pending = pendingQuestions(ctx).map((item) => item.id);
		const unknown = ids.filter((id) => !pending.includes(id));
		if (unknown.length) {
			return unavailableResult(`Not pending: ${unknown.join(", ")}. Pending: ${pending.join(", ") || "(none)"}`);
		}
		pi.appendEntry<DeferredEntry>(DEFERRED_ENTRY, { op: "withdraw", ids });
		showPendingStatus(ctx);
		const rest = pending.filter((id) => !ids.includes(id));
		const message = `Withdrawn: ${ids.join(", ")}. Still pending: ${rest.join(", ") || "(none)"}`;
		return {
			content: [{ type: "text" as const, text: message }],
			details: { status: "withdrawn", responses: [], message } as AskResultDetails,
		};
	};

	const queue = (questions: PromptQuestion[], ctx: ExtensionContext) => {
		const start = nextDeferredNumber(ctx);
		const items = questions.map((question, index) => ({ id: `D${start + index}`, question }));
		pi.appendEntry<DeferredEntry>(DEFERRED_ENTRY, { op: "ask", items });
		showPendingStatus(ctx);
		const ids = items.map((item) => item.id).join(", ");
		const text = `Queued deferred questions: ${ids}. The user answers later; answers arrive as a message. Continue other work now, or stop if these questions block all progress. Withdraw moot ones with ask({ withdraw: [ids] }).`;
		return {
			content: [{ type: "text" as const, text }],
			details: {
				status: "queued",
				responses: [],
				queued: items.map((item) => ({ id: item.id, question: item.question.question })),
			} as AskResultDetails,
		};
	};

	pi.registerTool({
		name: "ask",
		label: "ask",
		description:
			"Ask the user up to 8 independent questions in one tabbed batch. Default is deferred: questions queue for the user, the call returns at once with ids, and answers arrive later as a message. blocking: true pauses until the user answers. Quizzes always block. withdraw: [ids] removes pending questions that became moot.",
		promptSnippet:
			"Use ask with questions[] for clarifications, preferences, decisions, or quizzes. Deferred by default (non-blocking); blocking: true waits for the answer.",
		promptGuidelines: [
			"Gather independent questions you already know you need into one questions[] call; one ask call supports up to 8 questions.",
			"ask is deferred by default: use it for non-urgent decisions, keep doing other work, and reconcile when answers arrive as a message. Set blocking: true only when the next step depends on the answer and no other useful work remains.",
			"Never re-ask a pending deferred question. Withdraw ones that became moot with ask({ withdraw: [ids] }).",
			"Use prompt questions for requirements, preferences, and decisions. Omit options for free text.",
			'For prompt options, set confidence (integer 0-100) on each option: your confidence it is the best choice. 0 = not recommended, 50 = maybe best, unsure, 100 = certainly best. Score each option independently. Order options by confidence descending unless they have a natural order. Never write "(Recommended)" in labels.',
			'Use quiz questions only for objective knowledge, with balanced distractors and a required explanation. Never label or describe any quiz option as "Recommended". Quizzes always block.',
			"Quiz correctAnswer keys are option values, not labels.",
			'Choice prompts automatically allow "Other"; quizzes instead include an exclusive "I don\'t know" choice.',
			"Prefer ask over guessing when requirements, preferences, or implementation choices are unclear.",
		],
		parameters: AskParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const raw = params as Record<string, unknown>;
			if ((raw.questions === undefined) === (raw.withdraw === undefined)) {
				return unavailableResult("Invalid ask request: pass exactly one of questions or withdraw");
			}
			if (raw.blocking !== undefined && typeof raw.blocking !== "boolean") {
				return unavailableResult("Invalid ask request: blocking must be a boolean");
			}
			if (!ctx.hasUI || ctx.mode !== "tui") return unavailableResult("ask requires interactive TUI mode");
			if (raw.withdraw !== undefined) return withdraw(raw.withdraw, ctx);

			const normalized = normalizeQuestions(raw.questions);
			if (!normalized.questions) return unavailableResult(`Invalid ask request: ${normalized.error}`);
			if (signal?.aborted) return cancelledResult();
			const questions = normalized.questions;
			if (raw.blocking !== true && questions.every((question) => question.kind === "prompt")) {
				return queue(questions as PromptQuestion[], ctx);
			}

			// Waiting for the shared lock must stay cancellable; the queued fn still runs
			// later, sees the abort, and releases the lock in order.
			const aborted = new Promise<ReturnType<typeof cancelledResult>>((resolve) => {
				signal?.addEventListener("abort", () => resolve(cancelledResult()), { once: true });
			});
			const run = sharedUiLock.withLock(async () => {
				if (signal?.aborted) return cancelledResult();
				const states = await showQuestions(ctx, questions, signal);
				if (signal?.aborted || !states) return cancelledResult();
				const responses = questions.map((question, index) => responseFor(question, states[index]));
				const quizResponses = responses.filter((response): response is QuizResponse => response.kind === "quiz");
				const score = {
					correct: quizResponses.filter((response) => response.correct).length,
					total: quizResponses.length,
				};
				return {
					content: [{ type: "text" as const, text: resultText(responses, score) }],
					details: { status: "answered", responses, score } as AskResultDetails,
				};
			});
			return Promise.race([run, aborted]);
		},

		renderCall(args, theme) {
			const title = theme.fg("toolTitle", theme.bold("ask "));
			if (Array.isArray(args.withdraw)) {
				return new Text(title + theme.fg("muted", `withdraw ${args.withdraw.join(", ")}`), 0, 0);
			}
			const questions = Array.isArray(args.questions) ? args.questions : [];
			const blocking = args.blocking === true || questions.some((raw) => (raw as { kind?: unknown } | undefined)?.kind === "quiz");
			let text =
				title +
				theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`) +
				theme.fg("dim", blocking ? " · blocking" : " · deferred");
			for (let index = 0; index < questions.length; index++) {
				const raw = questions[index];
				const question = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
				const kind = question?.kind === "quiz" ? "quiz" : question?.kind === "prompt" ? "prompt" : "invalid";
				const label = typeof question?.question === "string" ? question.question : "(malformed question)";
				text += `\n${theme.fg("dim", `  Q${index + 1} [${kind}] `)}${theme.fg("muted", label)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskResultDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.status === "queued") {
				const lines = (details.queued ?? []).map(
					(item) => `${theme.fg("warning", "⧗ ")}${theme.fg("accent", item.id)} ${theme.fg("muted", item.question)}`,
				);
				lines.push(theme.fg("dim", "  answer via /questions"));
				return new Text(lines.join("\n"), 0, 0);
			}
			if (details.status === "withdrawn") return new Text(theme.fg("muted", details.message ?? "withdrawn"), 0, 0);
			if (details.status !== "answered") {
				return new Text(theme.fg("warning", details.message || "ask unavailable"), 0, 0);
			}

			const lines: string[] = [];
			details.responses.forEach((response, index) => {
				lines.push(theme.fg("accent", `Q${index + 1}: ${response.question}`));
				if (response.kind === "prompt") {
					if (!response.answered) lines.push(theme.fg("muted", "  (unanswered)"));
					else lines.push(`${theme.fg("success", "✓ ")}${promptAnswerLabels(response)}`);
				} else {
					const selected = response.dontKnow ? "I don't know" : response.selectedLabels.join(", ");
					lines.push(`${theme.fg(response.correct ? "success" : "warning", response.correct ? "✓" : "✗")} ${selected}`);
					lines.push(theme.fg("muted", `  Correct values: ${response.correctValues.join(", ")}`));
					lines.push(theme.fg("muted", `  ${response.explanation}`));
				}
			});
			if (details.score && details.score.total > 0) {
				lines.push(theme.fg("accent", `Score: ${details.score.correct}/${details.score.total}`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
