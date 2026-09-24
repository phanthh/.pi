import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COMPACT_MARKER, registerCompact, triggerInvisibleContinue } from "./compact/index.ts";
import { registerOverrideFooter } from "./compact/footer.ts";
import { registerCompactionMax } from "./compact/max-tokens.ts";
import { registerIdleCompact } from "./idle-compact.ts";
import { registerNewTopic } from "./new-topic.ts";
import { registerContextView } from "./view/index.ts";
import { registerOm } from "./om.ts";

/**
 * Monolithic context extension: deterministic compaction, recall,
 * context visualization, observational memory, and topic cutovers.
 */
export default (pi: ExtensionAPI) => {
  const om = registerOm(pi);
  registerCompact(pi, {
    enrichCompaction: ({ summary }) => ({ summary: om.enrichSummary(summary) }),
    resolveRecall: (query, ctx) => om.recall(query, ctx),
    augmentRecall: (output, entryIds, ctx) => om.augmentRecall(output, entryIds, ctx),
  });
  registerNewTopic(pi, { compactMarker: COMPACT_MARKER, triggerInvisibleContinue });
  registerIdleCompact(pi);
  registerCompactionMax(pi);
  registerOverrideFooter(pi);
  registerContextView(pi, om);
};
