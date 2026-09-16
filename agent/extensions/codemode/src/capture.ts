/**
 * Pi gives extensions no public way to invoke another extension's tool, so the
 * guest surface for `extensions.*` is built by observing ExtensionRunner's tool
 * registry. The patch only snapshots; it never filters what Pi sees.
 * Ported (trimmed) from pi-fabric src/capture/interceptor.ts.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionRunner, RegisteredTool } from "@earendil-works/pi-coding-agent";

type RunnerConstructor = { prototype: ExtensionRunner };

const HUB = Symbol.for("pi-codemode.tool-capture.v1");

/** Tools registered by other extensions, refreshed on every Pi tool refresh. */
export interface CapturedTools {
	list(): RegisteredTool[];
	get(name: string): RegisteredTool | undefined;
}

const isRunnerConstructor = (value: unknown): value is RunnerConstructor =>
	typeof value === "function" &&
	typeof (value as { prototype?: Record<string, unknown> }).prototype === "object" &&
	typeof (value as { prototype: Record<string, unknown> }).prototype.getAllRegisteredTools ===
		"function";

/** Pi >= 0.84.3 runs a rollup bundle whose chunks hold their own class identity. */
const bundleRunnerConstructors = async (bundleDir: string): Promise<RunnerConstructor[]> => {
	const chunksDir = path.join(bundleDir, "chunks");
	if (!existsSync(chunksDir)) return [];
	let files: string[];
	try {
		files = readdirSync(chunksDir);
	} catch {
		return [];
	}
	const found = new Set<RunnerConstructor>();
	for (const file of files) {
		if (!file.endsWith(".js")) continue;
		// Importing a chunk runs its top-level side effects in this realm, so only
		// open the one that can actually hold the class.
		try {
			const chunkPath = path.join(chunksDir, file);
			if (!readFileSync(chunkPath, "utf8").includes("getAllRegisteredTools")) continue;
			const module = (await import(pathToFileURL(chunkPath).href)) as Record<string, unknown>;
			for (const exported of Object.values(module)) {
				if (isRunnerConstructor(exported)) found.add(exported);
			}
		} catch {
			// Worker entries and native chunks are not importable here; skip.
		}
	}
	return [...found];
};

const hostPackageRoot = (): string | undefined => {
	const cliPath = process.argv[1];
	if (!cliPath) return undefined;
	let directory: string;
	try {
		directory = path.dirname(realpathSync(cliPath));
	} catch {
		return undefined;
	}
	while (directory !== path.dirname(directory)) {
		const manifestPath = path.join(directory, "package.json");
		if (existsSync(manifestPath)) {
			try {
				const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
				if (manifest.name === "@earendil-works/pi-coding-agent") return directory;
			} catch {
				// Unreadable manifest; keep walking up.
			}
		}
		directory = path.dirname(directory);
	}
	return undefined;
};

const runnerConstructors = async (): Promise<RunnerConstructor[]> => {
	const found = new Set<RunnerConstructor>();
	const roots = new Set(
		[process.env.PI_PACKAGE_DIR, hostPackageRoot()].filter(
			(root): root is string => typeof root === "string" && root.length > 0,
		),
	);
	for (const root of roots) {
		try {
			const module = (await import(
				pathToFileURL(path.join(root, "dist", "index.js")).href
			)) as { ExtensionRunner?: RunnerConstructor };
			if (module.ExtensionRunner) found.add(module.ExtensionRunner);
		} catch {
			// Host entry not importable in this realm; the bundle scan may still work.
		}
		for (const Runner of await bundleRunnerConstructors(path.join(root, "dist", "bundle"))) {
			found.add(Runner);
		}
	}
	if (found.size === 0) {
		try {
			const module = (await import("@earendil-works/pi-coding-agent")) as {
				ExtensionRunner?: RunnerConstructor;
			};
			if (module.ExtensionRunner) found.add(module.ExtensionRunner);
		} catch {
			// No host in this realm: capture stays inert, core pi.* still works.
		}
	}
	return [...found];
};

type Listener = (tools: RegisteredTool[]) => void;

const hubFor = (Runner: RunnerConstructor): Set<Listener> => {
	const prototype = Runner.prototype as ExtensionRunner & Record<PropertyKey, unknown>;
	const existing = prototype[HUB] as Set<Listener> | undefined;
	if (existing) return existing;
	const original = prototype.getAllRegisteredTools;
	const listeners = new Set<Listener>();
	Object.defineProperty(prototype, HUB, { value: listeners, enumerable: false });
	prototype.getAllRegisteredTools = function observed(this: ExtensionRunner): RegisteredTool[] {
		const tools = original.call(this);
		for (const listener of [...listeners]) listener(tools);
		return tools;
	};
	return listeners;
};

export const installToolCapture = async (ownToolName: string): Promise<CapturedTools> => {
	let captured: RegisteredTool[] = [];
	const listener: Listener = (tools) => {
		captured = tools.filter((tool) => tool.definition.name !== ownToolName);
	};
	for (const Runner of await runnerConstructors()) hubFor(Runner).add(listener);
	return {
		list: () => captured,
		get: (name) => captured.find((tool) => tool.definition.name === name),
	};
};
