/** Reflector worker for durable-memory synthesis. */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { OmConfig } from "./config.ts";
import { estimateTokens, hashId, reflectionCoverageMap, type Observation, type Reflection } from "./memory.ts";
import { assistantText } from "./observer.ts";
import { parseReflections } from "./parse.ts";
import { sectionBudgets, selectWithinBudget } from "./prompt-budget.ts";
import { REFLECTOR_SYSTEM } from "./reflector-prompt.ts";

const REFLECTOR_JSON_INSTRUCTION = `This interface has no tools. Reply with JSON only:
{"reflections":[{"content":"one self-contained single-line durable fact","supportingObservationIds":["observation-id"]}]}
Use only ids from NEW OBSERVATIONS. An empty array is valid and preferred when nothing passes the durable-value bar. Record at most 12 reflections.`;

const observationLine = (observation: Observation, coverage: string): string =>
  `[${observation.id}] ${observation.timestamp} [${observation.relevance}] [coverage: ${coverage}] ${observation.content}`;
const reflectionLine = (reflection: Reflection): string => `[${reflection.id}] ${reflection.content}`;

export const runReflector = async (
  registry: Pick<ModelRegistry, "complete">,
  model: Model<Api>,
  config: OmConfig,
  request: { observations: Observation[]; activeObservations: Observation[]; reflections: Reflection[] },
  signal?: AbortSignal,
): Promise<Array<Omit<Reflection, "seq">>> => {
  if (request.observations.length === 0) return [];
  const coverage = reflectionCoverageMap(request.activeObservations, request.reflections);
  const fixedText = `${REFLECTOR_SYSTEM}\n${REFLECTOR_JSON_INSTRUCTION}\nEXISTING REFLECTIONS (context only):\nEXISTING OBSERVATIONS (context only):\nNEW OBSERVATIONS TO PROCESS:\n(none yet)`;
  const budgets = sectionBudgets(config.reflectorInputMaxTokens, fixedText);
  const candidates = selectWithinBudget(
    request.observations,
    budgets.candidates,
    (observation) => observationLine(observation, coverage.get(observation.id) ?? "none"),
  );
  if (candidates.length === 0) return [];
  const newIds = new Set(candidates.map((observation) => observation.id));
  const existingObservations = request.activeObservations.filter((observation) => !newIds.has(observation.id));
  const existingReflections = selectWithinBudget(request.reflections, budgets.existing, reflectionLine, true);
  const existing = selectWithinBudget(
    existingObservations,
    budgets.existing,
    (observation) => observationLine(observation, coverage.get(observation.id) ?? "none"),
    true,
  );
  const prompt = [
    `EXISTING REFLECTIONS (context only):\n${existingReflections.map(reflectionLine).join("\n") || "(none yet)"}`,
    `EXISTING OBSERVATIONS (context only):\n${existing.map((observation) => observationLine(observation, coverage.get(observation.id) ?? "none")).join("\n") || "(none yet)"}`,
    `NEW OBSERVATIONS TO PROCESS:\n${candidates.map((observation) => observationLine(observation, coverage.get(observation.id) ?? "none")).join("\n")}`,
  ].join("\n\n");
  const response = await registry.complete(model, {
    systemPrompt: `${REFLECTOR_SYSTEM}\n\n${REFLECTOR_JSON_INSTRUCTION}`,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
  }, { maxTokens: config.maxOutputTokens, signal });
  if (response.errorMessage) throw new Error(response.errorMessage);

  const parsed = parseReflections(assistantText(response.content), newIds);
  const emittedIds = new Set<string>();
  return parsed.reflections.flatMap((reflection) => {
    const id = hashId(reflection.content);
    if (emittedIds.has(id)) return [];
    emittedIds.add(id);
    return [{
      id,
      content: reflection.content,
      supportingObservationIds: reflection.supportingObservationIds,
      tokenCount: estimateTokens(reflection.content),
    }];
  });
};
