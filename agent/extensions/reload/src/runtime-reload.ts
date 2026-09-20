import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PATCH_SLOT = "__piReloadToolContextPatch";
type PatchState = typeof globalThis & { [PATCH_SLOT]?: boolean };

type Runner = {
	assertActive(): void;
	reloadHandler?: () => Promise<void>;
};
type RunnerPrototype = {
	createContext(this: Runner): { reload?: () => Promise<void> };
};

/** Adds command-context reload to tool contexts on Pi versions that omit it. */
export async function installToolContextReloadPatch(): Promise<boolean> {
	const state = globalThis as PatchState;
	if (state[PATCH_SLOT]) return true;
	try {
		const packageEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
		const runnerUrl = pathToFileURL(
			join(dirname(fileURLToPath(packageEntry)), "core/extensions/runner.js"),
		).href;
		const module = (await import(runnerUrl)) as { ExtensionRunner?: { prototype?: RunnerPrototype } };
		const prototype = module.ExtensionRunner?.prototype;
		if (!prototype || typeof prototype.createContext !== "function") return false;

		const createContext = prototype.createContext;
		prototype.createContext = function patchedCreateContext(this: Runner) {
			const context = createContext.call(this);
			context.reload ??= async () => {
				this.assertActive();
				if (!this.reloadHandler) throw new Error("Pi reload handler is unavailable");
				await this.reloadHandler();
			};
			return context;
		};
		state[PATCH_SLOT] = true;
		return true;
	} catch {
		return false;
	}
}
