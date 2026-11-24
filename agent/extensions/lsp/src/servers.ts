/**
 * Server registry: builtins + user config.
 * Config: ~/.pi/agent/lsp.json and <root>/.pi/lsp.json (project wins), shape:
 *   { [id]: { command: string[], extensions?: string[], disabled?: boolean,
 *             env?: Record<string,string>, initialization?: unknown, hint?: string } }
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ServerDef {
	id: string;
	command: string[];
	extensions: string[];
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
		hint: "npm i -g typescript-language-server typescript",
	},
	{
		id: "pyright",
		command: [which("basedpyright-langserver") ? "basedpyright-langserver" : "pyright-langserver", "--stdio"],
		extensions: [".py", ".pyi"],
		hint: "npm i -g pyright  (or: pip install basedpyright)",
	},
	{
		id: "gopls",
		command: ["gopls"],
		extensions: [".go"],
		hint: "go install golang.org/x/tools/gopls@latest",
	},
	{
		id: "rust",
		command: ["rust-analyzer"],
		extensions: [".rs"],
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
		merged.set(id, { id, ...base, ...cfg, command: cfg.command ?? base!.command, extensions: cfg.extensions ?? base!.extensions });
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
	const findVenv = (dir: string) => [".venv", "venv"].map((d) => join(dir, d)).find((d) => existsSync(join(d, "bin", "python"))) ?? poetryVenv(dir);
	let venv = findVenv(root);
	let warning: string | undefined;
	const main = venv ? undefined : mainCheckoutPath(root);
	if (main && (venv = findVenv(main))) {
		warning = `pyright: no venv in ${root}; borrowed main checkout venv ${venv}. Third-party deps may lag this worktree's lockfile.`;
	}
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
		warning,
		command: existsSync(localServer) ? [localServer, ...server.command.slice(1)] : server.command,
		initialization: { ...init, python: { ...init.python, pythonPath: join(venv, "bin", "python") } },
	};
}

/** Same path inside the main checkout when root lives in a linked git worktree. */
function mainCheckoutPath(root: string): string | undefined {
	try {
		const [top, common] = execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.trim()
			.split("\n");
		if (basename(common) !== ".git" || dirname(common) === top) return undefined;
		return join(dirname(common), relative(top, root));
	} catch {
		return undefined;
	}
}

/** Nearest pyrefly config from root up to the git toplevel: the repo's authoritative checker is not pyright. */
export function pyreflyConfig(root: string): string | undefined {
	for (let dir = root; ; dir = dirname(dir)) {
		const toml = join(dir, "pyrefly.toml");
		if (existsSync(toml)) return toml;
		const pyproject = join(dir, "pyproject.toml");
		if (existsSync(pyproject) && /^\[tool\.pyrefly\b/m.test(readFileSync(pyproject, "utf-8"))) return pyproject;
		if (existsSync(join(dir, ".git")) || dirname(dir) === dir) return undefined;
	}
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
