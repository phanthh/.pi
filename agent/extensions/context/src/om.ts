/** Full Observer → Reflector → Dropper observational-memory pipeline. */
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderMessage } from "./compact/index.ts";
import { selectChunk } from "./chunk.ts";
import { DEFAULT_CONFIG, loadConfig, type OmConfig, type OmModelRef } from "./config.ts";
import { runDropper } from "./dropper.ts";
import {
  estimateTokens,
  hashId,
  LEGACY_OBSERVATIONS_RECORDED,
  OM_OBSERVATIONS_DROPPED,
  OM_OBSERVATIONS_RECORDED,
  OM_REFLECTIONS_RECORDED,
  projectObservations,
  projectReflections,
  reflectionCoverageMap,
  renderMemoryBlock,
  stripMemoryBlock,
  stripSourceLabels,
  type DropBatch,
  type Observation,
  type ObservationBatch,
  type Reflection,
  type ReflectionBatch,
} from "./memory.ts";
import { runObserver } from "./observer.ts";
import { runReflector } from "./reflector.ts";
import { buildTranscript, type SessionEntryLike } from "./transcript.ts";

const EXISTING_MEMORY_TOKENS = 1_200;
type Stage = "observer" | "reflector" | "dropper";

export interface OmGauge {
  current: number;
  limit: number;
  /** Why the stage cannot run regardless of `current`. */
  blocked?: string;
}

export interface OmMetrics {
  activeObservations: number;
  totalObservations: number;
  reflections: number;
  tombstones: number;
  observer: OmGauge;
  reflector: OmGauge;
  dropper: OmGauge;
  observationPool: OmGauge;
  dropperPressure: OmGauge;
  activeStage?: Stage | "starting";
  lastError?: string;
}

export interface OmRuntime {
  getConfig: () => OmConfig;
  reload: (ctx: { cwd: string; isProjectTrusted: () => boolean }) => OmConfig;
  metrics: (ctx: ExtensionContext) => OmMetrics;
  recall: (query: string, ctx: ExtensionContext) => string | undefined;
  augmentRecall: (output: string, entryIds: string[], ctx: ExtensionContext) => string;
  enrichSummary: (summary: string) => string;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
const relevance = (value: unknown): Observation["relevance"] =>
  value === "low" || value === "high" || value === "critical" ? value : "medium";
const validTimestamp = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
};

const readObservationBatch = (
  value: unknown,
  aliases: Map<string, string>,
  validSourceIds: ReadonlySet<string>,
  sourceTimestamps: ReadonlyMap<string, string>,
  batchTimestamp?: string,
): ObservationBatch | null => {
  const data = record(value);
  const coversUpToId = data?.coversUpToId ?? data?.throughEntryId;
  if (typeof coversUpToId !== "string" || !Array.isArray(data?.observations)) return null;
  const observations: ObservationBatch["observations"] = [];
  for (const raw of data.observations) {
    const item = record(raw);
    if (!item || typeof item.content !== "string" || !item.content.trim()) continue;
    const sourceEntryIds = strings(item.sourceEntryIds ?? item.sourceIds)?.filter((id) => validSourceIds.has(id));
    if (!sourceEntryIds?.length) continue;
    const content = stripSourceLabels(item.content);
    if (!content) continue;
    const id = hashId(content);
    if (typeof item.id === "string" && /^[a-f0-9]{12}$/i.test(item.id)) aliases.set(item.id.toLowerCase(), id);
    let timestamp = validTimestamp(item.timestamp);
    if (!timestamp) {
      for (const sourceId of sourceEntryIds) timestamp = sourceTimestamps.get(sourceId) ?? timestamp;
    }
    timestamp ??= validTimestamp(batchTimestamp) ?? "unknown";
    observations.push({
      id,
      content,
      timestamp,
      relevance: relevance(item.relevance),
      sourceEntryIds,
      tokenCount: estimateTokens(content),
    });
  }
  return { coversUpToId, observations };
};

