import { randomUUID } from "node:crypto";
import {
  type CustomMessageEntryDraft,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBoundaryDraft,
  type SessionProjection,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.ts";
import { normalizeInlineText } from "../view/text.ts";
import { liveBudget, liveTokens, pressureLevel } from "./budget.ts";
import { LIVE_CONTEXT_SKILL_PATH, createLiveDocument, parseLiveEdits, type LiveDocument } from "./document.ts";
import { CHECKPOINT_TYPE, RESET_TYPE, createCheckpoint, latestCheckpoint, projectCheckpoint, revisionText } from "./projection.ts";
import { openMirror, type MirrorStorage } from "./storage.ts";

const SWITCH_TYPE = "context.live.enabled";
const RECEIPT_TYPE = "context.live.receipt";
const NUDGE_TYPE = "context.live.pressure";

export interface LiveContextStatus {
  enabled: boolean;
  available: boolean;
  path?: string;
  edits: number;
  lastResult?: string;
  error?: string;
}

export interface LiveContextRuntime {
  instructions(ctx: ExtensionContext): string | undefined;
  status(ctx: ExtensionContext): LiveContextStatus;
  reload(ctx: ExtensionContext): void;
  setEnabled(enabled: boolean, ctx: ExtensionContext): void;
  revisions(ctx: ExtensionContext): string;
}

function draftMessageTokens(drafts: SessionBoundaryDraft[]): number {
  return drafts.reduce((tokens, draft) => tokens + (draft.type === "custom_message"
    ? estimateTokens({ ...draft, role: "custom", timestamp: 0 }) : 0), 0);
}

export function registerLiveContext(pi: ExtensionAPI): LiveContextRuntime {
  let mode = "off";
  let storage: MirrorStorage | undefined;
  let sessionFile: string | undefined;
  let baseline: LiveDocument | undefined;
  let lastResult: string | undefined;
  let error: string | undefined;
  let nudged = 0;
  let failedSession: string | undefined;

  const report = (ctx: ExtensionContext, message: string) => {
    const safe = normalizeInlineText(`Live context: ${message}`);
    if (ctx.hasUI) ctx.ui.notify(safe, "warning");
    else process.stderr.write(`${safe}\n`);
  };

  const close = (ctx?: ExtensionContext) => {
    try { storage?.release(); }
    catch (reason) { if (ctx) report(ctx, String(reason)); }
    storage = undefined;
    sessionFile = undefined;
    baseline = undefined;
  };

  const enabled = (ctx: ExtensionContext) => {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "custom" && entry.customType === SWITCH_TYPE) {
        const data = entry.data as { enabled?: unknown } | undefined;
        if (typeof data?.enabled === "boolean") return data.enabled;
      }
    }
    return mode === "all" || (mode === "main" && !process.env.PI_SUBAGENT_ID && !(Number(process.env.PI_SUBAGENT_DEPTH) > 0));
  };

  const ensure = (ctx: ExtensionContext): MirrorStorage | undefined => {
    const file = ctx.sessionManager.getSessionFile();
    if (!enabled(ctx)) { close(ctx); return undefined; }
    if (!file) {
      error = "Unavailable in --no-session runs.";
      close(ctx);
      return undefined;
    }
    if (storage && sessionFile === file) return storage;
    if (failedSession === file) return undefined;
    close(ctx);
    try {
      storage = openMirror(file);
      sessionFile = file;
      error = undefined;
      return storage;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
      failedSession = file;
      report(ctx, error);
      return undefined;
    }
  };

  const discardPending = (ctx: ExtensionContext, reason: string) => {
    if (!storage || !baseline) return;
    try {
      const pending = storage.read();
      if (pending !== baseline.text) {
        const path = storage.reject(pending);
        lastResult = `${reason}; unapplied draft saved to ${path}.`;
        report(ctx, lastResult);
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      report(ctx, error);
    }
    baseline = undefined;
  };

  const exportContext = (ctx: ExtensionContext) => {
    const mirror = ensure(ctx);
    if (!mirror) return;
    // Only turn_end imports edits. A new request must never import an idle/human edit.
    discardPending(ctx, "Stale draft discarded before refresh");
    const raw = ctx.sessionManager.buildSessionProjection();
    const active = latestCheckpoint(ctx.sessionManager.getBranch(), raw);
    const projection = projectCheckpoint(raw, active);
    const document = createLiveDocument(projection, {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId(),
      revision: randomUUID(),
    });
    mirror.write(document.text);
    baseline = document;
  };

  const safelyExport = (ctx: ExtensionContext) => {
    try { exportContext(ctx); }
    catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
      report(ctx, error);
      close(ctx);
      failedSession = ctx.sessionManager.getSessionFile();
    }
  };

  const receipt = (text: string, details?: unknown): CustomMessageEntryDraft => ({
    type: "custom_message", customType: RECEIPT_TYPE, content: `[Live context: ${text}]`, display: true, details,
  });

  const runtime: LiveContextRuntime = {
    instructions: (ctx) => {
      const mirror = ensure(ctx);
      if (!mirror) return undefined;
      return `<live_context>
Your active conversation is mirrored to ${JSON.stringify(mirror.path)}.
Read ${JSON.stringify(LIVE_CONTEXT_SKILL_PATH)} before interacting with live context; follow that skill for inspection, editing, and compaction.
${lastResult ? `- Last status: ${lastResult}` : ""}
</live_context>`;
    },
    status: (ctx) => {
      const branch = ctx.sessionManager.getBranch();
      let edits = 0;
      let persistedResult: string | undefined;
      for (const entry of branch) {
        if (entry.type !== "custom_message" || entry.customType !== RECEIPT_TYPE) continue;
        const details = entry.details as { edits?: unknown; result?: unknown } | undefined;
        if (typeof details?.edits === "number") edits += details.edits;
        if (typeof details?.result === "string") persistedResult = details.result;
      }
      return { enabled: enabled(ctx), available: storage !== undefined, path: storage?.path, edits, lastResult: lastResult ?? persistedResult, error };
    },
    reload: (ctx) => {
      discardPending(ctx, "Configuration changed");
      close(ctx);
      mode = loadConfig(ctx.cwd, ctx.isProjectTrusted()).liveContext.mode;
      failedSession = undefined;
      error = undefined;
      nudged = 0;
      safelyExport(ctx);
    },
    setEnabled: (value, ctx) => {
      if (!ctx.isIdle()) throw new Error("Wait for the agent to become idle before toggling live context.");
      discardPending(ctx, "Live context toggled");
      pi.appendEntry(SWITCH_TYPE, { enabled: value });
      runtime.reload(ctx);
    },
    revisions: (ctx) => {
      const file = ctx.sessionManager.getSessionFile();
      if (!file) throw new Error("Live revisions require a saved session.");
      const mirror = ensure(ctx);
      if (!mirror) throw new Error("Enable live context to view branch revisions.");
      return mirror.writeRevisions(revisionText(ctx.sessionManager.getBranch()));
    },
  };

  pi.on("session_start", (_event, ctx) => { lastResult = undefined; runtime.reload(ctx); });
  pi.on("session_tree", (_event, ctx) => {
    discardPending(ctx, "Branch changed");
    lastResult = undefined;
    runtime.reload(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    discardPending(ctx, "Session ended");
    close(ctx);
    failedSession = undefined;
  });
  pi.on("session_compact", (_event, ctx) => {
    const last = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && (entry.customType === CHECKPOINT_TYPE || entry.customType === RESET_TYPE));
    if (last?.type === "custom" && last.customType === CHECKPOINT_TYPE) {
      pi.appendEntry(RESET_TYPE, { reason: "Native compaction superseded the live-context checkpoint." });
      lastResult = "Native compaction reset the live-context checkpoint; raw retained history is active.";
      report(ctx, lastResult);
    }
    baseline = undefined;
    safelyExport(ctx);
  });
  pi.on("session_before_compact", (event, ctx) => {
    if (event.reason !== "threshold" || !enabled(ctx)) return;
    const raw = ctx.sessionManager.buildSessionProjection();
    const checkpoint = latestCheckpoint(ctx.sessionManager.getBranch(), raw);
    if (!checkpoint) return;
    try {
      const projected = projectCheckpoint(raw, checkpoint);
      if (liveTokens(projected, ctx.getSystemPrompt()) <= liveBudget(ctx)) return { cancel: true };
      report(ctx, "Live context exceeded its budget; native compaction will reset the checkpoint.");
    } catch (cause) {
      report(ctx, `Live context checkpoint is stale; native compaction will proceed: ${String(cause)}`);
    }
  });
  pi.on("agent_settled", (_event, ctx) => safelyExport(ctx));
  pi.on("context", (event, ctx) => {
    if (!enabled(ctx)) return;
    const raw = ctx.sessionManager.buildSessionProjection();
    try {
      const checkpoint = latestCheckpoint(ctx.sessionManager.getBranch(), raw);
      const projected = projectCheckpoint(raw, checkpoint);
      safelyExport(ctx);
      return checkpoint ? { messages: projected.messages } : undefined;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
      report(ctx, error);
      return undefined;
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    const instructions = runtime.instructions(ctx);
    if (instructions !== undefined) return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
  });

  pi.on("turn_end", (event, ctx) => {
    if (!storage || !baseline || !enabled(ctx)) return;
    const raw: SessionProjection = { ...ctx.sessionManager.buildSessionProjection(), entries: event.context.contextEntries, messages: event.context.contextMessages };
    let current: SessionProjection;
    try { current = projectCheckpoint(raw, latestCheckpoint(ctx.sessionManager.getBranch(), raw)); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); report(ctx, error); return; }
    const drafts: SessionBoundaryDraft[] = [];
    let candidate = current;
    try {
      const text = storage.read();
      if (event.outcome !== "completed") {
        discardPending(ctx, "Incomplete turn; context was not edited");
        return;
      }
      if (baseline.sessionId !== ctx.sessionManager.getSessionId() ||
        (baseline.leafId !== null && !ctx.sessionManager.getBranch().some((entry) => entry.id === baseline!.leafId))) {
        throw new Error("Context baseline belongs to another session or branch.");
      }
      const model = event.message.role === "assistant"
        ? ctx.modelRegistry.find(event.message.provider, event.message.model) ?? ctx.model : ctx.model;
      const limit = liveBudget(ctx, model);
      if (text !== baseline.text) {
        const edit = parseLiveEdits(text, baseline, current);
        const preview: SessionProjection = { ...current, entries: edit.entries, messages: edit.messages };
        const before = liveTokens(current, ctx.getSystemPrompt());
        const after = liveTokens(preview, ctx.getSystemPrompt());
        const result = `applied ${edit.edits} edit(s), ~${before} → ${after} tokens`;
        const confirmation = receipt(result, { edits: edit.edits, result });
        const confirmationTokens = draftMessageTokens([confirmation]);
        if (edit.changed && after + confirmationTokens > limit) throw new Error(`Edited context is still over budget (~${after + confirmationTokens}/${limit} tokens); compact more.`);
        if (edit.changed) {
          candidate = preview;
          drafts.push({ type: "custom", customType: CHECKPOINT_TYPE, data: createCheckpoint(raw, preview, current) }, confirmation);
          lastResult = result;
          error = undefined;
        }
        baseline = undefined;
      }
      // Nudge from the candidate projection when an edit reduced the active history.
      const checkpoint = drafts.find((draft) => draft.type === "custom" && draft.customType === CHECKPOINT_TYPE);
      const tokens = liveTokens(candidate, ctx.getSystemPrompt()) + draftMessageTokens(drafts);
      const level = pressureLevel(tokens, limit, nudged);
      if (level > nudged) {
        const nudge: CustomMessageEntryDraft = { type: "custom_message", customType: NUDGE_TYPE,
          content: `[Live context pressure: ~${tokens}/${limit} input tokens. ${level === 2 ? "Compact stale history now" : "Consider batching a context reduction"} using ${storage.path}; read ${JSON.stringify(LIVE_CONTEXT_SKILL_PATH)} and follow its instructions.]`, display: true };
        // Optional reminders must not push an accepted edit past its validated budget.
        if (!checkpoint || tokens + draftMessageTokens([nudge]) <= limit) {
          drafts.push(nudge);
          nudged = level;
        }
      } else {
        nudged = level;
      }
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
      let saved = "";
      try { saved = ` Draft saved to ${storage.reject(storage.read())}.`; } catch { /* Preserve the original failure. */ }
      lastResult = `rejected: ${error}${saved}`;
      drafts.length = 0;
      drafts.push(receipt(lastResult, { edits: 0, result: lastResult }));
      report(ctx, lastResult);
      baseline = undefined;
    }
    return drafts.length ? { entries: [...event.entries, ...drafts] } : undefined;
  });

  return runtime;
}
