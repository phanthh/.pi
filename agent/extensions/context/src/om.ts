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

export interface OmRuntime {
  getConfig: () => OmConfig;
  reload: (ctx: { cwd: string; isProjectTrusted: () => boolean }) => OmConfig;
  status: (ctx: ExtensionContext) => string;
  recall: (query: string, ctx: ExtensionContext) => string | undefined;
  enrichSummary: (summary: string) => string;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
const relevance = (value: unknown): Observation["relevance"] =>
  value === "low" || value === "high" || value === "critical" ? value : "medium";

const readObservationBatch = (value: unknown): ObservationBatch | null => {
  const data = record(value);
  const coversUpToId = data?.coversUpToId ?? data?.throughEntryId;
  if (typeof coversUpToId !== "string" || !Array.isArray(data?.observations)) return null;
  const observations: ObservationBatch["observations"] = [];
  for (const raw of data.observations) {
    const item = record(raw);
    if (!item || typeof item.content !== "string" || !item.content.trim()) continue;
    const sourceEntryIds = strings(item.sourceEntryIds ?? item.sourceIds);
    if (!sourceEntryIds?.length) continue;
    const content = stripSourceLabels(item.content);
    if (!content) continue;
    observations.push({
      id: typeof item.id === "string" && /^[a-f0-9]{12}$/i.test(item.id) ? item.id : hashId(content),
      content,
      timestamp: typeof item.timestamp === "string" ? item.timestamp : new Date(0).toISOString(),
      relevance: relevance(item.relevance),
      sourceEntryIds,
      tokenCount: typeof item.tokenCount === "number" && item.tokenCount >= 0 ? item.tokenCount : estimateTokens(content),
    });
  }
  return { coversUpToId, observations };
};

const readReflectionBatch = (value: unknown): ReflectionBatch | null => {
  const data = record(value);
  if (typeof data?.coversUpToId !== "string" || !Array.isArray(data.reflections)) return null;
  const reflections: ReflectionBatch["reflections"] = [];
  for (const raw of data.reflections) {
    const item = record(raw);
    if (!item || typeof item.content !== "string" || !item.content.trim() || /[\r\n]/.test(item.content)) continue;
    const supportingObservationIds = strings(item.supportingObservationIds);
    if (!supportingObservationIds?.length) continue;
    const content = item.content.trim();
    reflections.push({
      id: typeof item.id === "string" && /^[a-f0-9]{12}$/i.test(item.id) ? item.id : hashId(content),
      content,
      supportingObservationIds,
      tokenCount: typeof item.tokenCount === "number" && item.tokenCount >= 0 ? item.tokenCount : estimateTokens(content),
    });
  }
  return { coversUpToId: data.coversUpToId, reflections };
};

const readDropBatch = (value: unknown): DropBatch | null => {
  const data = record(value);
  const observationIds = strings(data?.observationIds);
  return typeof data?.coversUpToId === "string" && observationIds
    ? { coversUpToId: data.coversUpToId, observationIds }
    : null;
};

export const registerOm = (pi: ExtensionAPI): OmRuntime => {
  let config = DEFAULT_CONFIG;
  let observations: Observation[] = [];
  let reflections: Reflection[] = [];
  let droppedIds = new Set<string>();
  let observerCursor: string | undefined;
  /** Progress cursors advance on empty success; coverage cursors only on ledger records. */
  let reflectorCursor: string | undefined;
  let reflectorCoverageCursor: string | undefined;
  let dropperCursor: string | undefined;
  let dropperCoverageCursor: string | undefined;
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
    observerCursor = reflectorCursor = reflectorCoverageCursor = undefined;
    dropperCursor = dropperCoverageCursor = undefined;
    const observationIds = new Set<string>();
    const reflectionIds = new Set<string>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === OM_OBSERVATIONS_RECORDED || entry.customType === LEGACY_OBSERVATIONS_RECORDED) {
        const batch = readObservationBatch(entry.data);
        if (!batch) continue;
        observerCursor = batch.coversUpToId;
        for (const item of batch.observations) {
          if (observationIds.has(item.id)) continue;
          observationIds.add(item.id);
          observations.push({ ...item, seq: observations.length, coversUpToId: batch.coversUpToId });
        }
      } else if (entry.customType === OM_REFLECTIONS_RECORDED) {
        const batch = readReflectionBatch(entry.data);
        if (!batch) continue;
        reflectorCursor = reflectorCoverageCursor = batch.coversUpToId;
        for (const item of batch.reflections) {
          if (reflectionIds.has(item.id)) continue;
          reflectionIds.add(item.id);
          reflections.push({ ...item, seq: reflections.length });
        }
      } else if (entry.customType === OM_OBSERVATIONS_DROPPED) {
        const batch = readDropBatch(entry.data);
        if (!batch) continue;
        dropperCursor = dropperCoverageCursor = batch.coversUpToId;
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
  const observationsAfter = (transcript: ReturnType<typeof buildTranscript>, cursor: string | undefined): Observation[] => {
    const boundary = cursorIndex(transcript, cursor);
    const indexes = new Map(transcript.map((entry, index) => [entry.id, index]));
    return activeObservations().filter((observation) => (indexes.get(observation.coversUpToId) ?? Number.POSITIVE_INFINITY) > boundary);
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
    const existing = new Set(reflections.map((reflection) => reflection.id));
    const accepted = batch.reflections.filter((reflection) => !existing.has(reflection.id));
    accepted.forEach((reflection) => {
      existing.add(reflection.id);
      reflections.push({ ...reflection, seq: reflections.length });
    });
    reflectorCursor = reflectorCoverageCursor = batch.coversUpToId;
    pi.appendEntry(OM_REFLECTIONS_RECORDED, { ...batch, reflections: accepted });
  };

  const appendDropBatch = (batch: DropBatch) => {
    batch.observationIds.forEach((id) => droppedIds.add(id));
    dropperCursor = dropperCoverageCursor = batch.coversUpToId;
    pi.appendEntry(OM_OBSERVATIONS_DROPPED, batch);
  };

  const consolidate = async (ctx: ExtensionContext) => {
    if (!config.enabled || activeRun || Date.now() < retryAfter) return;
    const run = { id: Symbol("om-consolidation"), controller: new AbortController() };
    activeRun = run;
    const startedGeneration = generation;
    const current = () => startedGeneration === generation && activeRun?.id === run.id;
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
        if (!current()) return;
        appendObservationBatch({ coversUpToId: chunk.throughEntryId, observations: result.observations });
      }

      transcript = buildTranscript(ctx.sessionManager.getBranch() as readonly SessionEntryLike[]);
      const latestObserverCoverage = observerCursor;
      const newForReflection = observationsAfter(transcript, reflectorCoverageCursor);
      if (latestObserverCoverage && newForReflection.length > 0 && tokensAfter(transcript, reflectorCursor) >= config.reflectAfterTokens) {
        lastStage = "reflector";
        const produced = await runWithFallback("reflector", ctx, (model) => runReflector(ctx.modelRegistry, model, config, {
          observations: newForReflection,
          activeObservations: activeObservations(),
          reflections,
        }, run.controller.signal));
        if (!current()) return;
        if (produced.length > 0) appendReflectionBatch({ coversUpToId: latestObserverCoverage, reflections: produced });
        else reflectorCursor = latestObserverCoverage;
      }

      const poolTokens = activeObservations().reduce((sum, observation) => sum + observation.tokenCount, 0);
      const fullness = poolTokens / config.observationsPoolMaxTokens;
      const pressure = poolTokens >= config.dropperPressureThreshold * config.reflectorInputMaxTokens;
      const candidates = observationsAfter(transcript, dropperCoverageCursor);
      const dropProgressDue = tokensAfter(transcript, dropperCursor) >= config.reflectAfterTokens;
      if (observerCursor && candidates.length > 0 && fullness >= config.dropperPoolFullnessThreshold && (dropProgressDue || pressure)) {
        lastStage = "dropper";
        const ids = await runWithFallback("dropper", ctx, (model) => runDropper(ctx.modelRegistry, model, config, {
          candidates,
          activeObservations: activeObservations(),
          reflections,
        }, run.controller.signal));
        if (!current()) return;
        if (ids.length > 0) appendDropBatch({ coversUpToId: observerCursor, observationIds: ids });
        else dropperCursor = observerCursor;
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
  pi.on("session_shutdown", () => { generation++; cancel(); });
  pi.on("agent_start", (_event, ctx) => { void consolidate(ctx); });
  pi.on("turn_end", (_event, ctx) => { void consolidate(ctx); });

  return {
    getConfig: () => config,
    reload: (ctx) => {
      config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
      retryAfter = 0;
      if (!config.enabled) { generation++; cancel(); }
      return config;
    },
    status: (ctx) => {
      const transcript = buildTranscript(ctx.sessionManager.getBranch() as readonly SessionEntryLike[]);
      const active = activeObservations();
      const poolTokens = active.reduce((sum, observation) => sum + observation.tokenCount, 0);
      return [
        `pipeline: ${config.enabled ? "on" : "off"}${activeRun ? ` (${lastStage ?? "starting"} running)` : ""}`,
        `ledger: ${active.length}/${observations.length} active observations, ${reflections.length} reflections, ${droppedIds.size} tombstones`,
        `observer pending: ~${tokensAfter(transcript, observerCursor)} / ${config.observeAfterTokens} tokens`,
        `reflector pending: ~${tokensAfter(transcript, reflectorCursor)} / ${config.reflectAfterTokens} tokens`,
        `dropper pool: ~${poolTokens} / ${config.observationsPoolMaxTokens} tokens`,
        lastError ? `last error: ${lastError}` : "last error: none",
      ].join("\n");
    },
    recall: (query, ctx) => {
      const match = /^\[?([a-f0-9]{12})\]?$/i.exec(query);
      if (!match) return undefined;
      const id = match[1].toLowerCase();
      const reflection = reflections.find((item) => item.id === id);
      const directObservation = observations.find((item) => item.id === id);
      if (!reflection && !directObservation) return undefined;
      const related = directObservation
        ? [directObservation]
        : observations.filter((item) => reflection!.supportingObservationIds.includes(item.id));
      const sourceIds = new Set(related.flatMap((item) => item.sourceEntryIds));
      const rendered: string[] = [];
      let messageIndex = 0;
      for (const entry of ctx.sessionManager.getBranch()) {
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
      const evidence = related.map((item) => `[${item.id}] ${item.timestamp} [${item.relevance}] ${item.content}`).join("\n");
      return `${memory}\n\nSupporting observations:\n${evidence}\n\nSource entries:\n${rendered.join("\n\n") || "(source entries are not on the active branch)"}`;
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
