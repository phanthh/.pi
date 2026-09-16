/**
 * The .d.ts the guest program is checked against. Core pi.* signatures are
 * hand-written; extensions.* is rendered from each captured tool's TypeBox
 * schema so a wrong field name fails at check time instead of at runtime.
 */
import type { RegisteredTool } from "@earendil-works/pi-coding-agent";

interface JsonSchema {
	type?: string | string[];
	const?: unknown;
	enum?: unknown[];
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
	allOf?: JsonSchema[];
	items?: JsonSchema;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	additionalProperties?: boolean | JsonSchema;
	description?: string;
}

const quoted = (value: unknown): string => JSON.stringify(value);

const isIdentifier = (name: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);

/** Depth guard: schemas can self-nest; a too-deep branch degrades to `any`. */
const typeOf = (schema: JsonSchema | undefined, depth = 0): string => {
	if (!schema || depth > 6) return "any";
	if (schema.const !== undefined) return quoted(schema.const);
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		return schema.enum.map(quoted).join(" | ");
	}
	const union = schema.anyOf ?? schema.oneOf;
	if (union && union.length > 0) {
		return union.map((entry) => typeOf(entry, depth + 1)).join(" | ");
	}
	if (schema.allOf && schema.allOf.length > 0) {
		return schema.allOf.map((entry) => typeOf(entry, depth + 1)).join(" & ");
	}
	const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
	switch (type) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "array":
			return `Array<${typeOf(schema.items, depth + 1)}>`;
		case "object":
			return objectTypeOf(schema, depth);
		default:
			return "any";
	}
};

const objectTypeOf = (schema: JsonSchema, depth: number): string => {
	const properties = schema.properties ?? {};
	const names = Object.keys(properties);
	if (names.length === 0) return "Record<string, any>";
	const required = new Set(schema.required ?? []);
	const fields = names.map((name) => {
		const key = isIdentifier(name) ? name : quoted(name);
		const optional = required.has(name) ? "" : "?";
		return `${key}${optional}: ${typeOf(properties[name], depth + 1)}`;
	});
	return `{ ${fields.join("; ")} }`;
};

const blockComment = (text: string | undefined, indent: string): string => {
	if (!text) return "";
	const lines = text.trim().split("\n").slice(0, 6);
	return `${indent}/**\n${lines.map((line) => `${indent} * ${line}`).join("\n")}\n${indent} */\n`;
};

const BASE_DECLARATIONS = `
/** Shell / mutation tools resolve this envelope, never a bare string. */
interface ToolEnvelope {
  ok: boolean;
  output: string;
  details: any;
}

interface PiCoreTools {
  /** Read a file. Returns its text. */
  read(args: { path: string; offset?: number; limit?: number }): Promise<string>;
  read(path: string, options?: { offset?: number; limit?: number }): Promise<string>;
  /** Run a shell command. Rejects on a nonzero exit. */
  bash(args: { command: string; cwd?: string; timeout?: number }): Promise<ToolEnvelope>;
  bash(command: string, options?: { cwd?: string; timeout?: number }): Promise<ToolEnvelope>;
  /** Exact-text replacement. Each oldText must match exactly once. */
  edit(args: { path: string; edits: Array<{ oldText: string; newText: string }> }): Promise<ToolEnvelope>;
  /** Create or overwrite a file. */
  write(args: { path: string; content: string }): Promise<ToolEnvelope>;
  write(path: string, content: string): Promise<ToolEnvelope>;
  /** Search file contents. */
  grep(args: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }): Promise<string>;
  grep(pattern: string, path?: string, limit?: number): Promise<string>;
  /** Find files by glob. */
  find(args: { pattern: string; path?: string; limit?: number }): Promise<string>;
  find(pattern: string, path?: string, limit?: number): Promise<string>;
  /** List a directory. */
  ls(args: { path?: string; limit?: number }): Promise<string>;
  ls(path: string, options?: { limit?: number }): Promise<string>;
}

interface ToolRef {
  ref: string;
  description: string;
  inputSchema: any;
}

interface DiscoveryTools {
  /** Every callable ref: pi.<tool> and extensions.<tool>. */
  list(args?: { query?: string }): Promise<ToolRef[]>;
  /** Full schema for one ref. Read inputSchema before calling an unfamiliar tool. */
  describe(args: { ref: string } | string): Promise<ToolRef>;
  /** Call a ref computed at runtime. Same validation as the direct proxies. */
  call(args: { ref: string; args?: Record<string, any> }): Promise<any>;
}

declare const pi: PiCoreTools;
declare const tools: DiscoveryTools;
/** Strings passed in the tool call's payloads parameter. */
declare const π: Record<string, string>;
/** Write a line to the execution log (returned alongside the result). */
declare function print(...values: any[]): void;
`;

export const buildDeclarations = (captured: RegisteredTool[]): string => {
	const methods = captured
		.filter((tool) => isIdentifier(tool.definition.name))
		.map((tool) => {
			const schema = tool.definition.parameters as unknown as JsonSchema | undefined;
			const argsType = schema ? typeOf(schema) : "Record<string, any>";
			const optional = !schema?.required || schema.required.length === 0 ? "?" : "";
			return `${blockComment(tool.definition.description, "  ")}  ${tool.definition.name}(args${optional}: ${argsType}): Promise<any>;`;
		});
	const extensionsInterface = methods.length
		? `interface ExtensionTools {\n${methods.join("\n")}\n}`
		: "interface ExtensionTools { [tool: string]: (args?: Record<string, any>) => Promise<any> }";
	return `${BASE_DECLARATIONS}\n${extensionsInterface}\n/** Tools registered by other Pi extensions. */\ndeclare const extensions: ExtensionTools;\n`;
};
