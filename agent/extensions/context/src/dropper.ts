/** Dropper worker + deterministic safety gates, ported from pi-blackhole OM. */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { OmConfig } from "./config.ts";
import { reflectionCoverageMap, type Observation, type Reflection } from "./memory.ts";
import { assistantText } from "./observer.ts";
import { parseDropIds } from "./parse.ts";
import { DROPPER_SYSTEM } from "./dropper-prompt.ts";
import { sectionBudgets, selectWithinBudget } from "./prompt-budget.ts";

const DROP_LOW_URGENCY_FULLNESS = 0.3;
const DROP_MEDIUM_URGENCY_FULLNESS = 0.6;
const DROP_MIN_RATIO = 0.1;
const DROP_MAX_RATIO = 0.5;

type Coverage = "none" | "partial" | "strong";
const COVERAGE_RANK: Record<Coverage, number> = { strong: 0, partial: 1, none: 2 };
const RELEVANCE_RANK: Record<Observation["relevance"], number> = { low: 0, medium: 1, high: 2, critical: 3 };

export const observationPoolFullness = (tokens: number, budget: number): number =>
  Number.isFinite(tokens) && tokens > 0 && Number.isFinite(budget) && budget > 0 ? tokens / budget : 0;

export const maxDropCountForPool = (
  observations: readonly Observation[],
  observationTokens: number,
  budgetTokens: number,
  skipFullness = 0.1,
): number => {
  const droppableCount = observations.filter((observation) => observation.relevance !== "critical").length;
  const fullness = observationPoolFullness(observationTokens, budgetTokens);
  if (droppableCount === 0 || fullness < skipFullness) return 0;
  const capped = Math.min(1, Math.max(skipFullness, fullness));
  const ratio = skipFullness >= 1
    ? DROP_MAX_RATIO
    : DROP_MIN_RATIO + ((capped - skipFullness) / (1 - skipFullness)) * (DROP_MAX_RATIO - DROP_MIN_RATIO);
  return Math.max(1, Math.floor(droppableCount * ratio));
};

const timestampRank = (timestamp: string): number => {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

export const selectDropCandidates = (
  ids: readonly string[],
  observations: readonly Observation[],
  maxDrops: number,
  reflections: readonly Reflection[] = [],
): string[] => {
  if (maxDrops <= 0) return [];
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const coverage = reflectionCoverageMap(observations, reflections);
  const proposalOrder = new Map<string, number>();
  ids.forEach((id, index) => { if (!proposalOrder.has(id)) proposalOrder.set(id, index); });
  return [...proposalOrder].flatMap(([id, order]) => {
    const observation = byId.get(id);
    return observation ? [{ id, order, observation }] : [];
  }).sort((a, b) => {
    const coverageDelta = COVERAGE_RANK[coverage.get(a.id) ?? "none"] - COVERAGE_RANK[coverage.get(b.id) ?? "none"];
    const relevanceDelta = RELEVANCE_RANK[a.observation.relevance] - RELEVANCE_RANK[b.observation.relevance];
    return coverageDelta || relevanceDelta || timestampRank(a.observation.timestamp) - timestampRank(b.observation.timestamp) || a.order - b.order;
  }).slice(0, maxDrops).map(({ id }) => id);
};

const reflectionLine = (reflection: Reflection): string => `[${reflection.id}] ${reflection.content}`;
const observationLine = (observation: Observation, coverage: Coverage): string =>
  `[${observation.id}] ${observation.timestamp} [${observation.relevance}] [coverage: ${coverage}] ${observation.content}`;
export const runDropper = async (
  registry: Pick<ModelRegistry, "complete">,
  model: Model<Api>,
  config: OmConfig,
  request: { candidates: Observation[]; activeObservations: Observation[]; reflections: Reflection[] },
  signal?: AbortSignal,
): Promise<string[]> => {
  if (request.candidates.length === 0) return [];
  const poolTokens = request.activeObservations.reduce((sum, observation) => sum + observation.tokenCount, 0);
  const fullness = observationPoolFullness(poolTokens, config.observationsPoolMaxTokens);
  const maxDrops = maxDropCountForPool(
    request.candidates,
    poolTokens,
    config.observationsPoolMaxTokens,
    config.dropperPoolFullnessThreshold,
  );
  if (maxDrops === 0) return [];

  const coverage = reflectionCoverageMap(request.activeObservations, request.reflections);
  const urgency = fullness < DROP_LOW_URGENCY_FULLNESS ? "low" : fullness < DROP_MEDIUM_URGENCY_FULLNESS ? "medium" : "high";
  const status = `Pool: ~${poolTokens} tokens / ~${config.observationsPoolMaxTokens}; fullness: ~${Math.round(fullness * 100)}%; urgency: ${urgency}; maximum drops: ${maxDrops}. Maximum is a hard bound, not a target.`;
  const replyInstruction = `Reply with JSON only: {"ids":["observation-id"]}. Use only candidate ids. An empty ids array is valid and preferred when no drop is clearly safe.`;
  const fixedText = `${DROPPER_SYSTEM}\nCURRENT REFLECTIONS:\nEXISTING ACTIVE OBSERVATIONS (context only; not candidates):\nNEW OBSERVATIONS TO EVALUATE FOR DROPPING:\n${status}\n${replyInstruction}\n(none yet)`;
  const budgets = sectionBudgets(config.dropperInputMaxTokens, fixedText);
  const candidates = selectWithinBudget(
    request.candidates,
    budgets.candidates,
    (observation) => observationLine(observation, coverage.get(observation.id) ?? "none"),
  );
  if (candidates.length === 0) return [];
  const candidateIds = new Set(candidates.map((observation) => observation.id));
  const existingObservations = request.activeObservations.filter((observation) => !candidateIds.has(observation.id));
  const currentReflections = selectWithinBudget(request.reflections, budgets.existing, reflectionLine, true);
  const existing = selectWithinBudget(
    existingObservations,
    budgets.existing,
    (observation) => observationLine(observation, coverage.get(observation.id) ?? "none"),
    true,
  );
  const prompt = [
    `CURRENT REFLECTIONS:\n${currentReflections.map(reflectionLine).join("\n") || "(none yet)"}`,
    `EXISTING ACTIVE OBSERVATIONS (context only; not candidates):\n${existing.map((observation) => observationLine(observation, coverage.get(observation.id) ?? "none")).join("\n") || "(none yet)"}`,
    `NEW OBSERVATIONS TO EVALUATE FOR DROPPING:\n${candidates.map((observation) => observationLine(observation, coverage.get(observation.id) ?? "none")).join("\n")}`,
    status,
    replyInstruction,
  ].join("\n\n");
  const response = await registry.complete(model, {
    systemPrompt: `${DROPPER_SYSTEM}\n\nThis interface has no tools; return the requested JSON object instead.`,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
  }, { maxTokens: config.maxOutputTokens, signal });
  if (response.errorMessage) throw new Error(response.errorMessage);
  const proposed = parseDropIds(assistantText(response.content), candidateIds);
  return selectDropCandidates(proposed, request.candidates, maxDrops, request.reflections);
};
