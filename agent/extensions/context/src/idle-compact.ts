/**
 * Idle-aware compaction: a user message arriving after the provider prompt
 * cache has expired pays a full cache miss anyway, so compact first and send
 * the message on top of the smaller context.
 *
 * Runs inside the `input` hook, which pi awaits before appending the message,
 * so compaction completes before the prompt is built. Any failure (too little
 * context, user abort) lets the message through unchanged.
 */
import { estimateTokens, SettingsManager, type ExtensionAPI, type ExtensionContext, type SessionManager } from "@earendil-works/pi-coding-agent";
import { buildOwnCut, COMPACT_MARKER, formatCompactionStats, getLastCompactionStats, projectedCompactionEntries } from "./compact/hooks/before-compact.ts";

/** Default prompt-cache TTL for most providers (Anthropic ephemeral, OpenAI). */
export const IDLE_COMPACT_AFTER_MS = 5 * 60_000;

type BranchEntry = { type: string; timestamp: string; kind?: string; message?: { role?: string } };

/** Last time the provider cache was touched: assistant response or idle cache-warm refresh. */
export const lastCacheTouchMs = (entries: readonly BranchEntry[]): number | undefined => {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const touched = (entry.type === "message" && entry.message?.role === "assistant")
      || (entry.type === "usage" && entry.kind === "cache_warm");
    if (!touched) continue;
    const ms = Date.parse(entry.timestamp);
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
};

/**
 * Mirrors pi's own gate (prepareCompaction): nothing is summarized unless live
 * conversation exceeds keepRecentTokens, and pi reports that as a visible error.
 * System prompt entries count toward pi's kept tail but are never summarized.
 */
export const hasEnoughToCompact = (branch: readonly BranchEntry[], keepRecentTokens: number, useLiveCheckpoint = false): boolean => {
  if (branch.at(-1)?.type === "compaction") return false;
  const { entries } = projectedCompactionEntries(branch as ReturnType<SessionManager["getBranch"]>, useLiveCheckpoint);
  const live = buildOwnCut(entries, 0);
  if (!live.ok) return false;
  const tokens = live.messages.reduce(
    (sum: number, message: any) => (message.role === "system" ? sum : sum + estimateTokens(message)),
    0,
  );
  return tokens > keepRecentTokens;
};

const keepRecentTokens = (ctx: ExtensionContext): number =>
  SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() }).getCompactionKeepRecentTokens(ctx.model);

/** Env override for `compaction.idleCompact`; wins over settings.json. */
export const IDLE_COMPACT_ENV = "PI_IDLE_COMPACT";

const parseFlag = (value: string | undefined): boolean | undefined => {
  const v = value?.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return undefined;
};

const idleCompactSetting = (settings: unknown): boolean | undefined => {
  const compaction = (settings as { compaction?: unknown } | undefined)?.compaction;
  const value = compaction && typeof compaction === "object" ? (compaction as Record<string, unknown>).idleCompact : undefined;
  return typeof value === "boolean" ? value : undefined;
};

/** Env `PI_IDLE_COMPACT` → trusted project `compaction.idleCompact` → global → default off. */
export const idleCompactEnabled = (ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">, env = process.env): boolean => {
  const fromEnv = parseFlag(env[IDLE_COMPACT_ENV]);
  if (fromEnv !== undefined) return fromEnv;
  const projectTrusted = ctx.isProjectTrusted();
  const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted });
  return (projectTrusted ? idleCompactSetting(settings.getProjectSettings()) : undefined)
    ?? idleCompactSetting(settings.getGlobalSettings())
    ?? false;
};

export const registerIdleCompact = (
  pi: ExtensionAPI,
  { now = Date.now, keepTokens = keepRecentTokens, liveEnabled = () => false, enabled = idleCompactEnabled }: {
    now?: () => number;
    enabled?: (ctx: ExtensionContext) => boolean;
    keepTokens?: (ctx: ExtensionContext) => number;
    liveEnabled?: (ctx: ExtensionContext) => boolean;
  } = {},
) => {
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !ctx.isIdle()) return;
    const branch = ctx.sessionManager.getBranch() as unknown as BranchEntry[];
    const last = lastCacheTouchMs(branch);
    if (last === undefined) return;
    const idleMs = now() - last;
    if (idleMs < IDLE_COMPACT_AFTER_MS || !enabled(ctx)) return;
    try {
      if (!hasEnoughToCompact(branch, keepTokens(ctx), liveEnabled(ctx))) return;
    } catch (cause) {
      ctx.ui.notify(`context: idle compaction skipped; live projection unavailable: ${String(cause)}`, "warning");
      return;
    }

    const idle = `${Math.round(idleMs / 60_000)}m`;
    await new Promise<void>((resolve) => {
      ctx.compact({
        customInstructions: COMPACT_MARKER,
        onComplete: () => {
          const stats = getLastCompactionStats();
          ctx.ui.notify(`context: idle ${idle}, cache expired → ${stats ? formatCompactionStats(stats) : "compacted"}`, "info");
          resolve();
        },
        // Pi already surfaces compaction failures; the message proceeds either way.
        onError: () => resolve(),
      });
    });
  });
};
