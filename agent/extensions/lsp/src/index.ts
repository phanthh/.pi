/**
 * lsp — code intelligence tool (definition/references/hover/symbols/call hierarchy/diagnostics).
 * Servers spawn lazily per (server, root), live for the session. edit/write results push didChange
 * to already-running servers only.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type CallHierarchyIncomingCall,
	type CallHierarchyItem,
	type CallHierarchyOutgoingCall,
	type CodeAction,
	type Command,
	type Diagnostic,
	DiagnosticSeverity,
	type DocumentSymbol,
	type Hover,
	type Location,
	type LocationLink,
	SymbolKind,
	type SymbolInformation,
	type WorkspaceEdit,
} from "vscode-languageserver-protocol";
import { type Client, createClient } from "./client.ts";
import { findRoot, loadServers, resolveForRoot, which } from "./servers.ts";

const OPERATIONS = [
	"goToDefinition",
	"findReferences",
	"hover",
	"documentSymbol",
	"workspaceSymbol",
	"goToImplementation",
	"prepareCallHierarchy",
	"incomingCalls",
	"outgoingCalls",
	"diagnostics",
	"typeDefinition",
	"rename",
	"renameFile",
	"codeAction",
] as const;

const POSITIONAL = new Set<string>([
	"goToDefinition",
	"findReferences",
	"hover",
	"goToImplementation",
	"prepareCallHierarchy",
	"incomingCalls",
	"outgoingCalls",
	"typeDefinition",
	"rename",
	"codeAction",
]);
const MAX_DIAGNOSTICS = 50;

const DESCRIPTION = `Language Server Protocol code intelligence. Operations:
- goToDefinition, typeDefinition, findReferences, hover, goToImplementation: need filePath + line + character (1-based)
- rename: filePath + line + character on symbol + newName; applies edits across workspace files
- renameFile: filePath + newPath; moves file and updates imports across workspace (typescript, rust-analyzer; others just move)
- codeAction: filePath + line + character; lists available actions (quickfixes, refactors, source actions like add missing imports). Pass title to apply matching action. Optional kind filter (quickfix, refactor, source, source.organizeImports, source.fixAll, source.addMissingImports.ts)
- prepareCallHierarchy, incomingCalls, outgoingCalls: need filePath + line + character on a function/method name
- documentSymbol: all symbols in filePath
- workspaceSymbol: project-wide symbols matching query (filePath only selects which server; empty query = all)
- diagnostics: current errors/warnings for filePath (call after editing to verify)
Servers start lazily per project root (typescript, pyright, gopls, rust-analyzer builtin; extend via ~/.pi/agent/lsp.json or .pi/lsp.json). Errors if no server for the file type or binary not installed.`;

export default function (pi: ExtensionAPI) {
	const clients = new Map<string, Promise<Client>>();
	const broken = new Map<string, string>();

	function shutdownAll() {
		for (const c of clients.values()) c.then((client) => client.shutdown()).catch(() => {});
		clients.clear();
		broken.clear();
	}

	/** Clients for file; spawns missing ones. Throws if no server matches ext or binary missing. */
	async function clientsFor(file: string, cwd: string): Promise<Client[]> {
		const ext = extname(file);
		const servers = loadServers(cwd).filter((s) => s.extensions.includes(ext));
		if (!servers.length) throw new Error(`No LSP server configured for "${ext}" files.`);
		const result = await Promise.all(
			servers.map((base) => {
				const root = findRoot(file, base.roots, cwd);
				const server = resolveForRoot(base, root);
				const key = `${server.id}:${root}`;
				if (broken.has(key)) throw new Error(broken.get(key));
				const existing = clients.get(key);
				if (existing) return existing;
				if (!which(server.command[0])) {
					const msg = `LSP server "${server.id}" binary "${server.command[0]}" not in PATH.${server.hint ? ` Install: ${server.hint}` : ""}`;
					broken.set(key, msg);
					throw new Error(msg);
				}
				const pending = createClient(server, root).catch((err) => {
					clients.delete(key);
					const msg = `LSP server "${server.id}" failed to start: ${err instanceof Error ? err.message : String(err)}`;
					broken.set(key, msg);
					throw new Error(msg);
				});
				clients.set(key, pending);
				return pending;
			}),
		);
		return result;
	}

	/** Running clients matching file (no spawn). */
	async function runningFor(file: string): Promise<Client[]> {
		const ext = extname(file);
		const all = await Promise.all([...clients.values()].map((p) => p.catch(() => undefined)));
		return all.filter((c): c is Client => !!c && file.startsWith(c.root) && loadServers(c.root).some((s) => s.id === c.id && s.extensions.includes(ext)));
	}

	pi.on("session_shutdown", () => shutdownAll());

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		if (event.isError) return;
		const input = event.input as { path?: string };
		if (!input.path) return;
		const file = resolve(input.path);
		if (!existsSync(file)) return;
		for (const client of await runningFor(file)) {
			try {
				client.open(file);
			} catch {}
		}
	});

	pi.registerTool({
		name: "lsp",
		label: "LSP",
		description: DESCRIPTION,
		promptSnippet: "Code intelligence via LSP: go to definition, find references, hover types, symbols, call hierarchy, diagnostics, rename symbol, rename/move file with import updates",
		promptGuidelines: [
			"Use lsp for symbol navigation (goToDefinition/findReferences) instead of grep when the file type has a language server.",
			"Use lsp diagnostics after edits to verify no type errors were introduced.",
		],
		parameters: Type.Object({
			operation: StringEnum(OPERATIONS),
			filePath: Type.String({ description: "Absolute or cwd-relative file path" }),
			line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line (positional ops)" })),
			character: Type.Optional(Type.Integer({ minimum: 1, description: "1-based column (positional ops)" })),
			query: Type.Optional(Type.String({ description: "workspaceSymbol query; empty = all" })),
			newName: Type.Optional(Type.String({ description: "rename: new symbol name" })),
			newPath: Type.Optional(Type.String({ description: "renameFile: destination path" })),
			title: Type.Optional(Type.String({ description: "codeAction: title of action to apply (exact, else prefix match). Omit to list." })),
			kind: Type.Optional(Type.String({ description: "codeAction: kind filter, e.g. quickfix, source.organizeImports" })),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const file = isAbsolute(params.filePath) ? params.filePath : resolve(ctx.cwd, params.filePath);
			if (!existsSync(file)) throw new Error(`File not found: ${file}`);
			if (POSITIONAL.has(params.operation) && (!params.line || !params.character)) throw new Error(`${params.operation} requires line and character`);
			if (params.operation === "rename" && !params.newName) throw new Error("rename requires newName");
			if (params.operation === "renameFile" && !params.newPath) throw new Error("renameFile requires newPath");

			const clients = await clientsFor(file, ctx.cwd);
			await Promise.all(clients.map((c) => c.idle()));
			const uri = pathToFileURL(file).href;
			const textDocument = { uri };
			const position = { line: (params.line ?? 1) - 1, character: (params.character ?? 1) - 1 };
			const rel = (p: string) => relative(ctx.cwd, p) || ".";
			const run = <T>(method: string, reqParams: unknown) => Promise.all(clients.map((c) => c.request<T>(method, reqParams).catch(() => null)));

			if (params.operation === "diagnostics") {
				const items = (await Promise.all(clients.map((c) => c.diagnostics(file)))).flat();
				return { content: [{ type: "text", text: formatDiagnostics(items, rel(file)) }], details: { count: items.length } };
			}

			for (const c of clients) c.open(file);

			const text = await (async () => {
				switch (params.operation) {
					case "hover": {
						const results = await run<Hover | null>("textDocument/hover", { textDocument, position });
						return results.map((h) => h && formatHover(h)).filter(Boolean).join("\n\n");
					}
					case "goToDefinition":
					case "typeDefinition":
					case "findReferences":
					case "goToImplementation": {
						const method = {
							goToDefinition: "textDocument/definition",
							typeDefinition: "textDocument/typeDefinition",
							findReferences: "textDocument/references",
							goToImplementation: "textDocument/implementation",
						}[params.operation];
						const extra = params.operation === "findReferences" ? { context: { includeDeclaration: true } } : {};
						const results = await run<Location | Location[] | LocationLink[] | null>(method, { textDocument, position, ...extra });
						const locs: (Location | LocationLink)[] = results.flatMap((r) => (r ? (Array.isArray(r) ? (r as (Location | LocationLink)[]) : [r]) : []));
						return uniq(locs.map((l) => formatLocation(l, rel))).join("\n");
					}
					case "documentSymbol": {
						const results = await run<DocumentSymbol[] | SymbolInformation[] | null>("textDocument/documentSymbol", { textDocument });
						return results.flatMap((r) => (r ? formatSymbols(r, rel) : [])).join("\n");
					}
					case "workspaceSymbol": {
						const results = await run<SymbolInformation[] | null>("workspace/symbol", { query: params.query ?? "" });
						return results.flatMap((r) => (r ? formatSymbols(r, rel) : [])).join("\n");
					}
					case "prepareCallHierarchy":
					case "incomingCalls":
					case "outgoingCalls": {
						const itemsPer = await Promise.all(clients.map((c) => c.request<CallHierarchyItem[] | null>("textDocument/prepareCallHierarchy", { textDocument, position }).catch(() => null)));
						if (params.operation === "prepareCallHierarchy") return itemsPer.flatMap((items) => items ?? []).map((i) => formatItem(i, rel)).join("\n");
						const incoming = params.operation === "incomingCalls";
						const lines = await Promise.all(
							clients.map(async (c, idx) => {
								const items = itemsPer[idx] ?? [];
								const calls = await Promise.all(
									items.map((item) =>
										c.request<(CallHierarchyIncomingCall | CallHierarchyOutgoingCall)[] | null>(incoming ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls", { item }).catch(() => null),
									),
								);
								return calls.flatMap((cs) => cs ?? []).map((call) => formatItem("from" in call ? call.from : call.to, rel));
							}),
						);
						return lines.flat().join("\n");
					}
					case "rename": {
						// single client: multiple servers applying same edit would double-apply
						const edit = await clients[0].request<WorkspaceEdit | null>("textDocument/rename", { textDocument, position, newName: params.newName });
						if (!edit) return "";
						const touched = clients[0].applyEdit(edit);
						return `Renamed to ${params.newName} in ${touched.length} file(s):\n${touched.map(rel).join("\n")}`;
					}
					case "renameFile": {
						const client = clients[0];
						const to = isAbsolute(params.newPath!) ? params.newPath! : resolve(ctx.cwd, params.newPath!);
						if (existsSync(to)) throw new Error(`Target exists: ${to}`);
						const files = [{ oldUri: uri, newUri: pathToFileURL(to).href }];
						// unsupported servers reject → plain move
						const edit = await client.request<WorkspaceEdit | null>("workspace/willRenameFiles", { files }).catch(() => null);
						const touched = edit ? client.applyEdit(edit) : [];
						client.close(file);
						mkdirSync(dirname(to), { recursive: true });
						renameSync(file, to);
						client.notify("workspace/didRenameFiles", { files });
						client.open(to);
						const others = touched.filter((f) => f !== file);
						return `Moved ${rel(file)} → ${rel(to)}${others.length ? `, updated imports in:\n${others.map(rel).join("\n")}` : ""}`;
					}
					case "codeAction": {
						const client = clients[0];
						// servers (tsserver) only offer quickfixes for diagnostics passed in context
						const diags = (await client.diagnostics(file)).filter((d) => d.range.start.line <= position.line && d.range.end.line >= position.line);
						const actions = (
							(await client.request<(CodeAction | Command)[] | null>("textDocument/codeAction", {
								textDocument,
								range: { start: position, end: position },
								context: { diagnostics: diags, ...(params.kind ? { only: [params.kind] } : {}) },
							})) ?? []
						).filter((a) => !("disabled" in a && a.disabled));
						if (!params.title) return actions.map((a) => `${a.title}${"kind" in a && a.kind ? ` [${a.kind}]` : ""}`).join("\n");
						const action = actions.find((a) => a.title === params.title) ?? actions.find((a) => a.title.startsWith(params.title!));
						if (!action) throw new Error(`No code action titled "${params.title}". Available:\n${actions.map((a) => a.title).join("\n")}`);
						const touched = await applyAction(client, action);
						return `Applied "${action.title}"${touched.length ? `, touched:\n${touched.map(rel).join("\n")}` : ""}`;
					}
				}
				return "";
			})();

			return { content: [{ type: "text", text: text || `No results for ${params.operation}` }], details: {} };
		},

		renderCall(args, theme) {
			const loc = args.line ? `:${args.line}:${args.character}` : "";
			const extra = args.query ? ` "${args.query}"` : args.newPath ? ` → ${args.newPath}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("lsp"))} ${theme.fg("muted", `${args.operation} ${args.filePath}${loc}${extra}`)}`, 0, 0);
		},
	});
}

