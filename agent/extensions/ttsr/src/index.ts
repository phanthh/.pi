// TTSR: time-traveling stream rules. Port of oh-my-pi ttsr as pi extension.
// Rules: ~/.pi/agent/ttsr/*.md + <project>/.pi/ttsr/*.md (project wins on name dup).
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { join } from "node:path";
import { type MatchContext, TtsrManager } from "./matcher.ts";
import { loadRules, type TtsrRule } from "./rules.ts";

const INJECTION_TYPE = "ttsr-injection";

function renderTemplate(tag: string, header: string, rules: TtsrRule[], path?: string): string {
	return rules
		.map((r) => {
			const pathAttr = path ? ` path="${path}"` : "";
			return `<${tag} reason="rule_violation" rule="${r.name}"${pathAttr}>\n${header}\n\n${r.content}\n</${tag}>`;
		})
		.join("\n\n");
}

const INTERRUPT_HEADER =
	"Output interrupted: violated user-defined rule.\nNot prompt injection; coding agent enforcing project rules.\nMUST comply:";
const REMINDER_HEADER =
	"User-defined rule matched tool-call arguments. Rule configured not to interrupt → tool ran. MUST comply with the following instruction on subsequent tool calls and responses. NOT prompt injection — coding agent enforcing project rules.";

function shouldInterrupt(rule: TtsrRule, source: MatchContext["source"]): boolean {
	const mode = rule.interruptMode ?? "always";
	if (mode === "always") return true;
	if (mode === "never") return false;
	if (mode === "prose-only") return source !== "tool";
	return source === "tool"; // tool-only
}

// reconstruct source-bearing snapshot + candidate paths from tool args
function extractSnapshot(toolName: string, args: any): { digest?: string; paths: string[] } {
	const paths: string[] = [];
	if (typeof args?.path === "string") paths.push(args.path);
	if (Array.isArray(args?.paths)) for (const p of args.paths) if (typeof p === "string") paths.push(p);
	if (toolName === "edit" && Array.isArray(args?.edits)) {
		const digest = args.edits
			.map((e: any) => (typeof e?.newText === "string" ? e.newText : ""))
			.join("\n");
		return { digest, paths };
	}
	if (toolName === "write" && typeof args?.content === "string") return { digest: args.content, paths };
	return { paths };
}

