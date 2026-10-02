import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompact } from "./compact/index.ts";
import { registerOverrideFooter } from "./compact/footer.ts";
import { registerCompactionMax } from "./compact/max-tokens.ts";
import { registerIdleCompact } from "./idle-compact.ts";
import { registerContextView } from "./view/index.ts";
import { registerOm } from "./om.ts";
import { registerLiveContext } from "./live/index.ts";

/**
 * Monolithic context extension: deterministic compaction, recall,
 * context visualization, observational memory, and idle-aware compaction.
 */
export default (pi: ExtensionAPI) => {
  const om = registerOm(pi);
  const live = registerLiveContext(pi);
  const liveEnabled = (ctx: Parameters<typeof live.status>[0]) => live.status(ctx).enabled;
  registerCompact(pi, {
    enrichCompaction: ({ summary }) => ({ summary: om.enrichSummary(summary) }),
    resolveRecall: (query, ctx) => om.recall(query, ctx),
    augmentRecall: (output, entryIds, ctx) => om.augmentRecall(output, entryIds, ctx),
    liveEnabled,
  });
  registerIdleCompact(pi, { liveEnabled });
  registerCompactionMax(pi);
  registerOverrideFooter(pi);
  registerContextView(pi, om, live);
};
