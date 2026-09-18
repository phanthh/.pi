import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COMPACT_MARKER, registerCompact, triggerInvisibleContinue } from "./compact/index.ts";
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
  });
  registerNewTopic(pi, { compactMarker: COMPACT_MARKER, triggerInvisibleContinue });
  registerContextView(pi, om);
};
