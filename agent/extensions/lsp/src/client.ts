/**
 * One LSP client per (server, root). JSON-RPC over stdio.
 */
import { spawn } from "node:child_process";
import { existsSync, type FSWatcher, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProtocolConnection, StreamMessageReader, StreamMessageWriter } from "vscode-languageserver-protocol/node";
import type { Diagnostic, DocumentDiagnosticReport, FileSystemWatcher, InitializeResult, ProtocolConnection, Registration, TextEdit, Unregistration, WorkspaceEdit } from "vscode-languageserver-protocol";
import type { ServerDef } from "./servers.ts";

const INIT_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 30_000;
// Cold pyright on a big project can take >5s for the first push of a file.
const PUSH_WAIT_MS = 15_000;
const PUSH_DEBOUNCE_MS = 150;
const IDLE_TIMEOUT_MS = 60_000;
const IDLE_QUIET_MS = 300;
const WATCH_DEBOUNCE_MS = 200;
const MAX_WATCHERS = 5_000;
const IGNORED_DIRS = /^(?:node_modules|\.git|dist|build|__pycache__|\.next|\.turbo|target|\.mypy_cache|\.pytest_cache)$/;

function within(root: string, file: string) {
	const rel = relative(root, file);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export interface Client {
	id: string;
	root: string;
	/** Persistent server caveats plus one-time filesystem watcher warning. */
	warnings(): string[];
	/** Root membership or an explicitly opened outside-root document. */
	tracks(file: string): boolean;
	/** Preserve explicitly opened documents across interpreter restarts. */
	openFiles(): string[];
	/** Sync file content from disk to server (didOpen / didChange). Returns true if server saw a change. */
	open(file: string): boolean;
	/** didClose + forget file (deleted/renamed away). */
	close(file: string): void;
	notify(method: string, params: unknown): void;
	/** Resolves when server reports no in-progress work (indexing etc.), or after timeout. */
	idle(): Promise<void>;
	request<T>(method: string, params: unknown): Promise<T>;
	/** undefined = the server sent no report in time; NOT the same as "no diagnostics". */
	diagnostics(file: string): Promise<Diagnostic[] | undefined>;
	/** Write WorkspaceEdit to disk, resync touched files. Returns touched paths. */
	applyEdit(edit: WorkspaceEdit): string[];
	shutdown(): void;
}

export function timeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		p.then(resolve, reject).finally(() => clearTimeout(t));
	});
}

