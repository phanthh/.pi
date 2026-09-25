import assert from "node:assert/strict";
import { exactSetEqual, normalizeQuestions, showQuestions } from "./index.ts";

assert.equal(exactSetEqual(["a", "b"], ["b", "a"]), true);
assert.equal(exactSetEqual(["a"], ["a", "b"]), false);
assert.equal(exactSetEqual(["a", "a"], ["a", "a"]), false);

const mixed = normalizeQuestions([
	{ kind: "prompt", question: "Goal?", required: false },
	{
		kind: "quiz",
		question: "Pick both",
		options: [
			{ label: "A", value: "a" },
			{ label: "B", value: "b" },
			{ label: "C", value: "c" },
		],
		multiSelect: true,
		correctAnswer: ["a", "c"],
		explanation: "A and C.",
	},
]);
assert.ok(mixed.questions);
assert.equal(mixed.questions.length, 2);
const quiz = mixed.questions[1];
assert.equal(quiz.kind, "quiz");
assert.deepEqual(new Set(quiz.options.map((option) => option.value)), new Set(["a", "b", "c"]));
if (quiz.kind === "quiz") assert.deepEqual(quiz.correctValues, ["a", "c"]);

assert.match(
	normalizeQuestions([
		{
			kind: "quiz",
			question: "Duplicate",
			options: [
				{ label: "A", value: "same" },
				{ label: "B", value: "same" },
			],
			correctAnswer: "same",
			explanation: "No.",
		},
	]).error ?? "",
	/duplicate value/,
);
assert.match(
	normalizeQuestions([
		{
			kind: "quiz",
			question: "Unknown key",
			options: [{ label: "A" }, { label: "B" }],
			correctAnswer: "missing",
			explanation: "No.",
		},
	]).error ?? "",
	/does not match an option value/,
);

// TUI flow: free text survives tab switches and revisits; ←/→ edit instead of switching tabs.
{
	const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };
	let component: any;
	const ctx: any = {
		ui: {
			custom: (factory: any) =>
				new Promise((resolve) => {
					component = factory({ requestRender() {}, terminal: { rows: 40, columns: 80 } }, theme, null, resolve);
				}),
		},
	};
	const { questions } = normalizeQuestions([
		{ kind: "prompt", question: "Name?" },
		{ kind: "prompt", question: "Pick", options: [{ label: "A" }] },
	]);
	const result = showQuestions(ctx, questions!);
	const type = (s: string) => [...s].forEach((ch) => component.handleInput(ch));
	const screen = () => component.render(80).join("\n");

	type("ac");
	component.handleInput("\x1b[D"); // ← moves cursor, stays on Q1
	type("b");
	component.handleInput("\t"); // leave without Enter
	assert.match(screen(), /Pick/);
	component.handleInput("\x1b[Z"); // back to Q1
	assert.match(screen(), /abc/, "saved text shown on revisit");
	component.handleInput("\r"); // Enter on revisit keeps the answer
	component.handleInput("\x1b[Z");
	assert.match(screen(), /abc/, "Enter did not wipe answer");

	// Other editor: typed text kept on Tab.
	component.handleInput("\t");
	component.handleInput("\x1b[B");
	component.handleInput("\r");
	type("zz");
	component.handleInput("\t");
	component.handleInput("\r"); // submit tab
	const states: any = await result;
	assert.equal(states[0].text, "abc");
	assert.equal(states[1].other, "zz");
}

console.log("ask logic checks passed");
