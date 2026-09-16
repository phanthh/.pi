/**
 * Model-context economy: a program can return more than the context can hold.
 * Cap what the model sees, keep both ends of the text, and spill the complete
 * output to a private file whose path travels inside the visible ceiling.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const SUCCESS_BUDGET_CHARS = 50_000;
export const FAILURE_BUDGET_CHARS = 20_000;

const writeArtifact = (text: string): string | undefined => {
	try {
		const directory = mkdtempSync(path.join(tmpdir(), "pi-codemode-"));
		const file = path.join(directory, "output.txt");
		writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
		return file;
	} catch {
		return undefined;
	}
};

/** Keeps the head and tail: the ends carry the signal, the middle repeats. */
export const applyOutputBudget = (
	text: string,
	budget: number,
): { text: string; artifact?: string } => {
	if (text.length <= budget) return { text };
	const artifact = writeArtifact(text);
	const note = artifact
		? `\n\n[... ${text.length - budget} characters omitted. Full output: ${artifact} — read a range with pi.read({ path, offset, limit }) ...]\n\n`
		: `\n\n[... ${text.length - budget} characters omitted ...]\n\n`;
	const keep = Math.max(0, budget - note.length);
	const head = Math.ceil(keep * 0.6);
	const tail = keep - head;
	const truncated = `${text.slice(0, head)}${note}${tail > 0 ? text.slice(-tail) : ""}`;
	return { text: truncated, ...(artifact ? { artifact } : {}) };
};

export const formatValue = (value: unknown): string => {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
};
