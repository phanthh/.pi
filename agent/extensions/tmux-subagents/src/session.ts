/** Child session result extraction. */
import { readFileSync } from "node:fs";

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

export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  return readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .slice(afterLine)
    .map((line) => JSON.parse(line) as SessionEntry);
}

/** `message` argument of a `subagent_done` call in this content, if any. */
function doneMessage(content: MessageEntry["message"]["content"]): string | null {
  for (const block of content) {
    if (block.type !== "toolCall" || block.name !== "subagent_done") continue;
    const message = (block.arguments as { message?: unknown } | undefined)?.message;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  return null;
}

/**
 * The child's summary: an explicit `subagent_done({ message })` wins, else the
 * last assistant text. Falls back to `errorMessage` when the turn ended with
 * stopReason "error" (retry exhausted), so the parent does not mistake a crash
 * for a completion.
 */
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const done = doneMessage(msg.message.content);
    if (done) return done;

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
