import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBeforeCompactHook, type CompactRegistrationOptions } from "./hooks/before-compact.ts";
import { registerRecallCommand } from "./commands/recall.ts";
import { registerRecallTool } from "./tools/recall.ts";

export type { CompactRegistrationOptions, CompactionEnrichment } from "./hooks/before-compact.ts";
export { COMPACT_MARKER, triggerInvisibleContinue } from "./hooks/before-compact.ts";
export { renderMessage, type RenderedEntry } from "./core/render-entries.ts";

/**
 * Library entry: this package is not a pi extension on its own. The host
 * context extension calls this once, optionally passing hooks.
 */
export const registerCompact = (pi: ExtensionAPI, options: CompactRegistrationOptions = {}) => {
  registerBeforeCompactHook(pi, options);
  registerRecallCommand(pi, options.resolveRecall, options.augmentRecall);
  registerRecallTool(pi, options.resolveRecall, options.augmentRecall);
};
