/** Observer worker: one isolated provider completion per due transcript chunk. */
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ChunkEntry } from "./chunk.ts";
import type { OmConfig } from "./config.ts";
import { estimateTokens, hashId, type Observation } from "./memory.ts";
import { parseObservations } from "./parse.ts";

export const OBSERVER_SYSTEM_PROMPT = [
  "You are the observation agent for a coding assistant.",
  "Preserve facts needed after raw conversation is compacted: user preferences and corrections, constraints, decisions and rationale, exact errors and resolutions, completed outcomes that must not be redone, durable blockers, and current unresolved work.",
  "Skip routine tool traffic, narration, file listings, transient attempts, and facts already present in EXISTING MEMORY.",
  "Each observation must be one self-contained plain-prose line with concrete identifiers. Put transcript labels only in sourceIds; never embed labels such as [e3] in content. Unknown labels are filtered, and a proposal with no valid source is rejected.",
  "Reply with JSON only: {\"observations\":[{\"content\":\"plain prose without citation labels\",\"relevance\":\"low|medium|high|critical\",\"sourceIds\":[\"e3\"]}]}",
  "An empty array is valid. Record at most 12 observations.",
].join("\n\n");

export interface ObserverRequest { chunk: ChunkEntry[]; existingMemory: string[] }

export const buildObserverPrompt = (request: ObserverRequest): {
  prompt: string;
  entryIdByLabel: Map<string, string>;
  timestampByLabel: Map<string, string>;
} => {
  const entryIdByLabel = new Map<string, string>();
  const timestampByLabel = new Map<string, string>();
  const lines = request.chunk.map((entry, index) => {
    const label = `e${index + 1}`;
    entryIdByLabel.set(label, entry.id);
    if (entry.timestamp) timestampByLabel.set(label, entry.timestamp);
    return `${label}: ${entry.text}`;
  });
  const existing = request.existingMemory.length
    ? `EXISTING MEMORY (do not repeat):\n${request.existingMemory.map((item) => `- ${item}`).join("\n")}\n\n`
    : "";
  return { prompt: `${existing}TRANSCRIPT CHUNK:\n${lines.join("\n")}`, entryIdByLabel, timestampByLabel };
};

export const assistantText = (content: AssistantMessage["content"]): string =>
  content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");

export interface ObserverRunResult {
  observations: Array<Omit<Observation, "seq" | "coversUpToId">>;
  rejected: number;
}

export const runObserver = async (
  registry: Pick<ModelRegistry, "complete">,
  model: Model<Api>,
  config: OmConfig,
  request: ObserverRequest,
  signal?: AbortSignal,
): Promise<ObserverRunResult> => {
  const { prompt, entryIdByLabel, timestampByLabel } = buildObserverPrompt(request);
  const response = await registry.complete(model, {
    systemPrompt: OBSERVER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
  }, { maxTokens: config.maxOutputTokens, signal });
  if (response.errorMessage) throw new Error(response.errorMessage);

  const parsed = parseObservations(assistantText(response.content), new Set(entryIdByLabel.keys()));
  return {
    rejected: parsed.rejected,
    observations: parsed.observations.map((observation) => {
      const sourceEntryIds = observation.sourceIds.flatMap((label) => {
        const id = entryIdByLabel.get(label);
        return id ? [id] : [];
      });
      const timestamps = observation.sourceIds.flatMap((label) => {
        const timestamp = timestampByLabel.get(label);
        const time = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
        return Number.isFinite(time) ? [{ timestamp, time }] : [];
      }).sort((a, b) => a.time - b.time);
      return {
        id: hashId(observation.content),
        content: observation.content,
        timestamp: timestamps.at(-1)?.timestamp ?? new Date().toISOString(),
        relevance: observation.relevance,
        sourceEntryIds,
        tokenCount: estimateTokens(observation.content),
      };
    }),
  };
};
