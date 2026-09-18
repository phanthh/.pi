/** Reflector worker, ported from pi-blackhole's durable-memory stage. */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { OmConfig } from "./config.ts";
import { estimateTokens, hashId, reflectionCoverageMap, type Observation, type Reflection } from "./memory.ts";
import { assistantText } from "./observer.ts";
import { parseReflections } from "./parse.ts";
import { REFLECTOR_SYSTEM } from "./reflector-prompt.ts";

const REFLECTOR_JSON_INSTRUCTION = `This interface has no tools. Reply with JSON only:
{"reflections":[{"content":"one self-contained single-line durable fact","supportingObservationIds":["observation-id"]}]}
Use only ids from NEW OBSERVATIONS. An empty array is valid and preferred when nothing passes the durable-value bar. Record at most 12 reflections.`;

const observationLine = (observation: Observation, coverage: string): string =>
  `[${observation.id}] ${observation.timestamp} [${observation.relevance}] [coverage: ${coverage}] ${observation.content}`;
const reflectionLine = (reflection: Reflection): string => `[${reflection.id}] ${reflection.content}`;

const boundedLines = (lines: string[], budget: number): string => {
  const selected: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = estimateTokens(lines[i]);
    if (used + cost > budget) continue;
    used += cost;
    selected.push(lines[i]);
  }
  return selected.reverse().join("\n");
};

export const runReflector = async (
  registry: Pick<ModelRegistry, "complete">,
  model: Model<Api>,
  config: OmConfig,
  request: { observations: Observation[]; activeObservations: Observation[]; reflections: Reflection[] },
  signal?: AbortSignal,
): Promise<Array<Omit<Reflection, "seq">>> => {
  if (request.observations.length === 0) return [];
  const coverage = reflectionCoverageMap(request.activeObservations, request.reflections);
  const contextBudget = Math.floor(config.reflectorInputMaxTokens * 0.15);
  const newIds = new Set(request.observations.map((observation) => observation.id));
  const existingObservations = request.activeObservations.filter((observation) => !newIds.has(observation.id));
  const prompt = [
    `EXISTING REFLECTIONS (context only):\n${boundedLines(request.reflections.map(reflectionLine), contextBudget) || "(none yet)"}`,
    `EXISTING OBSERVATIONS (context only):\n${boundedLines(existingObservations.map((observation) => observationLine(observation, coverage.get(observation.id) ?? "none")), contextBudget) || "(none yet)"}`,
    `NEW OBSERVATIONS TO PROCESS:\n${request.observations.map((observation) => observationLine(observation, coverage.get(observation.id) ?? "none")).join("\n")}`,
  ].join("\n\n");
  const response = await registry.complete(model, {
    systemPrompt: `${REFLECTOR_SYSTEM}\n\n${REFLECTOR_JSON_INSTRUCTION}`,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
  }, { maxTokens: config.maxOutputTokens, signal });
  if (response.errorMessage) throw new Error(response.errorMessage);

  const parsed = parseReflections(assistantText(response.content), newIds);
  const existingIds = new Set(request.reflections.map((reflection) => reflection.id));
  return parsed.reflections.flatMap((reflection) => {
    const id = hashId(reflection.content);
    if (existingIds.has(id)) return [];
    existingIds.add(id);
    return [{
      id,
      content: reflection.content,
      supportingObservationIds: reflection.supportingObservationIds,
      tokenCount: estimateTokens(reflection.content),
    }];
  });
};