export async function createClient(server: ServerDef, root: string): Promise<Client> {
	const proc = spawn(server.command[0], server.command.slice(1), {
		cwd: root,
		env: { ...process.env, ...server.env },
		stdio: ["pipe", "pipe", "ignore"],
	});
	const spawnError = new Promise<never>((_, reject) => proc.once("error", reject));
	const conn: ProtocolConnection = createProtocolConnection(new StreamMessageReader(proc.stdout!), new StreamMessageWriter(proc.stdin!));

	const rootUri = pathToFileURL(root).href;
	const files: Record<string, { version: number; text: string }> = {};
	const pushed: Record<string, { at: number; items: Diagnostic[] }> = {};
	const pushListeners = new Set<(file: string) => void>();
	let pullSupported = false;
	const progress = new Set<string | number>();
	const idleListeners = new Set<() => void>();
	const registrations = new Map<string, FileSystemWatcher[]>();
	const watchers = new Map<string, FSWatcher>();
	const recursiveDirs = new Set<string>();
	const scans = new Map<string, FSWatcher>();
	const changes = new Map<string, number>();
	const changedDirs = new Set<string>();
	const watchWarnings: string[] = [];
	let watchWarned = false;
	let stopped = false;
	let shuttingDown = false;
	let watchTimer: ReturnType<typeof setTimeout> | undefined;

	function notify(method: string, params: unknown) {
		if (!stopped) void conn.sendNotification(method, params).catch(() => {});
	}

	function warnWatch(err: unknown) {
		if (watchWarned) return;
		watchWarned = true;
		watchWarnings.push(`${server.id}: filesystem watching degraded for ${root}: ${err instanceof Error ? err.message : String(err)}. External changes may be missed; explicit LSP calls still sync the requested file.`);
	}

	function stopWatching() {
		stopped = true;
		clearTimeout(watchTimer);
		watchTimer = undefined;
		changes.clear();
		changedDirs.clear();
		for (const watcher of watchers.values()) watcher.close();
		watchers.clear();
		recursiveDirs.clear();
		scans.clear();
	}
	proc.once("exit", stopWatching);
	conn.onClose(stopWatching);

	conn.onNotification("textDocument/publishDiagnostics", (params: { uri: string; version?: number; diagnostics: Diagnostic[] }) => {
		if (!params.uri.startsWith("file://")) return;
		const file = fileURLToPath(params.uri);
		if (params.version !== undefined && files[file] && params.version < files[file].version) return;
		pushed[file] = { at: Date.now(), items: params.diagnostics };
		for (const l of pushListeners) l(file);
	});
	conn.onRequest("workspace/configuration", (params: { items: { section?: string }[] }) =>
		params.items.map((item) => {
			const init = server.initialization as Record<string, unknown> | undefined;
			return item.section ? (init?.[item.section] ?? null) : (init ?? null);
		}),
	);
	conn.onRequest("client/registerCapability", (params: { registrations: Registration[] }) => {
		for (const r of params.registrations) {
			if (r.method === "textDocument/diagnostic") pullSupported = true;
			if (r.method === "workspace/didChangeWatchedFiles") registrations.set(r.id, r.registerOptions?.watchers ?? []);
		}
		return null;
	});
	conn.onRequest("client/unregisterCapability", (params: { unregisterations: Unregistration[] }) => {
		for (const r of params.unregisterations) registrations.delete(r.id);
		return null;
	});
	conn.onRequest("window/workDoneProgress/create", (params: { token: string | number }) => {
		progress.add(params.token);
		return null;
	});
	conn.onNotification("$/progress", (params: { token: string | number; value: { kind: string } }) => {
		if (params.value.kind === "begin") progress.add(params.token);
		if (params.value.kind !== "end") return;
		progress.delete(params.token);
		if (progress.size === 0) for (const l of idleListeners) l();
	});
	conn.onRequest("workspace/workspaceFolders", () => [{ name: "workspace", uri: rootUri }]);
	conn.onRequest("workspace/diagnostic/refresh", () => null);
	conn.onRequest("workspace/applyEdit", (params: { edit: WorkspaceEdit }) => {
		applyEdit(params.edit);
		return { applied: true };
	});
	conn.listen();

	const init = await timeout(
		Promise.race([
			spawnError,
			conn.sendRequest("initialize", {
				processId: process.pid,
				rootUri,
				workspaceFolders: [{ name: "workspace", uri: rootUri }],
				initializationOptions: server.initialization,
				capabilities: {
					window: { workDoneProgress: true },
					workspace: {
						configuration: true,
						didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
						workspaceFolders: true,
						applyEdit: true,
						workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"] },
						fileOperations: { willRename: true, didRename: true },
					},
					textDocument: {
						synchronization: { didOpen: true, didChange: true },
						diagnostic: { dynamicRegistration: true },
						publishDiagnostics: {},
						hover: { contentFormat: ["markdown", "plaintext"] },
						documentSymbol: { hierarchicalDocumentSymbolSupport: true },
						definition: { linkSupport: true },
						implementation: { linkSupport: true },
						callHierarchy: {},
						typeDefinition: { linkSupport: true },
						rename: { prepareSupport: false },
						codeAction: {
							dataSupport: true,
							resolveSupport: { properties: ["edit"] },
							codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "refactor", "source", "source.organizeImports", "source.fixAll"] } },
						},
					},
				},
			}) as Promise<InitializeResult>,
		]),
		INIT_TIMEOUT_MS,
		`${server.id} initialize`,
	).catch((err) => {
		stopWatching();
		conn.dispose();
		proc.kill();
		throw err;
	});
	if (init.capabilities.diagnosticProvider) pullSupported = true;
	await conn.sendNotification("initialized", {});
	if (server.initialization) await conn.sendNotification("workspace/didChangeConfiguration", { settings: server.initialization });

	const languageId = (file: string) => LANGUAGE_BY_EXT[file.slice(file.lastIndexOf("."))] ?? "plaintext";

	function wantsEvent(file: string, type: number) {
		if (!registrations.size) return true; // No registration: send all non-ignored changes.
		return [...registrations.values()].flat().some((w) => {
			if (!((w.kind ?? 7) & (type === 3 ? 4 : type))) return false;
			// matchesGlob excludes dot segments; LSP globs do not. Conservatively over-notify those paths.
			if (relative(root, file).split(sep).some((part) => part.startsWith(".") && part !== "..")) return true;
			try {
				if (typeof w.globPattern === "string") return matchesGlob(file, w.globPattern) || matchesGlob(relative(root, file), w.globPattern);
				const { baseUri, pattern } = w.globPattern;
				const base = fileURLToPath(typeof baseUri === "string" ? baseUri : baseUri.uri);
				return within(base, file) && matchesGlob(relative(base, file), pattern);
			} catch {
				return true; // Unsupported server glob: over-notify rather than miss changes.
			}
		});
	}

	function invalidateDiagnostics() {
		for (const file of Object.keys(pushed)) delete pushed[file];
	}

	function flushChanges() {
		clearTimeout(watchTimer);
		watchTimer = undefined;
		if (stopped || !changes.size) return;
		const batch = [...changes];
		const dirs = new Set(changedDirs);
		changes.clear();
		changedDirs.clear();
		// Directory changes can affect matching descendants even if the directory itself misses the glob.
		const watched = batch.filter(([file, type]) => dirs.has(file) || wantsEvent(file, type));
		// Invalidate dependents for forwarded source changes or registered server interests, not arbitrary logs.
		if (watched.some(([file]) => !files[file] && (registrations.size > 0 || dirs.has(file) || server.extensions.includes(extname(file))))) invalidateDiagnostics();
		for (const file of Object.keys(files)) {
			if (!batch.some(([changed]) => within(changed, file))) continue;
			try {
				open(file); // Duplicate events for already-synced text do not invalidate fresh reports.
			} catch (err) {
				delete pushed[file];
				if (!existsSync(file)) close(file);
				else warnWatch(err);
			}
		}
		const events = watched.map(([file, type]) => ({ uri: pathToFileURL(file).href, type }));
		if (events.length) notify("workspace/didChangeWatchedFiles", { changes: events });
	}

	function ignored(file: string) {
		const parts = relative(root, file).split(sep);
		return parts.some((part, i) => IGNORED_DIRS.test(part) || ((part === ".venv" || part === "venv") && i < parts.length - 1));
	}

	function queueChange(file: string, type: number, directory = false) {
		if (ignored(file) && !files[file] && !(directory && Object.keys(files).some((f) => within(file, f)))) return;
		changes.set(file, changes.get(file) === 1 && type === 2 ? 1 : type);
		if (directory) changedDirs.add(file);
		watchTimer ??= setTimeout(flushChanges, WATCH_DEBOUNCE_MS);
	}

	function closeTree(dir: string) {
		for (const [path, watcher] of watchers) {
			if (!within(dir, path)) continue;
			watcher.close();
			watchers.delete(path);
			recursiveDirs.delete(path);
			scans.delete(path);
		}
	}

	async function scanDirectory(dir: string, initial: boolean) {
		const owner = watchers.get(dir);
		if (!owner || scans.get(dir) === owner) return;
		scans.set(dir, owner);
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			for (let i = 0; i < entries.length; i++) {
				if (i % 100 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
				if (stopped || watchers.get(dir) !== owner) return;
				const entry = entries[i];
				const file = resolve(dir, entry.name);
				if (ignored(file)) continue;
				if (!initial) queueChange(file, 1, entry.isDirectory());
				if (entry.isDirectory()) watchDirectory(file, true, initial);
			}
		} catch (err) {
			if (watchers.get(dir) !== owner) return;
			if (!existsSync(dir)) closeTree(dir);
			else warnWatch(err);
		} finally {
			if (scans.get(dir) === owner) scans.delete(dir);
		}
	}

	// Explicit recursion prunes heavy trees and catches allocation errors when new directories appear.
	// Node's native recursive watcher can throw ENOSPC from an internal callback instead of emitting error.
	function watchDirectory(dir: string, recursive: boolean, initial = true) {
		if (stopped) return;
		if (watchers.has(dir)) {
			if (recursive && !recursiveDirs.has(dir)) {
				recursiveDirs.add(dir);
				void scanDirectory(dir, initial);
			}
			return;
		}
		if (watchers.size >= MAX_WATCHERS) {
			warnWatch(new Error(`watcher limit (${MAX_WATCHERS}) reached`));
			return;
		}
		try {
			const watcher = watch(dir, (event, name) => {
				try {
					if (!existsSync(dir)) {
						queueChange(dir, 3, true);
						closeTree(dir);
						if (dir === root) warnWatch(new Error("root directory removed"));
						return;
					}
					const file = name ? resolve(dir, name) : dir;
					if (!recursiveDirs.has(dir) && !files[file]) return;
					if (ignored(file) && !files[file]) return;
					const stats = lstatSync(file, { throwIfNoEntry: false });
					const directory = stats?.isDirectory() || recursiveDirs.has(file);
					queueChange(file, !stats ? 3 : event === "change" ? 2 : 1, directory);
					if (event === "rename" && recursiveDirs.has(dir)) {
						if (!name) void scanDirectory(dir, false);
						else if (directory) {
							closeTree(file); // Reattach after atomic directory replacement or move.
							if (stats?.isDirectory()) watchDirectory(file, true, false);
						}
					}
				} catch (err) { warnWatch(err); }
			});
			watchers.set(dir, watcher);
			if (recursive) recursiveDirs.add(dir);
			watcher.unref();
			watcher.on("error", (err) => {
				closeTree(dir);
				warnWatch(err);
			});
			if (recursive) void scanDirectory(dir, initial);
		} catch (err) { warnWatch(err); }
	}
	watchDirectory(root, true);

	function open(file: string) {
		const text = readFileSync(file, "utf-8");
		const uri = pathToFileURL(file).href;
		const prev = files[file];
		watchDirectory(dirname(file), false); // Also covers explicitly opened files in ignored trees.
		if (!prev) {
			delete pushed[file];
			files[file] = { version: 0, text };
			notify("textDocument/didOpen", { textDocument: { uri, languageId: languageId(file), version: 0, text } });
			return true;
		}
		if (prev.text === text) return false;
		invalidateDiagnostics();
		prev.version += 1;
		prev.text = text;
		notify("textDocument/didChange", { textDocument: { uri, version: prev.version }, contentChanges: [{ text }] });
		return true;
	}

	function close(file: string) {
		if (!files[file]) return;
		delete files[file];
		delete pushed[file];
		const dir = dirname(file);
		if (!recursiveDirs.has(dir) && !Object.keys(files).some((f) => dirname(f) === dir)) {
			watchers.get(dir)?.close();
			watchers.delete(dir);
		}
		notify("textDocument/didClose", { textDocument: { uri: pathToFileURL(file).href } });
	}

	function applyEdit(edit: WorkspaceEdit) {
		const touched = applyWorkspaceEdit(edit);
		for (const f of touched) {
			if (!files[f]) continue;
			try {
				open(f);
			} catch {
				close(f); // deleted/renamed away
			}
		}
		return touched;
	}

	function waitForPush(file: string, since: number): Promise<Diagnostic[] | undefined> {
		return new Promise((resolve) => {
			let debounce: ReturnType<typeof setTimeout> | undefined;
			const done = () => {
				pushListeners.delete(listener);
				clearTimeout(debounce);
				clearTimeout(deadline);
				resolve(pushed[file]?.items);
			};
			const listener = (f: string) => {
				if (f !== file || pushed[file].at < since) return;
				// servers like tsserver push syntax then semantic; wait briefly for the second batch
				clearTimeout(debounce);
				debounce = setTimeout(done, PUSH_DEBOUNCE_MS);
			};
			const deadline = setTimeout(done, PUSH_WAIT_MS);
			pushListeners.add(listener);
		});
	}

	function idle(): Promise<void> {
		return new Promise((resolve) => {
			let quiet: ReturnType<typeof setTimeout> | undefined;
			const done = () => {
				idleListeners.delete(listener);
				clearTimeout(quiet);
				clearTimeout(deadline);
				resolve();
			};
			// progress often ends then immediately begins next phase; require brief quiet
			const listener = () => {
				clearTimeout(quiet);
				quiet = setTimeout(() => progress.size === 0 && done(), IDLE_QUIET_MS);
			};
			const deadline = setTimeout(done, IDLE_TIMEOUT_MS);
			idleListeners.add(listener);
			listener();
		});
	}

	return {
		id: server.id,
		root,
		warnings: () => [...(server.warning ? [server.warning] : []), ...watchWarnings.splice(0)],
		tracks: (file) => within(root, file) || !!files[file],
		openFiles: () => Object.keys(files),
		open,
		close,
		idle,
		notify,
		request: (method, params) => timeout(conn.sendRequest(method, params), REQUEST_TIMEOUT_MS, `${server.id} ${method}`),
		async diagnostics(file) {
			flushChanges();
			const since = Date.now();
			const changed = open(file);
			if (pullSupported) {
				const report = await timeout(
					conn.sendRequest("textDocument/diagnostic", { textDocument: { uri: pathToFileURL(file).href } }) as Promise<DocumentDiagnosticReport>,
					REQUEST_TIMEOUT_MS,
					`${server.id} textDocument/diagnostic`,
				);
				return report.kind === "full" ? report.items : pushed[file]?.items;
			}
			if (!changed && pushed[file]) return pushed[file].items;
			if (!changed) {
				close(file);
				open(file); // Ask push-only servers to recompute after dependency/cache invalidation.
			}
			return waitForPush(file, since);
		},
		applyEdit,
		shutdown() {
			if (shuttingDown) return;
			shuttingDown = true;
			stopWatching();
			conn
				.sendRequest("shutdown")
				.then(() => conn.sendNotification("exit"))
				.catch(() => {})
				.finally(() => conn.dispose());
			setTimeout(() => proc.kill(), 1_000).unref();
		},
	};
}

