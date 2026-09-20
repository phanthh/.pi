/** Child session file seeding + result extraction. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

export type SeededSubagentSessionMode = "lineage-only" | "fork";

/** Parent turns up to (excluding) the last user message — the fork context. */
function getForkContentLines(parentSessionFile: string): string[] {
  const lines = readFileSync(parentSessionFile, "utf8")
    .split("\n")
    .filter((line) => line.trim());

  let truncateAt = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "message" && entry.message?.role === "user") {
        truncateAt = i;
        break;
      }
    } catch {}
  }

  return lines.slice(0, truncateAt).filter((line) => {
    try {
      return JSON.parse(line).type !== "session";
    } catch {
      return true;
    }
  });
}

export function seedSubagentSessionFile(params: {
  mode: SeededSubagentSessionMode;
  parentSessionFile: string;
  childSessionFile: string;
  childCwd: string;
}): void {
  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.childCwd,
    parentSession: params.parentSessionFile,
  };
  const contentLines = params.mode === "fork" ? getForkContentLines(params.parentSessionFile) : [];
  mkdirSync(dirname(params.childSessionFile), { recursive: true });
  writeFileSync(params.childSessionFile, [JSON.stringify(header), ...contentLines].join("\n") + "\n", "utf8");
}

/** Entries after `afterLine` (count of already-seen entries). */
export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  return readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .slice(afterLine)
    .map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Last assistant text in the entries — the child's summary. Falls back to
 * `errorMessage` when the turn ended with stopReason "error" (retry exhausted),
 * so the parent does not mistake a crash for a completion.
 */
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = msg.message.content
      .filter((block) => block.type === "text" && typeof block.text === "string" && block.text.trim() !== "")
      .map((block) => block.text as string);
    if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");

    const stopReason = (msg.message as { stopReason?: unknown }).stopReason;
    const errorMessage = (msg.message as { errorMessage?: unknown }).errorMessage;
    if (stopReason === "error" && typeof errorMessage === "string" && errorMessage.trim() !== "") {
      return `Subagent error: ${errorMessage.trim()}`;
    }
  }
  return null;
}
