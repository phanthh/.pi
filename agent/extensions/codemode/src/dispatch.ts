/**
 * The host side of the bridge: every guest call lands here, is resolved to a
 * real Pi ToolDefinition, and is executed with the enclosing tool call's
 * ExtensionContext. The sandbox never touches a tool directly.
 */
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { CapturedTools } from "./capture.ts";
import { normalizePiArgs } from "./guest-setup.ts";

type AnyToolDefinition = ToolDefinition<any, any, any>;

const CORE_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
type CoreToolName = (typeof CORE_TOOL_NAMES)[number];

/** Tools whose result is the file/search text itself, not an envelope. */
const TEXT_RESULT_TOOLS: Record<string, true> = { read: true, grep: true, find: true, ls: true };

const coreDefinitions = (cwd: string): Record<CoreToolName, AnyToolDefinition> => ({
	read: createReadToolDefinition(cwd),
	bash: createBashToolDefinition(cwd),
	edit: createEditToolDefinition(cwd),
	write: createWriteToolDefinition(cwd),
	grep: createGrepToolDefinition(cwd),
	find: createFindToolDefinition(cwd),
	ls: createLsToolDefinition(cwd),
});

const checkQuietly = (schema: unknown, value: unknown): boolean => {
	try {
		return Value.Check(schema as any, value);
	} catch {
		return true;
	}
};

const textContent = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: any) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
};

/** Errors must reject inside the guest, so a failed call cannot read as success. */
const normalizeResult = (name: string, result: any): unknown => {
	const text = textContent(result?.content);
	if (result?.isError) throw new Error(text || `${name} failed`);
	if (TEXT_RESULT_TOOLS[name]) return text;
	return { ok: true, output: text, details: result?.details ?? null };
};

export interface DispatchOptions {
	cwd: string;
	captured: CapturedTools;
	context: ExtensionContext;
	toolCallId: string;
}

export interface ToolRefInfo {
	ref: string;
	description: string;
	inputSchema: unknown;
}

export const createDispatcher = (options: DispatchOptions) => {
	const core = coreDefinitions(options.cwd);
	let nestedCalls = 0;

	const resolve = (ref: string): { name: string; definition: AnyToolDefinition } | undefined => {
		if (!ref.startsWith("pi.")) return undefined;
		const name = ref.slice(3);
		const definition = core[name as CoreToolName] ?? options.captured.get(name)?.definition;
		return definition ? { name, definition } : undefined;
	};

	const refs = (): ToolRefInfo[] => [
		...CORE_TOOL_NAMES.map((name) => ({
			ref: `pi.${name}`,
			description: core[name].description,
			inputSchema: core[name].parameters,
		})),
		...options.captured
			.list()
			.filter((tool) => !(tool.definition.name in core))
			.map((tool) => ({
				ref: `pi.${tool.definition.name}`,
				description: tool.definition.description,
				inputSchema: tool.definition.parameters,
			})),
	];

	const invoke = async (
		ref: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> => {
		const resolved = resolve(ref);
		if (!resolved) {
			const available = refs()
				.map((entry) => entry.ref)
				.join(", ");
			throw new Error(`Unknown tool ref "${ref}". Available refs: ${available}`);
		}
		const { name, definition } = resolved;
		// pi.call({ ref: "pi.read", ... }) skips the direct proxy, so core aliases
		// need the same repair before reaching the schema gate.
		const repaired =
			name in core ? (normalizePiArgs(name, args) as Record<string, unknown>) : args;
		const prepared = definition.prepareArguments
			? definition.prepareArguments(repaired)
			: repaired;
		// Pi validates arguments before a normal tool call; a nested call from the
		// sandbox bypasses that path, so the schema gate has to be applied here.
		const schema = definition.parameters as any;
		// A schema built on a Kind this typebox copy does not know cannot be judged;
		// let the tool's own validation decide rather than rejecting every call.
		const valid = schema ? checkQuietly(schema, prepared) : true;
		if (!valid) {
			const problems = [...Value.Errors(schema, prepared)]
				.slice(0, 5)
				.map((error) => `${error.instancePath || "/"}: ${error.message}`)
				.join("; ");
			throw new Error(
				`Invalid arguments for ${ref}: ${problems}. Call pi.describe({ ref: "${ref}" }) and read inputSchema, then retry.`,
			);
		}
		nestedCalls += 1;
		const result = await definition.execute(
			`${options.toolCallId}.${nestedCalls}`,
			prepared as any,
			signal,
			undefined,
			options.context,
		);
		return normalizeResult(name, result);
	};

	/** Single entry point handed to the sandbox as its only escape. */
	const hostCall = async (
		ref: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> => {
		switch (ref) {
			case "$list": {
				const query = typeof args.query === "string" ? args.query.toLowerCase() : undefined;
				return refs().filter((entry) =>
					query ? `${entry.ref} ${entry.description}`.toLowerCase().includes(query) : true,
				);
			}
			case "$describe": {
				const target = String(args.ref ?? "");
				const found = refs().find((entry) => entry.ref === target);
				if (!found) throw new Error(`Unknown tool ref "${target}"`);
				return found;
			}
			case "$call": {
				const target = String(args.ref ?? "");
				const callArgs =
					args.args && typeof args.args === "object" && !Array.isArray(args.args)
						? (args.args as Record<string, unknown>)
						: {};
				return invoke(target, callArgs, signal);
			}
			default:
				return invoke(ref, args, signal);
		}
	};

	return { hostCall, refs, get callCount() {
		return nestedCalls;
	} };
};
