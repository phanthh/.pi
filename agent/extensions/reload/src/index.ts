import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { installToolContextReloadPatch } from "./runtime-reload.ts";

const CONTINUE_AFTER_RELOAD_SLOT = "__piContinueAfterRuntimeReload";
type ReloadState = typeof globalThis & { [CONTINUE_AFTER_RELOAD_SLOT]?: boolean };

export function isInsidePiConfig(cwd: string, home = homedir()): boolean {
	const path = relative(resolve(home, ".pi"), resolve(cwd));
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export default async function reloadExtension(pi: ExtensionAPI): Promise<void> {
	if (!isInsidePiConfig(process.cwd())) return;
	if (!(await installToolContextReloadPatch())) return;

	pi.on("session_start", async (event) => {
		const state = globalThis as ReloadState;
		if (event.reason !== "reload" || !state[CONTINUE_AFTER_RELOAD_SLOT]) return;
		delete state[CONTINUE_AFTER_RELOAD_SLOT];
		setTimeout(() => {
			pi.sendMessage(
				{
					customType: "reload-continuation",
					content: "Pi runtime reloaded. Continue the task immediately from where you left off.",
					display: false,
				},
				{ triggerTurn: true },
			);
		}, 0);
	});

	pi.registerTool({
		name: "reload_pi",
		label: "Reload Pi",
		description:
			"Reload Pi extensions, skills, prompts, themes, and context files as soon as the current response finishes. Available only inside ~/.pi. Reload resets extension in-memory state.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, context) {
			const runtime = context as typeof context & { reload(): Promise<void> };
			const state = globalThis as ReloadState;
			state[CONTINUE_AFTER_RELOAD_SLOT] = true;
			const reload = () => {
				if (!runtime.isIdle()) {
					setTimeout(reload, 50);
					return;
				}
				void runtime.reload().catch(() => {
					delete state[CONTINUE_AFTER_RELOAD_SLOT];
				});
			};
			setTimeout(reload, 0);
			return {
				content: [{ type: "text" as const, text: "Pi runtime reload scheduled." }],
				details: {},
			};
		},
	});
}