const readReflectionBatch = (
  value: unknown,
  aliases: Map<string, string>,
  validObservationIds: ReadonlySet<string>,
): ReflectionBatch | null => {
  const data = record(value);
  if (typeof data?.coversUpToId !== "string" || !Array.isArray(data.reflections)) return null;
  const reflections: ReflectionBatch["reflections"] = [];
  for (const raw of data.reflections) {
    const item = record(raw);
    if (!item || typeof item.content !== "string" || !item.content.trim() || /[\r\n]/.test(item.content)) continue;
    const storedSupportingIds = strings(item.supportingObservationIds);
    if (!storedSupportingIds?.length) continue;
    const supportingObservationIds = storedSupportingIds
      .map((supportId) => aliases.get(supportId.toLowerCase()) ?? supportId)
      .filter((supportId) => validObservationIds.has(supportId));
    if (supportingObservationIds.length === 0) continue;
    const content = item.content.trim();
    const id = hashId(content);
    if (typeof item.id === "string" && /^[a-f0-9]{12}$/i.test(item.id)) aliases.set(item.id.toLowerCase(), id);
    reflections.push({
      id,
      content,
      supportingObservationIds,
      tokenCount: estimateTokens(content),
    });
  }
  return { coversUpToId: data.coversUpToId, reflections };
};

const readDropBatch = (value: unknown, aliases: Map<string, string>): DropBatch | null => {
  const data = record(value);
  const observationIds = strings(data?.observationIds);
  return typeof data?.coversUpToId === "string" && observationIds
    ? { coversUpToId: data.coversUpToId, observationIds: observationIds.map((id) => aliases.get(id.toLowerCase()) ?? id) }
    : null;
};

