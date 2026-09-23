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
type AskStatus = "answered" | "cancelled" | "unavailable";
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
}

interface QuestionState {
	focus: number;
	selected: Set<number>;
	dontKnow: boolean;
	text: string;
	other: string;
	editingOther: boolean;
}

const CommonOptionProperties = {
	value: Type.Optional(
		Type.String({ description: "Machine-readable value. Defaults to label; quiz answer keys refer to this value." }),
	),
	description: Type.Optional(Type.String({ description: "Optional detail shown below option." })),
};

const PromptOptionSchema = Type.Object({
	label: Type.String({
		description:
			'Display label. Put the recommended option first and append "(Recommended)" to its label.',
	}),
	...CommonOptionProperties,
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
	questions: Type.Array(Type.Union([PromptQuestionSchema, QuizQuestionSchema]), {
		minItems: 1,
		maxItems: 8,
		description: "One to eight independent prompt or quiz questions shown in one tabbed modal.",
	}),
});

function shuffled<T>(values: T[]): T[] {
	const result = [...values];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}

function normalizeOption(raw: unknown, location: string): { option?: AskOption; error?: string } {
	if (!raw || typeof raw !== "object") return { error: `${location} must be an object` };
	const value = raw as Record<string, unknown>;
	if (typeof value.label !== "string" || !value.label.trim()) {
		return { error: `${location}.label must be nonempty` };
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
			const normalized = normalizeOption((value.options as unknown[])[optionIndex], `${location}.options[${optionIndex}]`);
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
			multiSelect: value.multiSelect === true,
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
	if (question.options.length === 0) return state.text.trim().length > 0;
	return state.selected.size > 0 || state.other.trim().length > 0;
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
		...(question.options.length === 0 && state.text.trim() ? { text: state.text.trim() } : {}),
		...(state.other.trim() ? { other: state.other.trim() } : {}),
	};
}

