import { createHash } from "node:crypto";
import type { SessionProjection } from "@earendil-works/pi-coding-agent";

export const CHECKPOINT_TYPE = "context.live.checkpoint";
export const RESET_TYPE = "context.live.reset";
type ProjectedEntry = SessionProjection["entries"][number];

export interface LiveCheckpoint {
  version: 1;
  anchorId: string;
  sourceDigest: string;
  entries: ProjectedEntry[];
  before?: ProjectedEntry[];
  at?: string;
}

function digest(entries: ProjectedEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries.map(({ sourceEntry, messages }) => [sourceEntry.id, messages]))).digest("hex");
}

/** Checkpoints refer to a stable raw prefix, never to a mutable file or in-memory branch. */
export function createCheckpoint(raw: SessionProjection, effective: SessionProjection, before: SessionProjection): LiveCheckpoint {
  const anchorId = raw.entries.at(-1)?.sourceEntry.id;
  if (!anchorId) throw new Error("Cannot checkpoint a session without entries.");
  const entries = raw.entries.slice(0, raw.entries.findIndex(({ sourceEntry }) => sourceEntry.id === anchorId) + 1);
  return {
    version: 1, anchorId, sourceDigest: digest(entries), at: new Date().toISOString(),
    before: structuredClone(before.entries.map((entry) => ({ ...entry, messages: entry.messages.filter((message) => message.role !== "system") })).filter((entry) => entry.messages.length > 0)),
    entries: structuredClone(effective.entries.map((entry) => ({ ...entry, messages: entry.messages.filter((message) => message.role !== "system") })).filter((entry) => entry.messages.length > 0)),
  };
}

export function projectCheckpoint(raw: SessionProjection, checkpoint: LiveCheckpoint | undefined): SessionProjection {
  if (!checkpoint) return raw;
  const anchor = raw.entries.findIndex(({ sourceEntry }) => sourceEntry.id === checkpoint.anchorId);
  if (anchor < 0 || digest(raw.entries.slice(0, anchor + 1)) !== checkpoint.sourceDigest) {
    throw new Error("Live checkpoint anchor is stale after a branch or compaction change.");
  }
  const systemEntries: ProjectedEntry[] = raw.entries.slice(0, anchor + 1).flatMap((entry) =>
    entry.messages.filter((message) => message.role === "system").map((message) => ({ sourceEntry: entry.sourceEntry, messages: [message] })),
  );
  const entries = [...systemEntries, ...structuredClone(checkpoint.entries), ...raw.entries.slice(anchor + 1)];
  return { ...raw, entries, messages: entries.flatMap((entry) => entry.messages) };
}

export function revisionText(branch: ReturnType<import("@earendil-works/pi-coding-agent").SessionManager["getBranch"]>): string {
  const checkpoints = branch.filter((entry): entry is Extract<typeof entry, { type: "custom" }> => entry.type === "custom" && entry.customType === CHECKPOINT_TYPE)
    .map((entry) => entry.data as LiveCheckpoint)
    .filter((checkpoint) => checkpoint?.version === 1 && Array.isArray(checkpoint.before) && Array.isArray(checkpoint.entries));
  if (!checkpoints.length) return "# Live context revisions\n\nNo accepted revisions on this branch.\n";
  const lines = ["# Live context revisions", "", "Branch-local accepted snapshots. Original JSONL history is unchanged.", ""];
  const display = (entry: ProjectedEntry) => entry.messages.map((message) => JSON.stringify(message)).join("\n");
  for (const [index, checkpoint] of checkpoints.entries()) {
    lines.push(`## Revision ${index + 1} · ${checkpoint.at ?? "unknown time"}`, "");
    const before = checkpoint.before!;
    const after = checkpoint.entries;
    const beforeById = new Map(before.map((entry) => [entry.sourceEntry.id, entry]));
    const afterIds = after.map((entry) => entry.sourceEntry.id);
    for (const entry of before) {
      if (!afterIds.includes(entry.sourceEntry.id)) lines.push(`- Omitted ${entry.sourceEntry.id}: ${display(entry)}`);
    }
    for (const entry of after) {
      const prior = beforeById.get(entry.sourceEntry.id);
      if (!prior) lines.push(`+ Added ${entry.sourceEntry.id}: ${display(entry)}`);
      else if (display(prior) !== display(entry)) lines.push(`~ Changed ${entry.sourceEntry.id}:\n  before: ${display(prior)}\n  after:  ${display(entry)}`);
    }
    const retainedBefore = before.filter((entry) => afterIds.includes(entry.sourceEntry.id)).map((entry) => entry.sourceEntry.id);
    const retainedAfter = after.filter((entry) => beforeById.has(entry.sourceEntry.id)).map((entry) => entry.sourceEntry.id);
    if (JSON.stringify(retainedBefore) !== JSON.stringify(retainedAfter)) lines.push(`↕ Reordered: ${retainedAfter.join(" → ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function latestCheckpoint(branch: ReturnType<import("@earendil-works/pi-coding-agent").SessionManager["getBranch"]>, raw: SessionProjection): LiveCheckpoint | undefined {
  const visibleIds = new Set(raw.entries.map((entry) => entry.sourceEntry.id));
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === RESET_TYPE) return undefined;
    if (entry.type === "custom" && entry.customType === CHECKPOINT_TYPE && visibleIds.has(entry.id)) {
      const data = entry.data as LiveCheckpoint | undefined;
      if (data?.version === 1 && Array.isArray(data.entries) && typeof data.anchorId === "string") return data;
    }
  }
}