/** Apply CodeAction (resolving lazily) or Command. Returns touched files. */
async function applyAction(client: Client, action: CodeAction | Command) {
	if (typeof action.command === "string") {
		// bare Command: server applies via workspace/applyEdit
		const cmd = action as Command;
		await client.request("workspace/executeCommand", { command: cmd.command, arguments: cmd.arguments });
		return [];
	}
	const unresolved = action as CodeAction;
	const resolved = unresolved.edit || !unresolved.data ? unresolved : await client.request<CodeAction>("codeAction/resolve", unresolved);
	const touched = resolved.edit ? client.applyEdit(resolved.edit) : [];
	if (resolved.command) await client.request("workspace/executeCommand", { command: resolved.command.command, arguments: resolved.command.arguments });
	return touched;
}

// --- formatting ---

const SYMBOL_KIND_NAME = Object.fromEntries(Object.entries(SymbolKind).map(([name, value]) => [value, name.toLowerCase()])) as Record<number, string>;
const SEVERITY_LABEL: Record<number, string> = { [DiagnosticSeverity.Error]: "ERROR", [DiagnosticSeverity.Warning]: "WARN", [DiagnosticSeverity.Information]: "INFO", [DiagnosticSeverity.Hint]: "HINT" };

function uniq(lines: string[]) {
	return [...new Set(lines)];
}

