/**
 * code mode — one tool that runs a type-checked TypeScript program in QuickJS.
 * Branching, loops, fan-out and data flow live in the program; only the value
 * it returns enters the model's context.
 *
 * Ported from pi-fabric (MIT, github.com/monotykamary/pi-fabric): TypeScript
 * kernel + QuickJS sandbox only. No Python kernel, MCP, agents, mesh, or memory.
 */
import { highlightCode, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { installToolCapture } from "./capture.ts";
import { buildDeclarations } from "./declarations.ts";
import { createDispatcher } from "./dispatch.ts";
import {
	applyOutputBudget,
	FAILURE_BUDGET_CHARS,
	formatDisplayValue,
	formatValue,
	SUCCESS_BUDGET_CHARS,
	truncateDisplay,
} from "./output.ts";
import { execute } from "./quickjs.ts";
import { renderCodeResult } from "./render.ts";
import { typeCheckGuestCode } from "./type-checker.ts";

const TOOL_NAME = "code_exec";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

const DESCRIPTION = `Run a TypeScript program that calls Pi's tools. Prefer this over separate tool calls whenever a task needs more than one call, a loop, a conditional, or data flow between calls.

The program is an async function body: top-level await and return are supported. Globals:
  pi.read/bash/edit/write/grep/find/ls — Pi core tools
  extensions.<tool>(args)             — tools registered by other extensions
  tools.list/describe/call            — discovery, plus calling a ref computed at runtime
  π.<key>                             — strings passed in the payloads parameter
  print(...)                          — log a line (returned alongside the result)

Independent calls run in parallel with Promise.all. Intermediate values stay in the sandbox: only the returned value reaches the conversation, so filter and project before returning. The code is type-checked before it runs; type errors come back with line numbers instead of executing.

The sandbox contains the program, not its effects: a nested pi.bash/write/edit does exactly what the top-level tool would do, without a separate approval prompt per call. Write programs whose effects you would be willing to run as individual tool calls.

Example:
  const [pkg, sources] = await Promise.all([
    pi.read({ path: "package.json" }),
    pi.find({ pattern: "**/*.ts", path: "src" }),
  ]);
  return { name: JSON.parse(pkg).name, files: sources.split("\\n").filter(Boolean).length };`;

/**
 * Models reliably produce a few near-miss shapes at the highest-entropy point
 * of a long code string. Repairing beats a zero-work rejection round trip.
 */
const prepareArguments = (raw: unknown): Record<string, unknown> => {
	const args = (raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {}) as Record<
		string,
		unknown
	>;
	if (typeof raw === "string") args.code = raw;
	if (Array.isArray(args.code) && args.code.every((line) => typeof line === "string")) {
		args.code = args.code.join("\n");
	}
	if (typeof args.payloads === "string") {
		try {
			const parsed = JSON.parse(args.payloads);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args.payloads = parsed;
			else delete args.payloads;
		} catch {
			delete args.payloads;
		}
	}
	if (args.payloads && typeof args.payloads === "object") {
		// A non-string payload value would land in the guest as "[object Object]".
		args.payloads = Object.fromEntries(
			Object.entries(args.payloads as Record<string, unknown>).map(([key, value]) => [
				key,
				typeof value === "string" ? value : formatValue(value),
			]),
		);
	}
	for (const key of ["payloads", "timeoutMs"]) {
		if (args[key] === null) delete args[key];
	}
	if (typeof args.timeoutMs === "string" && Number.isFinite(Number(args.timeoutMs))) {
		args.timeoutMs = Number(args.timeoutMs);
	}
	return args;
};

export default function codeMode(pi: ExtensionAPI): void {
	// Capture patches the host's ExtensionRunner; if that fails, core pi.* still
	// works, so degrade to an empty extensions surface instead of taking pi down.
	const capturedPromise = installToolCapture(TOOL_NAME).catch(() => ({
		list: () => [],
		get: () => undefined,
	}));

	pi.registerTool({
		name: TOOL_NAME,
		label: "code mode",
		description: DESCRIPTION,
		parameters: Type.Object({
			code: Type.String({ description: "TypeScript function body. Top-level await and return supported." }),
			payloads: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description:
						"Named strings exposed as π.<key>. Use for large or quote-heavy content instead of escaping it inside code.",
				}),
			),
			timeoutMs: Type.Optional(
				Type.Number({ description: `Execution timeout. Default ${DEFAULT_TIMEOUT_MS}ms.` }),
			),
		}),
		prepareArguments: prepareArguments as any,
		renderCall(args, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const code = args.code ?? "";
			const title = theme.fg("toolTitle", theme.bold("code mode"));
			const highlighted = highlightCode(code, "typescript").join("\n");
			component.setText(highlighted ? `${title}\n\n${highlighted}` : `${title} ${theme.fg("toolOutput", "...")}`);
			return component;
		},
		renderResult(result, { expanded }, theme) {
			const displayText = (result.details as { displayText?: unknown } | undefined)?.displayText;
			const output =
				typeof displayText === "string"
					? displayText
					: result.content
							.filter((item): item is { type: "text"; text: string } => item.type === "text")
							.map((item) => item.text)
							.join("\n");
			return renderCodeResult(output.trim(), expanded, theme);
		},
		async execute(toolCallId, params, signal, _onUpdate, context: ExtensionContext) {
			const tools = await capturedPromise;
			const declarations = buildDeclarations(tools.list());

			const checked = typeCheckGuestCode(params.code, declarations);
			if (checked.errors.length > 0) {
				const detail = checked.errors
					.map((error) => `line ${error.line}, column ${error.column}: ${error.message}`)
					.join("\n");
				const { text } = applyOutputBudget(
					`TypeScript check failed — the program did not run.\n${detail}`,
					FAILURE_BUDGET_CHARS,
				);
				return { content: [{ type: "text" as const, text }], isError: true, details: undefined };
			}

			const dispatcher = createDispatcher({
				cwd: context.cwd ?? process.cwd(),
				captured: tools,
				context,
				toolCallId,
			});

			const timeoutMs = Math.min(
				MAX_TIMEOUT_MS,
				Math.max(1, Math.floor(params.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
			);
			const result = await execute(params.code, dispatcher.hostCall, {
				payloads: params.payloads,
				timeoutMs,
				memoryLimitBytes: MEMORY_LIMIT_BYTES,
				transpiledCode: checked.javascript,
				signal,
			});

			const logs = result.logs.length > 0 ? `${result.logs.join("\n")}\n` : "";
			const failed = result.terminationReason !== "completed";
			const emptyResult = "(program returned no value)";
			const body = failed
				? `${logs}${result.error ?? "Execution failed"}`
				: `${logs}${formatValue(result.value)}`.trim() || emptyResult;
			const displayBody = failed
				? body
				: `${logs}${formatDisplayValue(result.value)}`.trim() || emptyResult;
			const { text } = applyOutputBudget(
				body,
				failed ? FAILURE_BUDGET_CHARS : SUCCESS_BUDGET_CHARS,
			);
			return {
				content: [{ type: "text" as const, text }],
				isError: failed,
				details: {
					terminationReason: result.terminationReason,
					nestedCalls: dispatcher.callCount,
					displayText: truncateDisplay(
						displayBody,
						failed ? FAILURE_BUDGET_CHARS : SUCCESS_BUDGET_CHARS,
					),
				},
			};
		},
	});
}
