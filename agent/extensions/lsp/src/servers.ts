/**
 * Server registry: builtins + user config.
 * Config: ~/.pi/agent/lsp.json and <cwd>/.pi/lsp.json (project wins), shape:
 *   { [id]: { command: string[], extensions?: string[], roots?: string[], disabled?: boolean,
 *             env?: Record<string,string>, initialization?: unknown, hint?: string } }
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ServerDef {
	id: string;
	command: string[];
	extensions: string[];
	/** Marker files; nearest ancestor dir containing one becomes root. Falls back to cwd. */
	roots: string[];
	env?: Record<string, string>;
	initialization?: unknown;
	/** Install hint shown when binary missing. */
	hint?: string;
}

const BUILTINS: ServerDef[] = [
	{
		id: "typescript",
		command: ["typescript-language-server", "--stdio"],
		extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
		roots: ["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock", "tsconfig.json"],
		hint: "npm i -g typescript-language-server typescript",
	},
	{
		id: "pyright",
		command: [which("basedpyright-langserver") ? "basedpyright-langserver" : "pyright-langserver", "--stdio"],
		extensions: [".py", ".pyi"],
		roots: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "pyrightconfig.json"],
		hint: "npm i -g pyright  (or: pip install basedpyright)",
	},
	{
		id: "gopls",
		command: ["gopls"],
		extensions: [".go"],
		roots: ["go.work", "go.mod"],
		hint: "go install golang.org/x/tools/gopls@latest",
	},
	{
		id: "rust",
		command: ["rust-analyzer"],
		extensions: [".rs"],
		roots: ["Cargo.toml"],
		hint: "rustup component add rust-analyzer",
	},
];

type UserServer = Partial<ServerDef> & { disabled?: boolean };

function readConfig(file: string): Record<string, UserServer> {
	if (!existsSync(file)) return {};
	return JSON.parse(readFileSync(file, "utf-8"));
}

export function loadServers(cwd: string): ServerDef[] {
	const user = { ...readConfig(join(getAgentDir(), "lsp.json")), ...readConfig(join(cwd, ".pi", "lsp.json")) };
	const merged = new Map(BUILTINS.map((s) => [s.id, s]));
	for (const [id, cfg] of Object.entries(user)) {
		if (cfg.disabled) {
			merged.delete(id);
			continue;
		}
		const base = merged.get(id);
		if (!base && (!cfg.command || !cfg.extensions)) throw new Error(`lsp.json: custom server "${id}" needs command + extensions`);
		merged.set(id, { id, roots: [], ...base, ...cfg, command: cfg.command ?? base!.command, extensions: cfg.extensions ?? base!.extensions });
	}
	return [...merged.values()];
}

export function which(bin: string): string | undefined {
	if (bin.includes("/")) return existsSync(bin) ? bin : undefined;
	for (const dir of (process.env.PATH ?? "").split(":")) {
		const p = join(dir, bin);
		try {
			accessSync(p, constants.X_OK);
			if (statSync(p).isFile()) return p;
		} catch {}
	}
	return undefined;
}

/** Nearest ancestor of file (bounded by cwd) containing a marker; else cwd. */
export function findRoot(file: string, markers: string[], cwd: string): string {
	let dir = dirname(file);
	while (dir.startsWith(cwd) && dir.length >= cwd.length) {
		if (markers.some((m) => existsSync(join(dir, m)))) return dir;
		if (dir === cwd) break;
		dir = dirname(dir);
	}
	return cwd;
}
