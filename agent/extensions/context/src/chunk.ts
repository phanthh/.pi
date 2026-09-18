/**
 * Oldest-first contiguous chunk cursor: the observer always advances through
 * history in order and never skips entries.
 */
import { estimateTokens } from "./memory.ts";

export interface ChunkEntry {
  id: string;
  text: string;
  timestamp?: string;
}

export interface ChunkSelection {
  entries: ChunkEntry[];
  /** Tokens in the selected chunk. */
  tokens: number;
  /** Tokens of everything after the cursor, including what did not fit. */
  pendingTokens: number;
  /** New cursor once this chunk is observed. */
  throughEntryId: string;
}

/**
 * Entries after `cursorId`, capped at `maxTokens` (at least one entry).
 * An unknown cursor (branch switch, edited turn) restarts from the beginning —
 * content dedupe keeps that from producing duplicate memory.
 */
export const selectChunk = (
  entries: ChunkEntry[],
  cursorId: string | undefined,
  maxTokens: number,
): ChunkSelection | null => {
  const cursorIdx = cursorId ? entries.findIndex((e) => e.id === cursorId) : -1;
  const start = cursorIdx + 1;
  const rest = entries.slice(start);
  if (rest.length === 0) return null;

  const pendingTokens = rest.reduce((sum, e) => sum + estimateTokens(e.text), 0);
  const selected: ChunkEntry[] = [];
  let tokens = 0;
  for (const entry of rest) {
    const cost = estimateTokens(entry.text);
    if (selected.length > 0 && tokens + cost > maxTokens) break;
    selected.push(entry);
    tokens += cost;
  }
  return {
    entries: selected,
    tokens,
    pendingTokens,
    throughEntryId: selected[selected.length - 1].id,
  };
};