function resultText(responses: AskResponse[], score: { correct: number; total: number }): string {
	const lines = responses.map((response, index) => {
		const prefix = `Q${index + 1}: ${response.question}`;
		if (response.kind === "prompt") {
			if (!response.answered) return `${prefix}\nAnswer: (unanswered)`;
			if (response.mode === "text") return `${prefix}\nAnswer: ${response.text}`;
			const values = [...response.selectedValues, ...(response.other ? [`Other: ${response.other}`] : [])];
			return `${prefix}\nAnswer values: ${values.join(", ")}`;
		}
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

async function showQuestions(
	ctx: ExtensionContext,
	questions: Question[],
	signal?: AbortSignal,
): Promise<QuestionState[] | null> {
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

		for (let index = 0; index < questions.length; index++) {
			editors[index].onSubmit = (value) => {
				const question = questions[index];
				const state = states[index];
				const trimmed = value.trim();
				if (question.kind === "prompt" && question.options.length === 0) {
					state.text = trimmed;
					if (trimmed) advance();
					else refresh();
					return;
				}
				if (!trimmed) {
					state.other = "";
					state.editingOther = false;
					refresh();
					return;
				}
				state.other = trimmed;
				state.editingOther = false;
				if (!question.multiSelect) state.selected.clear();
				advance();
			};
		}

		function moveTab(delta: number) {
			currentTab = (currentTab + delta + questions.length + 1) % (questions.length + 1);
			submitWarning = false;
			refresh();
		}

		function handleInput(data: string) {
			if (matchesKey(data, Key.escape)) {
				finish(null);
				return;
			}
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
				moveTab(1);
				return;
			}
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				moveTab(-1);
				return;
			}

			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter)) {
					if (canSubmit(questions, states)) finish(states);
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
			if ((question.kind === "prompt" && question.options.length === 0) || state.editingOther) {
				editor.handleInput(data);
				refresh();
				return;
			}

			const itemCount = question.options.length + 1;
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
			const toggle = () => {
				if (question.kind === "quiz" && isExtra) {
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
					if (state.selected.has(state.focus)) state.selected.delete(state.focus);
					else state.selected.add(state.focus);
				} else {
					state.dontKnow = false;
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
				if (!question.multiSelect && !state.editingOther) advance();
			}
		}

		function render(width: number): string[] {
			const renderWidth = Math.max(1, width);
			if (cachedLines && cachedWidth === renderWidth) return cachedLines;
			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, renderWidth));

			add(theme.fg("accent", "─".repeat(renderWidth)));
			const tabs = questions.map((question, index) => {
				const complete = isAnswered(question, states[index]);
				const label = `${complete ? "■" : "□"} Q${index + 1}`;
				return index === currentTab
					? theme.bg("selectedBg", theme.fg("text", ` ${label} `))
					: theme.fg(complete ? "success" : "muted", ` ${label} `);
			});
			const submitLabel = " ✓ Submit ";
			tabs.push(
				currentTab === questions.length
					? theme.bg("selectedBg", theme.fg("text", submitLabel))
					: theme.fg(canSubmit(questions, states) ? "success" : "dim", submitLabel),
			);
			addWrapped(lines, tabs.join(" "), renderWidth, " ");
			lines.push("");

			if (currentTab === questions.length) {
				addWrapped(lines, theme.fg("accent", theme.bold("Review and submit")), renderWidth, " ");
				lines.push("");
				questions.forEach((question, index) => {
					const state = states[index];
					let summary = "(unanswered)";
					if (question.kind === "prompt" && question.options.length === 0 && state.text) summary = state.text;
					else if (state.dontKnow) summary = "I don't know";
					else {
						const labels = [...state.selected].sort((a, b) => a - b).map((i) => question.options[i]?.label);
						if (state.other) labels.push(`Other: ${state.other}`);
						if (labels.length) summary = labels.join(", ");
					}
					addWrapped(lines, theme.fg("muted", `Q${index + 1}: `) + theme.fg("text", summary), renderWidth, " ");
				});
				lines.push("");
				if (canSubmit(questions, states)) add(theme.fg("success", " Press Enter to submit"));
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

				if (question.kind === "prompt" && question.options.length === 0) {
					add(theme.fg("muted", " Your answer:"));
					for (const line of editors[currentTab].render(Math.max(1, renderWidth - 2))) add(` ${line}`);
				} else {
					question.options.forEach((option, index) => {
						const focused = state.focus === index;
						const checked = state.selected.has(index);
						const marker = question.multiSelect ? (checked ? "[x]" : "[ ]") : checked ? "(●)" : "( )";
						const prefix = focused ? theme.fg("accent", "> ") : "  ";
						const text = `${marker} ${option.label}`;
						addWrapped(lines, focused ? theme.fg("accent", text) : theme.fg(checked ? "success" : "text", text), renderWidth, prefix);
						if (option.description) addWrapped(lines, theme.fg("muted", option.description), renderWidth, "      ");
					});
					const extraFocused = state.focus === question.options.length;
					const isOther = question.kind === "prompt";
					const extraChecked = isOther ? Boolean(state.other) : state.dontKnow;
					const marker = question.multiSelect ? (extraChecked ? "[x]" : "[ ]") : extraChecked ? "(●)" : "( )";
					const label = isOther ? `Other${state.other ? ` — ${state.other}` : ""}` : "I don't know";
					addWrapped(
						lines,
						extraFocused ? theme.fg("accent", `${marker} ${label}`) : theme.fg(extraChecked ? "success" : "text", `${marker} ${label}`),
						renderWidth,
						extraFocused ? theme.fg("accent", "> ") : "  ",
					);
					if (state.editingOther) {
						lines.push("");
						add(theme.fg("muted", " Other answer:"));
						for (const line of editors[currentTab].render(Math.max(1, renderWidth - 2))) add(` ${line}`);
					}
				}
			}

			lines.push("");
			const editing =
				currentTab < questions.length &&
				((questions[currentTab].kind === "prompt" && questions[currentTab].options.length === 0) ||
					states[currentTab].editingOther);
			addWrapped(
				lines,
				theme.fg(
					"dim",
					editing
						? "Enter save • Tab/Shift-Tab or ←→ tabs • Esc cancel all"
						: "Tab/Shift-Tab or ←→ tabs • ↑↓ select • Space toggle multi • Enter select/save • Esc cancel all",
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

export default function ask(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask",
		label: "ask",
		description:
			"Ask up to 8 independent questions in one tabbed batch. Mix prompts for requirements/preferences with quizzes for objective knowledge. Gather independent known questions into one questions[] call instead of separate calls.",
		promptSnippet:
			"Use ask with questions[] to gather up to 8 known clarifications, preferences, decisions, or objective quiz answers in one call.",
		promptGuidelines: [
			"Gather independent questions you already know you need into one questions[] call; one ask call supports up to 8 questions.",
			"Use prompt questions for requirements, preferences, and decisions. Omit options for free text.",
			'For prompt options, put the recommended option first and suffix its label with "(Recommended)".',
			'Use quiz questions only for objective knowledge, with balanced distractors and a required explanation. Never label or describe any quiz option as "Recommended".',
			"Quiz correctAnswer keys are option values, not labels.",
			'Choice prompts automatically allow "Other"; quizzes instead include an exclusive "I don\'t know" choice.',
			"Prefer ask over guessing when requirements, preferences, or implementation choices are unclear.",
		],
		parameters: AskParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const normalized = normalizeQuestions(params.questions);
			if (!normalized.questions) return unavailableResult(`Invalid ask request: ${normalized.error}`);
			if (signal?.aborted) return cancelledResult();
			if (!ctx.hasUI || ctx.mode !== "tui") return unavailableResult("ask requires interactive TUI mode");

			return sharedUiLock.withLock(async () => {
				if (signal?.aborted) return cancelledResult();
				const states = await showQuestions(ctx, normalized.questions!, signal);
				if (signal?.aborted || !states) return cancelledResult();
				const responses = normalized.questions!.map((question, index) => responseFor(question, states[index]));
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
		},

		renderCall(args, theme) {
			const questions = Array.isArray(args.questions) ? args.questions : [];
			let text = theme.fg("toolTitle", theme.bold("ask ")) + theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`);
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
			if (details.status !== "answered") {
				return new Text(theme.fg("warning", details.message || "ask unavailable"), 0, 0);
			}

			const lines: string[] = [];
			details.responses.forEach((response, index) => {
				lines.push(theme.fg("accent", `Q${index + 1}: ${response.question}`));
				if (response.kind === "prompt") {
					if (!response.answered) lines.push(theme.fg("muted", "  (unanswered)"));
					else if (response.mode === "text") lines.push(`${theme.fg("success", "✓ ")}${response.text}`);
					else {
						const answers = [...response.selectedLabels, ...(response.other ? [`Other: ${response.other}`] : [])];
						lines.push(`${theme.fg("success", "✓ ")}${answers.join(", ")}`);
					}
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
