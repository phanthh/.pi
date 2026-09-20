import assert from "node:assert/strict";
import { exactSetEqual, normalizeQuestions } from "./index.ts";

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

console.log("ask logic checks passed");
