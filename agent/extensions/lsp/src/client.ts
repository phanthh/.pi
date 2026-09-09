/**
 * One LSP client per (server, root). JSON-RPC over stdio.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createProtocolConnection, StreamMessageReader, StreamMessageWriter } from "vscode-languageserver-protocol/node";
import type { Diagnostic, DocumentDiagnosticReport, InitializeResult, ProtocolConnection, TextEdit, WorkspaceEdit } from "vscode-languageserver-protocol";
import type { ServerDef } from "./servers.ts";

const INIT_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 30_000;
const PUSH_WAIT_MS = 5_000;
const PUSH_DEBOUNCE_MS = 150;
const IDLE_TIMEOUT_MS = 60_000;
const IDLE_QUIET_MS = 300;

export interface Client {
	id: string;
	root: string;
	/** Sync file content from disk to server (didOpen / didChange). Returns true if server saw a change. */
	open(file: string): boolean;
	/** didClose + forget file (deleted/renamed away). */
	close(file: string): void;
	notify(method: string, params: unknown): void;
	/** Resolves when server reports no in-progress work (indexing etc.), or after timeout. */
	idle(): Promise<void>;
	request<T>(method: string, params: unknown): Promise<T>;
	diagnostics(file: string): Promise<Diagnostic[]>;
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

	conn.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics: Diagnostic[] }) => {
		if (!params.uri.startsWith("file://")) return;
		const file = decodeURIComponent(new URL(params.uri).pathname);
		pushed[file] = { at: Date.now(), items: params.diagnostics };
		for (const l of pushListeners) l(file);
	});
	conn.onRequest("workspace/configuration", (params: { items: { section?: string }[] }) =>
		params.items.map((item) => {
			const init = server.initialization as Record<string, unknown> | undefined;
			return item.section ? (init?.[item.section] ?? null) : (init ?? null);
		}),
	);
	conn.onRequest("client/registerCapability", (params: { registrations: { method: string }[] }) => {
		if (params.registrations.some((r) => r.method === "textDocument/diagnostic")) pullSupported = true;
	});
	conn.onRequest("client/unregisterCapability", () => null);
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
	);
	if (init.capabilities.diagnosticProvider) pullSupported = true;
	await conn.sendNotification("initialized", {});
	if (server.initialization) await conn.sendNotification("workspace/didChangeConfiguration", { settings: server.initialization });

	const languageId = (file: string) => LANGUAGE_BY_EXT[file.slice(file.lastIndexOf("."))] ?? "plaintext";

	function open(file: string) {
		const text = readFileSync(file, "utf-8");
		const uri = pathToFileURL(file).href;
		const prev = files[file];
		if (!prev) {
			files[file] = { version: 0, text };
			conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: languageId(file), version: 0, text } });
			return true;
		}
		if (prev.text === text) return false;
		prev.version += 1;
		prev.text = text;
		conn.sendNotification("textDocument/didChange", { textDocument: { uri, version: prev.version }, contentChanges: [{ text }] });
		return true;
	}

	function close(file: string) {
		if (!files[file]) return;
		delete files[file];
		conn.sendNotification("textDocument/didClose", { textDocument: { uri: pathToFileURL(file).href } });
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

	function waitForPush(file: string, since: number): Promise<Diagnostic[]> {
		return new Promise((resolve) => {
			let debounce: ReturnType<typeof setTimeout> | undefined;
			const done = () => {
				pushListeners.delete(listener);
				clearTimeout(debounce);
				clearTimeout(deadline);
				resolve(pushed[file]?.items ?? []);
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
		open,
		close,
		idle,
		notify: (method, params) => void conn.sendNotification(method, params),
		request: (method, params) => timeout(conn.sendRequest(method, params), REQUEST_TIMEOUT_MS, `${server.id} ${method}`),
		async diagnostics(file) {
			const since = Date.now();
			const changed = open(file);
			if (pullSupported) {
				const report = await timeout(
					conn.sendRequest("textDocument/diagnostic", { textDocument: { uri: pathToFileURL(file).href } }) as Promise<DocumentDiagnosticReport>,
					REQUEST_TIMEOUT_MS,
					`${server.id} textDocument/diagnostic`,
				);
				return report.kind === "full" ? report.items : (pushed[file]?.items ?? []);
			}
			if (!changed && pushed[file]) return pushed[file].items;
			return waitForPush(file, since);
		},
		applyEdit,
		shutdown() {
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
