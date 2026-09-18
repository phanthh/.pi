/** Session branch entries → renderable chunk entries for the observer. */
import type { Message } from "@earendil-works/pi-ai";
import { renderMessage } from "./compact/index.ts";
import type { ChunkEntry } from "./chunk.ts";

export interface SessionEntryLike {
  id?: string;
  type?: string;
  message?: unknown;
  timestamp?: string;
}

const MAX_ENTRY_CHARS = 1_200;

export const buildTranscript = (entries: readonly SessionEntryLike[]): ChunkEntry[] => {
  const chunkEntries: ChunkEntry[] = [];
  let index = 0;
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message || !entry.id) continue;
    // Session message entries carry pi-ai messages; the session type is loose here.
    const message = entry.message as Message;
    const rendered = renderMessage(message, index++, true);
    const summary = rendered.summary.trim();
    if (!summary) continue;
    const messageTimestamp = "timestamp" in message && typeof message.timestamp === "number"
      ? new Date(message.timestamp).toISOString()
      : undefined;
    chunkEntries.push({
      id: entry.id,
      text: `[${rendered.role}] ${summary.length > MAX_ENTRY_CHARS ? `${summary.slice(0, MAX_ENTRY_CHARS)}…` : summary}`,
      timestamp: messageTimestamp ?? entry.timestamp,
    });
  }
  return chunkEntries;
};
