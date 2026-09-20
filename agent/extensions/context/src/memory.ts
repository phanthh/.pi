/** Append-only observational-memory ledger and deterministic projection. */
import { createHash } from "node:crypto";

export type Relevance = "low" | "medium" | "high" | "critical";

export interface Observation {
  id: string;
  content: string;
  timestamp: string;
  relevance: Relevance;
  sourceEntryIds: string[];
  tokenCount: number;
  /** Runtime append order; never persisted as semantic data. */
  seq: number;
  /** Transcript cursor covered by the batch that recorded this observation. */
  coversUpToId: string;
}

export interface Reflection {
  id: string;
  content: string;
  supportingObservationIds: string[];
  tokenCount: number;
  seq: number;
}

export interface ObservationBatch {
  coversUpToId: string;
  observations: Array<Omit<Observation, "seq" | "coversUpToId">>;
}

export interface ReflectionBatch {
  coversUpToId: string;
  reflections: Array<Omit<Reflection, "seq">>;
}

export interface DropBatch {
  coversUpToId: string;
  observationIds: string[];
}

export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
export const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
export const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
/** Pre-reflector builds used this custom type. Kept for session migration. */
export const LEGACY_OBSERVATIONS_RECORDED = "om-observations";

export const RELEVANCE_WEIGHT: Record<Relevance, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const MEMORY_START = "[Observations]";
export const MEMORY_END = "[/Observations]";
const LEGACY_MEMORY_START = "[OBSERVED MEMORY]";
const LEGACY_MEMORY_END = "[/OBSERVED MEMORY]";

/** ~4 chars/token, same fallback used by compact. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
export const contentKey = (content: string): string => content.trim().replace(/\s+/g, " ").toLowerCase();
export const stripSourceLabels = (content: string): string =>
  content.replace(/(?:\s*\[e\d+\])+\s*$/gi, "").trim();
export const hashId = (content: string): string =>
  createHash("sha256").update(content).digest("hex").slice(0, 12);

const observationLine = (observation: Observation): string =>
  `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
const reflectionLine = (reflection: Reflection): string => `[${reflection.id}] ${reflection.content}`;

/** Relevance dominates recency. Output remains chronological. */
export const projectObservations = (observations: Observation[], budgetTokens: number): Observation[] => {
  if (observations.length === 0 || budgetTokens <= 0) return [];
  const ranked = observations.map((observation, index) => ({
    observation,
    index,
    score: RELEVANCE_WEIGHT[observation.relevance] * 10 + (observations.length > 1 ? index / (observations.length - 1) : 1),
  })).sort((a, b) => b.score - a.score || b.index - a.index);
  const selected: typeof ranked = [];
  let used = 0;
  for (const item of ranked) {
    const cost = estimateTokens(observationLine(item.observation));
    if (used + cost > budgetTokens) continue;
    used += cost;
    selected.push(item);
  }
  return selected.sort((a, b) => a.index - b.index).map(({ observation }) => observation);
};

/** Newest reflections survive first when bounded. */
export const projectReflections = (reflections: Reflection[], budgetTokens: number): Reflection[] => {
  if (reflections.length === 0 || budgetTokens <= 0) return [];
  const selected: Reflection[] = [];
  let used = 0;
  for (let i = reflections.length - 1; i >= 0; i--) {
    const reflection = reflections[i];
    const cost = estimateTokens(reflectionLine(reflection));
    if (used + cost > budgetTokens) continue;
    used += cost;
    selected.push(reflection);
  }
  return selected.reverse();
};

/** Backward-compatible observation-only helper used by older callers/tests. */
export const projectMemory = projectObservations;

export const renderMemoryBlock = (
  observations: Observation[],
  reflections: Reflection[] = [],
): string => {
  if (observations.length === 0 && reflections.length === 0) return "";
  const sections: string[] = [];
  if (reflections.length > 0) sections.push(`## Reflections\n${reflections.map(reflectionLine).join("\n")}`);
  if (observations.length > 0) sections.push(`## Observations\n${observations.map(observationLine).join("\n")}`);
  sections.push("Use `recall` with a bracketed id when exact source context is needed. When entries conflict, newest observation wins.");
  return `${MEMORY_START}\n${sections.join("\n\n")}\n${MEMORY_END}`;
};

/** Remove current and legacy injected memory blocks. */
export const stripMemoryBlock = (summary: string): string => {
  let result = summary;
  for (const [open, close] of [
    [MEMORY_START, MEMORY_END],
    [LEGACY_MEMORY_START, LEGACY_MEMORY_END],
  ] as const) {
    while (true) {
      const start = result.indexOf(open);
      if (start < 0) break;
      const end = result.indexOf(close, start + open.length);
      result = end < 0
        ? result.slice(0, start)
        : `${result.slice(0, start)}${result.slice(end + close.length)}`;
    }
  }
  return result.trimEnd();
};

export const reflectionCoverageMap = (
  observations: readonly Observation[],
  reflections: readonly Reflection[],
): Map<string, "none" | "partial" | "strong"> => {
  const counts = new Map<string, number>();
  for (const reflection of reflections) {
    for (const id of new Set(reflection.supportingObservationIds)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return new Map(observations.map((observation) => {
    const count = counts.get(observation.id) ?? 0;
    return [observation.id, count === 0 ? "none" : count === 1 ? "partial" : "strong"];
  }));
};