export const registerOm = (pi: ExtensionAPI): OmRuntime => {
  let config = DEFAULT_CONFIG;
  let observations: Observation[] = [];
  let reflections: Reflection[] = [];
  let droppedIds = new Set<string>();
  let idAliases = new Map<string, string>();
  let observerCursor: string | undefined;
  let reflectorCursor: string | undefined;
  let dropperCursor: string | undefined;
  let activeRun: { id: symbol; controller: AbortController } | undefined;
  let generation = 0;
  let lastError: string | undefined;
  let lastStage: Stage | undefined;
  let retryAfter = 0;

  const activeObservations = (): Observation[] => observations.filter((observation) => !droppedIds.has(observation.id));
  const cancel = () => { activeRun?.controller.abort(); activeRun = undefined; };

  const restore = (ctx: ExtensionContext) => {
    observations = [];
    reflections = [];
    droppedIds = new Set<string>();
    idAliases = new Map<string, string>();
    observerCursor = reflectorCursor = dropperCursor = undefined;
    const observationIds = new Set<string>();
    const reflectionIds = new Set<string>();
    const branch = ctx.sessionManager.getBranch() as readonly SessionEntryLike[];
    const transcript = buildTranscript(branch);
    const sourceTimestamps = new Map(
      transcript.flatMap((entry) => entry.timestamp ? [[entry.id, entry.timestamp] as const] : []),
    );
    const validSourceIds = new Set(branch.filter((entry) => entry.type === "message" || entry.type === "branch_summary").flatMap((entry) => entry.id ? [entry.id] : []));
    // A stray batch (landed after a leaf switch) must not move cursors off-branch → full re-observe.
    const cursorIds = new Set(transcript.map((entry) => entry.id));
    for (const entry of branch) {
      if (entry.type !== "custom") continue;
      if (entry.customType === OM_OBSERVATIONS_RECORDED || entry.customType === LEGACY_OBSERVATIONS_RECORDED) {
        const batch = readObservationBatch(entry.data, idAliases, validSourceIds, sourceTimestamps, entry.timestamp);
        if (!batch) continue;
        if (cursorIds.has(batch.coversUpToId)) observerCursor = batch.coversUpToId;
        for (const item of batch.observations) {
          if (observationIds.has(item.id)) continue;
          observationIds.add(item.id);
          observations.push({ ...item, seq: observations.length, coversUpToId: batch.coversUpToId });
        }
      } else if (entry.customType === OM_REFLECTIONS_RECORDED) {
        const batch = readReflectionBatch(entry.data, idAliases, observationIds);
        if (!batch) continue;
        if (cursorIds.has(batch.coversUpToId)) reflectorCursor = batch.coversUpToId;
        for (const item of batch.reflections) {
          if (reflectionIds.has(item.id)) {
            const existing = reflections.find((reflection) => reflection.id === item.id)!;
            existing.supportingObservationIds = [...new Set([...existing.supportingObservationIds, ...item.supportingObservationIds])];
            continue;
          }
          reflectionIds.add(item.id);
          reflections.push({ ...item, seq: reflections.length });
        }
      } else if (entry.customType === OM_OBSERVATIONS_DROPPED) {
        const batch = readDropBatch(entry.data, idAliases);
        if (!batch) continue;
        if (cursorIds.has(batch.coversUpToId)) dropperCursor = batch.coversUpToId;
        batch.observationIds.forEach((id) => droppedIds.add(id));
      }
    }
  };

  const modelRefs = (stage: Stage): OmModelRef[] => {
    const primary = stage === "observer" ? config.observerModel : stage === "reflector" ? config.reflectorModel : config.dropperModel;
    const fallbacks = stage === "observer" ? config.observerFallbackModels : stage === "reflector" ? config.reflectorFallbackModels : config.dropperFallbackModels;
    const refs = [primary, ...fallbacks, config.model].filter((item): item is OmModelRef => item !== null);
    const seen = new Set<string>();
    return refs.filter((item) => {
      const key = `${item.provider}/${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const modelsFor = (stage: Stage, ctx: ExtensionContext): Model<Api>[] => {
    const models = modelRefs(stage).flatMap((ref) => {
      const model = ctx.modelRegistry.find(ref.provider, ref.id);
      return model ? [model] : [];
    });
    const sessionModel = ctx.model;
    if (config.sessionFallback && sessionModel && !models.some((model) => model.provider === sessionModel.provider && model.id === sessionModel.id)) {
      models.push(sessionModel);
    }
    return models;
  };

  const runWithFallback = async <T>(
    stage: Stage,
    ctx: ExtensionContext,
    run: (model: Model<Api>) => Promise<T>,
  ): Promise<T> => {
    const models = modelsFor(stage, ctx);
    if (models.length === 0) throw new Error(`${stage}: no model configured or found`);
    let error: unknown;
    for (const model of models) {
      try { return await run(model); }
      catch (candidateError) {
        if (candidateError instanceof DOMException && candidateError.name === "AbortError") throw candidateError;
        error = candidateError;
      }
    }
    throw error ?? new Error(`${stage}: all model candidates failed`);
  };

  const cursorIndex = (transcript: ReturnType<typeof buildTranscript>, cursor: string | undefined): number =>
    cursor ? transcript.findIndex((entry) => entry.id === cursor) : -1;
  const tokensAfter = (transcript: ReturnType<typeof buildTranscript>, cursor: string | undefined): number => {
    const index = cursorIndex(transcript, cursor);
    return transcript.slice(index >= 0 ? index + 1 : 0).reduce((sum, entry) => sum + estimateTokens(entry.text), 0);
  };
  // Shared by consolidate and metrics so gauges mirror the real triggers.
  const reflectorGate = (transcript: ReturnType<typeof buildTranscript>) => {
    const active = activeObservations();
    const coverage = reflectionCoverageMap(active, reflections);
    const candidates = active.filter((observation) => coverage.get(observation.id) === "none");
    const blocked = !observerCursor ? "no observations yet" : candidates.length === 0 ? "no unreflected observations" : undefined;
    const gauge: OmGauge = { current: tokensAfter(transcript, reflectorCursor), limit: config.reflectAfterTokens, blocked };
    return { active, candidates, gauge, due: !blocked && gauge.current >= gauge.limit };
  };
  const dropperGate = (transcript: ReturnType<typeof buildTranscript>) => {
    const candidates = activeObservations();
    const poolTokens = candidates.reduce((sum, observation) => sum + observation.tokenCount, 0);
    const pressureDue = poolTokens >= config.dropperPressureThreshold * config.reflectorInputMaxTokens && dropperCursor !== observerCursor;
    const blocked = candidates.length === 0
      ? "no active observations"
      : poolTokens / config.observationsPoolMaxTokens < config.dropperPoolFullnessThreshold
        ? `pool < ${Math.round(config.dropperPoolFullnessThreshold * 100)}% full`
        : undefined;
    const gauge: OmGauge = { current: tokensAfter(transcript, dropperCursor), limit: config.reflectAfterTokens, blocked };
    return { candidates, poolTokens, gauge, due: !blocked && (gauge.current >= gauge.limit || pressureDue) };
  };

  const appendObservationBatch = (batch: ObservationBatch) => {
    const existing = new Set(observations.map((observation) => observation.id));
    const accepted = batch.observations.filter((observation) => !existing.has(observation.id));
    accepted.forEach((observation) => {
      existing.add(observation.id);
      observations.push({ ...observation, seq: observations.length, coversUpToId: batch.coversUpToId });
    });
    observerCursor = batch.coversUpToId;
    pi.appendEntry(OM_OBSERVATIONS_RECORDED, { ...batch, observations: accepted });
  };

  const appendReflectionBatch = (batch: ReflectionBatch) => {
    const recorded: ReflectionBatch["reflections"] = [];
    for (const reflection of batch.reflections) {
      const existing = reflections.find((item) => item.id === reflection.id);
      if (!existing) {
        reflections.push({ ...reflection, seq: reflections.length });
        recorded.push(reflection);
        continue;
      }
      const newSupportingIds = reflection.supportingObservationIds.filter((id) => !existing.supportingObservationIds.includes(id));
      if (newSupportingIds.length === 0) continue;
      existing.supportingObservationIds.push(...newSupportingIds);
      recorded.push({ ...reflection, supportingObservationIds: newSupportingIds });
    }
    reflectorCursor = batch.coversUpToId;
    pi.appendEntry(OM_REFLECTIONS_RECORDED, { ...batch, reflections: recorded });
  };

  const appendDropBatch = (batch: DropBatch) => {
    batch.observationIds.forEach((id) => droppedIds.add(id));
    dropperCursor = batch.coversUpToId;
    pi.appendEntry(OM_OBSERVATIONS_DROPPED, batch);
  };

  const consolidate = async (ctx: ExtensionContext) => {
    if (activeRun || Date.now() < retryAfter) return;
    const run = { id: Symbol("om-consolidation"), controller: new AbortController() };
    activeRun = run;
    const startedGeneration = generation;
    // Coverage must still be on the branch: the leaf can move before session_tree bumps generation.
    const current = (coverage: string) => startedGeneration === generation && activeRun?.id === run.id
      && ctx.sessionManager.getBranch().some((entry) => entry.id === coverage);
    try {
      let transcript = buildTranscript(ctx.sessionManager.getBranch() as readonly SessionEntryLike[]);
      const chunk = selectChunk(transcript, observerCursor, config.chunkMaxTokens);
      if (chunk && chunk.pendingTokens >= config.observeAfterTokens) {
        lastStage = "observer";
        const existingMemory = [
          ...projectReflections(reflections, EXISTING_MEMORY_TOKENS).map((item) => item.content),
          ...projectObservations(activeObservations(), EXISTING_MEMORY_TOKENS).map((item) => item.content),
        ];
        const result = await runWithFallback("observer", ctx, (model) =>
          runObserver(ctx.modelRegistry, model, config, { chunk: chunk.entries, existingMemory }, run.controller.signal));
        if (!current(chunk.throughEntryId)) return;
        appendObservationBatch({ coversUpToId: chunk.throughEntryId, observations: result.observations });
      }

      transcript = buildTranscript(ctx.sessionManager.getBranch() as readonly SessionEntryLike[]);
      const latestObserverCoverage = observerCursor;
      const reflector = reflectorGate(transcript);
      if (latestObserverCoverage && reflector.due) {
        lastStage = "reflector";
        const produced = await runWithFallback("reflector", ctx, (model) => runReflector(ctx.modelRegistry, model, config, {
          observations: reflector.candidates,
          activeObservations: reflector.active,
          reflections,
        }, run.controller.signal));
        if (!current(latestObserverCoverage)) return;
        appendReflectionBatch({ coversUpToId: latestObserverCoverage, reflections: produced });
      }

      const dropper = dropperGate(transcript);
      if (observerCursor && dropper.due) {
        lastStage = "dropper";
        const ids = await runWithFallback("dropper", ctx, (model) => runDropper(ctx.modelRegistry, model, config, {
          candidates: dropper.candidates,
          activeObservations: dropper.candidates,
          reflections,
        }, run.controller.signal));
        if (!current(observerCursor)) return;
        appendDropBatch({ coversUpToId: observerCursor, observationIds: ids });
      }
      lastError = undefined;
      retryAfter = 0;
    } catch (error) {
      if (startedGeneration === generation && !(error instanceof DOMException && error.name === "AbortError")) {
        lastError = `${lastStage ?? "pipeline"}: ${error instanceof Error ? error.message : String(error)}`;
        retryAfter = Date.now() + 30_000;
      }
    } finally {
      if (activeRun?.id === run.id) activeRun = undefined;
    }
  };

  pi.on("session_start", (_event, ctx) => {
    generation++;
    cancel();
    lastError = lastStage = undefined;
    retryAfter = 0;
    config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    restore(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    generation++;
    cancel();
    lastError = lastStage = undefined;
    retryAfter = 0;
    restore(ctx);
  });
  pi.on("session_shutdown", () => { generation++; cancel(); });
  pi.on("agent_start", (_event, ctx) => { void consolidate(ctx); });
  pi.on("turn_end", (_event, ctx) => { void consolidate(ctx); });

  return {
    getConfig: () => config,
    reload: (ctx) => {
      generation++;
      cancel();
      lastError = lastStage = undefined;
      config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
      retryAfter = 0;
      return config;
    },
    metrics: (ctx) => {
      const transcript = buildTranscript(ctx.sessionManager.getBranch() as readonly SessionEntryLike[]);
      const dropper = dropperGate(transcript);
      const poolTokens = dropper.poolTokens;
      return {
        activeObservations: dropper.candidates.length,
        totalObservations: observations.length,
        reflections: reflections.length,
        tombstones: droppedIds.size,
        observer: { current: tokensAfter(transcript, observerCursor), limit: config.observeAfterTokens },
        reflector: reflectorGate(transcript).gauge,
        dropper: dropper.gauge,
        observationPool: {
          current: poolTokens,
          limit: config.observationsPoolMaxTokens,
        },
        dropperPressure: {
          current: poolTokens,
          limit: Math.round(config.dropperPressureThreshold * config.reflectorInputMaxTokens),
        },
        activeStage: activeRun ? lastStage ?? "starting" : undefined,
        lastError,
      };
    },
    recall: (query, ctx) => {
      const match = /^\[?([a-f0-9]{12})\]?$/i.exec(query);
      if (!match) return undefined;
      const requestedId = match[1].toLowerCase();
      const id = idAliases.get(requestedId) ?? requestedId;
      const reflection = reflections.find((item) => item.id === id);
      const directObservation = observations.find((item) => item.id === id);
      if (!reflection && !directObservation) {
        return `No observation or reflection with id ${requestedId} was found on the current branch.`;
      }
      const related = directObservation
        ? [directObservation]
        : observations.filter((item) => reflection!.supportingObservationIds.includes(item.id));
      const sourceIds = new Set(related.flatMap((item) => item.sourceEntryIds));
      const rendered: string[] = [];
      let messageIndex = 0;
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "branch_summary") {
          if (sourceIds.has(entry.id)) rendered.push(`[branch_summary]\n${entry.summary.slice(0, 4_000)}`);
          continue;
        }
        if (entry.type !== "message" || !entry.message) continue;
        if (sourceIds.has(entry.id)) {
          const message = entry.message as Message;
          const view = renderMessage(message, messageIndex, true);
          rendered.push(`#${view.index} [${view.role}]\n${view.summary.slice(0, 4_000)}`);
        }
        messageIndex++;
      }
      const memory = reflection
        ? `Reflection [${reflection.id}]: ${reflection.content}`
        : `Observation [${directObservation!.id}]: ${directObservation!.content}`;
      const evidence = related.map((item) =>
        `[${item.id}]${droppedIds.has(item.id) ? " [dropped]" : ""} ${item.timestamp} [${item.relevance}] ${item.content}`,
      ).join("\n");
      return `${memory}\n\nSupporting observations:\n${evidence}\n\nSource entries:\n${rendered.join("\n\n") || "(source entries are not on the active branch)"}`;
    },
    augmentRecall: (output, entryIds) => {
      if (entryIds.length === 0) return output;
      const sourceIds = new Set(entryIds);
      const relatedObservations = observations.filter((observation) =>
        observation.sourceEntryIds.some((id) => sourceIds.has(id)),
      );
      if (relatedObservations.length === 0) return output;
      const relatedIds = new Set(relatedObservations.map((observation) => observation.id));
      const relatedReflections = reflections.filter((reflection) =>
        reflection.supportingObservationIds.some((id) => relatedIds.has(id)),
      );
      const lines = [
        ...relatedReflections.map((reflection) => `[${reflection.id}] [reflection] ${reflection.content}`),
        ...relatedObservations.map((observation) =>
          `[${observation.id}]${droppedIds.has(observation.id) ? " [dropped]" : ""} ${observation.timestamp} [${observation.relevance}] ${observation.content}`,
        ),
      ];
      return `${output}\n\nRelated observational memory:\n${lines.join("\n")}`;
    },
    enrichSummary: (summary) => {
      const stripped = stripMemoryBlock(summary);
      const block = renderMemoryBlock(
        projectObservations(activeObservations(), config.observationsPoolMaxTokens),
        projectReflections(reflections, config.reflectionsPoolMaxTokens),
      );
      return block ? `${stripped}\n\n${block}` : stripped;
    },
  };
};