function uriToPath(uri: string) {
	return decodeURIComponent(new URL(uri).pathname);
}

function lineText(file: string, line: number) {
	try {
		return (readFileSync(file, "utf-8").split("\n")[line] ?? "").trim();
	} catch {
		return "";
	}
}

function formatLocation(loc: Location | LocationLink, rel: (p: string) => string) {
	const uri = "targetUri" in loc ? loc.targetUri : loc.uri;
	const range = "targetSelectionRange" in loc ? loc.targetSelectionRange : loc.range;
	const file = uriToPath(uri);
	return `${rel(file)}:${range.start.line + 1}:${range.start.character + 1}  ${lineText(file, range.start.line)}`;
}

function formatHover(hover: Hover) {
	const c = hover.contents;
	const parts = Array.isArray(c) ? c : [c];
	return parts
		.map((p) => (typeof p === "string" ? p : "language" in p ? `\`\`\`${p.language}\n${p.value}\n\`\`\`` : p.value))
		.join("\n")
		.trim();
}

function formatSymbols(symbols: (DocumentSymbol | SymbolInformation)[], rel: (p: string) => string, depth = 0): string[] {
	return symbols.flatMap((s) => {
		if ("location" in s) return [`${s.name} [${SYMBOL_KIND_NAME[s.kind]}] ${rel(uriToPath(s.location.uri))}:${s.location.range.start.line + 1}:${s.location.range.start.character + 1}`];
		const r = s.selectionRange;
		return [`${"  ".repeat(depth)}${s.name} [${SYMBOL_KIND_NAME[s.kind]}] ${r.start.line + 1}:${r.start.character + 1}`, ...formatSymbols(s.children ?? [], rel, depth + 1)];
	});
}

function formatItem(item: CallHierarchyItem, rel: (p: string) => string) {
	return `${item.name} [${SYMBOL_KIND_NAME[item.kind]}] ${rel(uriToPath(item.uri))}:${item.selectionRange.start.line + 1}:${item.selectionRange.start.character + 1}`;
}

function formatDiagnostics(items: Diagnostic[], rel: string) {
	if (!items.length) return `No diagnostics for ${rel}`;
	const sorted = [...items].sort((a, b) => (a.severity ?? 4) - (b.severity ?? 4) || a.range.start.line - b.range.start.line);
	const lines = sorted.slice(0, MAX_DIAGNOSTICS).map((d) => {
		const tag = [d.source, d.code].filter((x) => x !== undefined && x !== "").join(" ");
		return `${SEVERITY_LABEL[d.severity ?? 4]} ${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${(typeof d.message === "string" ? d.message : d.message.value).replace(/\s+/g, " ")}${tag ? ` [${tag}]` : ""}`;
	});
	if (items.length > MAX_DIAGNOSTICS) lines.push(`... ${items.length - MAX_DIAGNOSTICS} more`);
	return lines.join("\n");
}
