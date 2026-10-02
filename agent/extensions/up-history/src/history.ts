import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setImmediate } from "node:timers/promises";

const LIMIT = 30;

type Prompt = { text: string; timestamp: number };
type Candidate = Prompt & { modified: number; file: string; line: number };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

export function parsePrompt(value: unknown, fallback: number): Prompt | undefined {
	if (!record(value) || value.type !== "message" || !record(value.message)) return;
	const message = value.message;
	if (message.role !== "user") return;
	const content = message.content;
	const text = (typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.filter((part) => record(part) && part.type === "text" && typeof part.text === "string" && part.text.length > 0)
					.map((part) => part.text)
					.join("\n")
			: ""
	).trim();
	if (!text) return;

	const entryTime = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : NaN;
	const timestamp = typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
		? message.timestamp
		: Number.isFinite(entryTime)
			? entryTime
			: Number.isFinite(fallback) ? fallback : 0;
	return { text, timestamp };
}

function newestFirst(a: Candidate, b: Candidate): number {
	return b.timestamp - a.timestamp || b.modified - a.modified ||
		(a.file < b.file ? 1 : a.file > b.file ? -1 : 0) || b.line - a.line;
}

/** Returns newest first, scanning every file because file mtime need not match prompt time. */
export async function loadRecentPrompts(sessionDir: string, cwd: string): Promise<string[]> {
	let files;
	try {
		files = await readdir(sessionDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const recent: Candidate[] = [];
	for (const file of files) {
		if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
		const path = join(sessionDir, file.name);
		let input: ReturnType<typeof createReadStream> | undefined;
		let lines: ReturnType<typeof createInterface> | undefined;
		try {
			const modified = (await stat(path)).mtimeMs;
			input = createReadStream(path, { encoding: "utf8" });
			lines = createInterface({ input, crlfDelay: Infinity });
			let headerSeen = false;
			let lineNumber = 0;
			for await (const line of lines) {
				lineNumber++;
				if (lineNumber % 256 === 0) await setImmediate();
				if (!line.trim()) continue;
				const value = json(line.trim());
				if (!headerSeen) {
					if (!record(value) || value.type !== "session" || typeof value.cwd !== "string" || !value.cwd ||
						resolve(value.cwd) !== resolve(cwd)) break;
					headerSeen = true;
					continue;
				}
				const prompt = parsePrompt(value, modified);
				if (!prompt) continue;
				const candidate: Candidate = { ...prompt, modified, file: file.name, line: lineNumber };
				const duplicate = recent.findIndex((item) => item.text === prompt.text);
				if (duplicate !== -1) {
					if (newestFirst(candidate, recent[duplicate]) >= 0) continue;
					recent.splice(duplicate, 1);
				}
				recent.push(candidate);
				recent.sort(newestFirst);
				if (recent.length > LIMIT) recent.pop();
			}
		} catch {
			// A disappearing, unreadable, or damaged session must not block the editor.
		} finally {
			lines?.close();
			input?.destroy();
		}
		await setImmediate();
	}
	return recent.map((prompt) => prompt.text);
}
