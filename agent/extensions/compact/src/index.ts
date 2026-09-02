import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBeforeCompactHook } from "./hooks/before-compact";
import { registerRecallCommand } from "./commands/recall";
import { registerRecallTool } from "./tools/recall";

export default (pi: ExtensionAPI) => {
  registerBeforeCompactHook(pi);
  registerRecallCommand(pi);
  registerRecallTool(pi);
};
