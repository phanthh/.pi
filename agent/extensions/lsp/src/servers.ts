/**
 * Server registry: builtins + user config.
 * Config: ~/.pi/agent/lsp.json and <cwd>/.pi/lsp.json (project wins), shape:
 *   { [id]: { command: string[], extensions?: string[], roots?: string[], disabled?: boolean,
 *             env?: Record<string,string>, initialization?: unknown, hint?: string } }
 */
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
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
	/** Caveat appended to results, e.g. imports resolve against the wrong interpreter. */
	warning?: string;
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

/**
 * Poetry's out-of-project venv for root: `<virtualenvs.path>/<name>-<hash8>-py<X.Y>`, where
 * hash8 = urlsafe-base64(sha256(realpath(root)))[:8]. Computed, not `poetry env info`: that
 * can hang on the keyring and costs seconds.
 */
export function poetryVenv(root: string, base = process.env.POETRY_VIRTUALENVS_PATH ?? join(homedir(), ".cache", "pypoetry", "virtualenvs")): string | undefined {
	let pyproject: string;
	try {
		pyproject = readFileSync(join(root, "pyproject.toml"), "utf-8");
	} catch {
		return undefined;
	}
	// First `name =` under [project] or [tool.poetry].
	const name = /^\[(?:project|tool\.poetry)\][^\S\n]*\n(?:(?!\[)[^\n]*\n)*?name\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1];
	if (!name) return undefined;
	const sanitized = name.toLowerCase().replace(/[-_.]+/g, "-").replace(/[ $`!*@"\\\r\n\t]/g, "_").slice(0, 42);
	const hash = createHash("sha256").update(realpathSync(root)).digest("base64url").slice(0, 8);
	let entries: string[];
	try {
		entries = readdirSync(base);
	} catch {
		return undefined;
	}
	const prefix = `${sanitized}-${hash}-py`;
	return entries
		.filter((e) => e.startsWith(prefix) && existsSync(join(base, e, "bin", "python")))
		.sort()
		.map((e) => join(base, e))
		.at(-1);
}

/** Per-root tweaks: pyright needs the project venv interpreter or imports resolve to system python. */
export function resolveForRoot(server: ServerDef, root: string): ServerDef {
	if (server.id !== "pyright") return server;
	const init = (server.initialization ?? {}) as Record<string, Record<string, unknown> | undefined>;
	if (init.python?.pythonPath) return server;
	const venv = [".venv", "venv"].map((d) => join(root, d)).find((d) => existsSync(join(d, "bin", "python"))) ?? poetryVenv(root);
	if (!venv) {
		return {
			...server,
			warning:
				`pyright: no virtualenv found for ${root} (.venv, venv, poetry). Third-party imports and stdlib resolve ` +
				`against the default interpreter, so import errors/types may be wrong. Fix: create the venv, or set ` +
				`{"pyright": {"initialization": {"python": {"pythonPath": "<venv>/bin/python"}}}} in .pi/lsp.json.`,
		};
	}
	const localServer = join(venv, "bin", "basedpyright-langserver");
	return {
		...server,
		command: existsSync(localServer) ? [localServer, ...server.command.slice(1)] : server.command,
		initialization: { ...init, python: { ...init.python, pythonPath: join(venv, "bin", "python") } },
	};
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