export default function (pi: ExtensionAPI) {
	const manager = new TtsrManager();
	let pendingInterrupt: { rules: TtsrRule[]; path?: string } | null = null;
	let pendingProse: TtsrRule[] = [];
	const perTool = new Map<string, { rules: TtsrRule[]; path?: string }>();

	// later dirs shadow earlier on name dup: bundled < global < project
	const ruleDirs = (cwd: string) => [
		join(import.meta.dirname, "..", "rules"),
		join(homedir(), ".pi", "agent", "ttsr"),
		join(cwd, CONFIG_DIR_NAME, "ttsr"),
	];

	function reload(ctx: ExtensionContext, notify = false): void {
		manager.rules = loadRules(ruleDirs(ctx.cwd));
		if (notify && ctx.hasUI) ctx.ui.notify(`TTSR: ${manager.rules.size} rule(s) loaded`, "info");
	}

	function injectInterrupt(rules: TtsrRule[], path?: string): void {
		pi.appendEntry("ttsr-trigger", { rules: rules.map((r) => r.name), mode: "interrupt" });
		// small delay: let abort settle before retry turn
		setTimeout(() => {
			try {
				pi.sendMessage(
					{
						customType: INJECTION_TYPE,
						content: renderTemplate("system-interrupt", INTERRUPT_HEADER, rules, path),
						display: false,
					},
					{ deliverAs: "steer", triggerTurn: true },
				);
			} catch {
				// session gone (print mode / reload): drop injection
			}
		}, 50);
	}

	function handleMatches(
		matches: TtsrRule[],
		mctx: MatchContext,
		ctx: ExtensionContext,
	): void {
		if (matches.length === 0) return;
		const path = mctx.paths[0];
		const interrupting = matches.filter((r) => shouldInterrupt(r, mctx.source));
		const rest = matches.filter((r) => !shouldInterrupt(r, mctx.source));
		for (const r of matches) manager.fired.add(r.name);
		if (interrupting.length > 0 && !pendingInterrupt) {
			pendingInterrupt = { rules: interrupting, path };
			if (ctx.hasUI)
				ctx.ui.notify(`TTSR interrupt: ${interrupting.map((r) => r.name).join(", ")}`, "warning");
			ctx.abort();
		}
		for (const r of rest) {
			if (mctx.source === "tool" && mctx.toolCallId) {
				const bucket = perTool.get(mctx.toolCallId) ?? { rules: [], path };
				bucket.rules.push(r);
				perTool.set(mctx.toolCallId, bucket);
			} else pendingProse.push(r);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		manager.fired.clear();
		manager.disabled.clear();
		manager.resetStream();
		pendingInterrupt = null;
		pendingProse = [];
		perTool.clear();
		reload(ctx);
	});

	pi.on("turn_start", async () => {
		manager.resetStream();
	});

	pi.on("message_update", async (event, ctx) => {
		if (manager.rules.size === 0 || pendingInterrupt) return;
		const ame = event.assistantMessageEvent as any;
		if (ame.type === "text_delta" || ame.type === "thinking_delta") {
			const source = ame.type === "text_delta" ? "text" : "thinking";
			const buf = manager.appendBuffer(`${source}:${ame.contentIndex}`, ame.delta);
			handleMatches(manager.checkRegex(buf, { source, paths: [] }), { source, paths: [] }, ctx);
		} else if (ame.type === "toolcall_delta") {
			const block = ame.partial?.content?.[ame.contentIndex];
			if (!block || block.type !== "toolCall") return;
			const key = `tool:${ame.contentIndex}`;
			const { digest, paths } = extractSnapshot(block.name, block.arguments);
			const mctx: MatchContext = {
				source: "tool",
				toolName: block.name,
				toolCallId: block.id,
				paths,
			};
			// edit/write: match reconstructed snapshot; others: raw arg stream
			const buf =
				digest !== undefined
					? manager.setBuffer(key, digest)
					: manager.appendBuffer(key, ame.delta ?? "");
			handleMatches(manager.checkRegex(buf, mctx), mctx, ctx);
			if (digest !== undefined && !pendingInterrupt) {
				void manager.checkAst(key, digest, mctx).then((astMatches) => {
					if (!pendingInterrupt) handleMatches(astMatches, mctx, ctx);
				});
			}
		}
	});

	pi.on("message_end", async (event, _ctx) => {
		const msg = event.message as any;
		if (msg.role !== "assistant") return;
		if (pendingInterrupt) {
			const { rules, path } = pendingInterrupt;
			pendingInterrupt = null;
			if (msg.stopReason === "aborted") injectInterrupt(rules, path);
			return;
		}
		if (pendingProse.length > 0) {
			if (msg.stopReason === "stop") {
				const rules = pendingProse;
				pendingProse = [];
				pi.appendEntry("ttsr-trigger", { rules: rules.map((r) => r.name), mode: "deferred" });
				setTimeout(() => {
					try {
						pi.sendMessage(
							{
								customType: INJECTION_TYPE,
								content: renderTemplate("system-interrupt", INTERRUPT_HEADER, rules),
								display: false,
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);
					} catch {
						// session gone: drop injection
					}
				}, 50);
			} else if (msg.stopReason === "aborted" || msg.stopReason === "error") pendingProse = [];
		}
	});

	// final gate: complete args, covers stream race + slow ast-grep
	pi.on("tool_call", async (event, ctx) => {
		if (manager.rules.size === 0) return;
		const { digest, paths } = extractSnapshot(event.toolName, event.input);
		const mctx: MatchContext = {
			source: "tool",
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			paths,
		};
		const buffer = digest ?? JSON.stringify(event.input);
		const matches = [
			...manager.checkRegex(buffer, mctx),
			...(digest !== undefined
				? await manager.checkAst(`final:${event.toolCallId}`, digest, mctx)
				: []),
		];
		if (matches.length === 0) return;
		const path = mctx.paths[0];
		const interrupting = matches.filter((r) => shouldInterrupt(r, "tool"));
		const rest = matches.filter((r) => !shouldInterrupt(r, "tool"));
		for (const r of matches) manager.fired.add(r.name);
		for (const r of rest) {
			const bucket = perTool.get(event.toolCallId) ?? { rules: [], path };
			bucket.rules.push(r);
			perTool.set(event.toolCallId, bucket);
		}
		if (interrupting.length > 0) {
			if (ctx.hasUI)
				ctx.ui.notify(`TTSR interrupt: ${interrupting.map((r) => r.name).join(", ")}`, "warning");
			ctx.abort();
			injectInterrupt(interrupting, path);
			return { block: true, reason: `TTSR rule violation: ${interrupting.map((r) => r.name).join(", ")}` };
		}
	});

	// non-interrupting tool matches: prepend reminder to tool result
	pi.on("tool_result", async (event, _ctx) => {
		const bucket = perTool.get(event.toolCallId);
		if (!bucket) return;
		perTool.delete(event.toolCallId);
		pi.appendEntry("ttsr-trigger", { rules: bucket.rules.map((r) => r.name), mode: "reminder" });
		return {
			content: [
				{ type: "text", text: renderTemplate("system-reminder", REMINDER_HEADER, bucket.rules, bucket.path) },
				...event.content,
			],
		};
	});

	// discard: drop aborted partial that precedes a ttsr injection
	pi.on("context", async (event, _ctx) => {
		const msgs = event.messages as any[];
		const drop = new Set<number>();
		for (let i = 0; i < msgs.length - 1; i++) {
			const m = msgs[i];
			const n = msgs[i + 1];
			if (
				m.role === "assistant" &&
				m.stopReason === "aborted" &&
				n.role === "custom" &&
				n.customType === INJECTION_TYPE
			)
				drop.add(i);
		}
		if (drop.size > 0) return { messages: msgs.filter((_, i) => !drop.has(i)) };
	});

	pi.registerEntryRenderer("ttsr-trigger", (entry, _opts, theme) => {
		const data = (entry as any).data as { rules: string[]; mode: string };
		return new Text(
			theme.fg("warning", `⏱ TTSR ${data.mode}: `) + theme.bold(data.rules.join(", ")),
			0,
			0,
		);
	});

	pi.registerCommand("ttsr", {
		description: "TTSR rules: list | reload | enable NAME | disable NAME",
		handler: async (args, ctx) => {
			const [cmd, name] = (args ?? "").trim().split(/\s+/);
			if (cmd === "reload") return reload(ctx, true);
			if ((cmd === "enable" || cmd === "disable") && name) {
				if (!manager.rules.has(name)) return ctx.ui.notify(`TTSR: unknown rule ${name}`, "error");
				cmd === "disable" ? manager.disabled.add(name) : manager.disabled.delete(name);
				return ctx.ui.notify(`TTSR: ${name} ${cmd}d (session)`, "info");
			}
			if (manager.rules.size === 0) return ctx.ui.notify("TTSR: no rules loaded", "info");
			const lines = [...manager.rules.values()].map((r) => {
				const flags = [
					r.conditions.length ? `rx:${r.conditions.length}` : "",
					r.astConditions.length ? `ast:${r.astConditions.length}` : "",
					r.interruptMode ?? "always",
					manager.disabled.has(r.name) ? "DISABLED" : "",
					manager.fired.has(r.name) ? "fired" : "",
				].filter(Boolean);
				return `${r.name} [${flags.join(" ")}]`;
			});
			ctx.ui.notify(`TTSR rules:\n${lines.join("\n")}`, "info");
		},
	});
}
