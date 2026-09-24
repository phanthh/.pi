/**
 * Idle-aware compaction: a user message arriving after the provider prompt
 * cache has expired pays a full cache miss anyway, so compact first and send
 * the message on top of the smaller context.
 *
 * Runs inside the `input` hook, which pi awaits before appending the message,
 * so compaction completes before the prompt is built. Any failure (too little
 * context, user abort) lets the message through unchanged.
 */
import { estimateTokens, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildOwnCut, COMPACT_MARKER, formatCompactionStats, getLastCompactionStats } from "./compact/hooks/before-compact.ts";

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
export const hasEnoughToCompact = (branch: readonly BranchEntry[], keepRecentTokens: number): boolean => {
  if (branch.at(-1)?.type === "compaction") return false;
  const live = buildOwnCut(branch as any[], 0);
  if (!live.ok) return false;
  const tokens = live.messages.reduce(
    (sum: number, message: any) => (message.role === "system" ? sum : sum + estimateTokens(message)),
    0,
  );
  return tokens > keepRecentTokens;
};

const keepRecentTokens = (ctx: ExtensionContext): number =>
  SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() }).getCompactionKeepRecentTokens(ctx.model);

export const registerIdleCompact = (
  pi: ExtensionAPI,
  { now = Date.now, keepTokens = keepRecentTokens }: { now?: () => number; keepTokens?: (ctx: ExtensionContext) => number } = {},
) => {
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !ctx.isIdle()) return;
    const branch = ctx.sessionManager.getBranch() as unknown as BranchEntry[];
    const last = lastCacheTouchMs(branch);
    if (last === undefined) return;
    const idleMs = now() - last;
    if (idleMs < IDLE_COMPACT_AFTER_MS) return;
    if (!hasEnoughToCompact(branch, keepTokens(ctx))) return;

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