/** Apply WorkspaceEdit to disk. Returns touched file paths. */
export function applyWorkspaceEdit(edit: WorkspaceEdit): string[] {
	const uriPath = (uri: string) => decodeURIComponent(new URL(uri).pathname);
	const touched = new Set<string>();
	const applyText = (file: string, edits: TextEdit[]) => {
		const text = readFileSync(file, "utf-8");
		const lineStarts = [0];
		for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
		const offset = (p: { line: number; character: number }) => (lineStarts[p.line] ?? text.length) + p.character;
		// apply bottom-up so earlier offsets stay valid
		const sorted = [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start) || offset(b.range.end) - offset(a.range.end));
		const out = sorted.reduce((acc, e) => acc.slice(0, offset(e.range.start)) + e.newText + acc.slice(offset(e.range.end)), text);
		writeFileSync(file, out);
		touched.add(file);
	};
	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if ("textDocument" in change) {
				// snippet edits not advertised in capabilities; degrade to raw snippet text if sent anyway
				applyText(
					uriPath(change.textDocument.uri),
					change.edits.map((e) => ("newText" in e ? e : { range: e.range, newText: e.snippet.value })),
				);
				continue;
			}
			if (change.kind === "create") {
				const p = uriPath(change.uri);
				mkdirSync(dirname(p), { recursive: true });
				if (!change.options?.ignoreIfExists) writeFileSync(p, "", { flag: change.options?.overwrite ? "w" : "wx" });
				touched.add(p);
			}
			if (change.kind === "rename") {
				const from = uriPath(change.oldUri);
				const to = uriPath(change.newUri);
				mkdirSync(dirname(to), { recursive: true });
				renameSync(from, to);
				touched.add(from);
				touched.add(to);
			}
			if (change.kind === "delete") {
				const p = uriPath(change.uri);
				rmSync(p, { recursive: change.options?.recursive, force: change.options?.ignoreIfNotExists });
				touched.add(p);
			}
		}
		return [...touched];
	}
	for (const [uri, edits] of Object.entries(edit.changes ?? {})) applyText(uriPath(uri), edits);
	return [...touched];
}

const LANGUAGE_BY_EXT: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescriptreact",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascriptreact",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".pyi": "python",
	".go": "go",
	".rs": "rust",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".hpp": "cpp",
	".lua": "lua",
	".sh": "shellscript",
	".json": "json",
	".yaml": "yaml",
	".yml": "yaml",
};
