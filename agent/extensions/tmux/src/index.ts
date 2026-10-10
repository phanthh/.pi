/**
 * tmux extension — gives the agent named panes for long-running processes.
 *
 * Actions:
 *   run   — create a named pane (next depth column, see tmux-layout) and run a command in it
 *           (always watch completion, save a snapshot in the session folder, close the pane,
 *            and steer the snapshot path + exit code back to the agent)
 *   read  — capture output from a named pane
 *   send  — send keys to a named pane (C-c, Enter, q, etc.)
 *   stop  — save a snapshot and close a named pane
 *   list  — list all managed panes
 *
 * Panes are tagged with @pi_name tmux user options for discovery.
 * The tool is disabled when not running inside tmux, or when pi is running inside herdr.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { closeWorkerPane, createWorkerPane, isPaneAlive } from "@pi-ext/tmux-layout";
import { blockReason, findBlockedTmuxCommand } from "./guard.ts";
import { registerResurrect } from "./resurrect.ts";

interface PaneInfo {
	name: string;
	paneId: string;
	alive: boolean;
	command: string;
	pid: string;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

// Strip ANSI escapes, OSC sequences, and tmux/wezterm wrapping
function stripAnsi(text: string): string {
	return (
		text
			// OSC sequences (e.g. \x1b]...\x07 or \x1b]...\x1b\\)
			.replace(/\x1b\].*?(?:\x07|\x1b\\)/g, "")
			// tmux passthrough (\x1bPtmux;...\x1b\\)
			.replace(/\x1bPtmux;.*?\x1b\\/g, "")
			// CSI sequences (\x1b[...letter)
			.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
			// Remaining bare escapes
			.replace(/\x1b[^[\]P]/g, "")
			// Carriage returns (terminal rewrite lines)
			.replace(/\r/g, "")
	);
}

export default function (pi: ExtensionAPI) {
	const inTmux = !!process.env.TMUX;
	const inHerdr = !!process.env.HERDR_ENV;
	if (!inTmux || inHerdr) {
		return;
	}

	registerResurrect(pi);

	// Windows/sessions are user-managed: block agent shell-outs that create/kill/move them.
	pi.on("tool_call", (event) => {
		const input = event.input as Record<string, unknown>;
		const cmd = event.toolName === "bash" || event.toolName === "tmux" ? input.command : undefined;
		if (typeof cmd !== "string") return;
		const sub = findBlockedTmuxCommand(cmd);
		if (sub) return { block: true, reason: blockReason(sub) };
	});

	let myPaneId: string | null = null;
	let myWindowId: string | null = null;
	// paneId → wait-for channel of an active completion watcher
	const watchers = new Map<string, string>();
	interface PaneRun {
		pane: string;
		paneId: string;
		command: string;
		started: number;
		fullOutputPath: string;
		statusPath?: string;
		scriptPath?: string;
		result?: Promise<{ exitCode: number; elapsed: number; fullOutputPath: string }>;
	}
	const runs = new Map<string, PaneRun>();
	// tmux-subagents' child.ts holds auto-exit while any of these are pending.
	(globalThis as any)[Symbol.for("pi-tmux/auto-exit-watchers")] = watchers;

	function finishPane(run: PaneRun, reason = "finished") {
		if (run.result) return run.result;
		const pending = (async () => {
			let exitCode = -1;
			if (run.statusPath) {
				try {
					const status = (await readFile(run.statusPath, "utf8")).trim();
					if (/^\d+$/.test(status)) exitCode = Number(status);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			// Never close before the snapshot is safely on disk.
			const output = await capturePane(run.paneId);
			await writeFile(run.fullOutputPath, output, { mode: 0o600 });
			if (isPaneAlive(run.paneId)) closeWorkerPane(run.paneId);
			const channel = watchers.get(run.paneId);
			if (channel && reason !== "finished") await pi.exec("tmux", ["wait-for", "-S", channel]);
			for (const path of [run.scriptPath, run.statusPath]) {
				if (path) await rm(path, { force: true }).catch(() => {});
			}
			const result = {
				exitCode,
				elapsed: Math.round((Date.now() - run.started) / 1000),
				fullOutputPath: run.fullOutputPath,
			};
			// Delete right before steering: a subagent may auto-exit once this hits 0.
			runs.delete(run.paneId);
			watchers.delete(run.paneId);
			pi.sendMessage(
				{
					customType: "tmux_result",
					content: `tmux pane '${run.pane}' ${reason}: '${run.command}' (exit ${exitCode}, ${result.elapsed}s). Pane closed.\nSnapshot: ${run.fullOutputPath}\nUse the read tool with this path to inspect pane content.`,
					display: true,
					details: { pane: run.pane, command: run.command, ...result },
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
			return result;
		})();
		run.result = pending;
		void pending.catch(() => {
			if (run.result === pending) run.result = undefined;
		});
		return pending;
	}

	async function snapshotDirectory(sessionDir: string): Promise<string> {
		await mkdir(sessionDir, { recursive: true, mode: 0o700 });
		return mkdtemp(join(sessionDir, "tmux-"));
	}

	async function killPane(pane: PaneInfo, sessionDir: string) {
		if (pane.paneId === myPaneId) throw new Error("Refusing to kill the pane pi is running in.");
		let run = runs.get(pane.paneId);
		if (!run) {
			const dir = await snapshotDirectory(sessionDir);
			run = {
				pane: pane.name, paneId: pane.paneId, command: pane.command,
				started: Date.now(), fullOutputPath: `${dir}/output.txt`,
			};
			runs.set(pane.paneId, run);
		}
		return finishPane(run, "stopped (stop/restart)");
	}

	// Discover our own pane/window/session on startup
	pi.on("session_start", async () => {
		try {
			const result = await pi.exec("tmux", [
				"display-message",
				"-p",
				"-t",
				process.env.TMUX_PANE || "",
				"#{pane_id}\t#{window_id}\t#{session_id}",
			]);
			if (result.code === 0) {
				const [paneId, windowId] = result.stdout.trim().split("\t");
				myPaneId = paneId || null;
				myWindowId = windowId || null;
			}
		} catch {}
	});

	// --- helpers ---

	function requireWindowTarget(): string {
		if (!myWindowId) throw new Error("Could not determine current tmux window.");
		return myWindowId;
	}

	async function findPane(name: string): Promise<PaneInfo | null> {
		const result = await pi.exec("tmux", [
			"list-panes",
			"-t",
			requireWindowTarget(),
			"-F",
			"#{pane_id}\t#{@pi_name}\t#{pane_current_command}\t#{pane_pid}\t#{pane_dead}",
		]);
		if (result.code !== 0) return null;

		for (const line of result.stdout.trim().split("\n")) {
			const [paneId, paneName, command, pid, dead] = line.split("\t");
			if (paneName === name) {
				return { name: paneName, paneId, alive: dead !== "1", command, pid };
			}
		}
		return null;
	}

	async function listAllPanes(): Promise<PaneInfo[]> {
		const result = await pi.exec("tmux", [
			"list-panes",
			"-t",
			requireWindowTarget(),
			"-F",
			"#{pane_id}\t#{@pi_name}\t#{pane_current_command}\t#{pane_pid}\t#{pane_dead}",
		]);
		if (result.code !== 0) return [];

		const panes: PaneInfo[] = [];
		for (const line of result.stdout.trim().split("\n")) {
			if (!line.trim()) continue;
			const [paneId, paneName, command, pid, dead] = line.split("\t");
			// Skip pi's own pane
			if (paneId === myPaneId) continue;
			panes.push({
				name: paneName?.trim() || "",
				paneId,
				alive: dead !== "1",
				command,
				pid,
			});
		}
		return panes;
	}

	async function capturePane(paneId: string, lines?: number): Promise<string> {
		const result = await pi.exec("tmux", ["capture-pane", "-t", paneId, "-p", "-J", "-S", lines === undefined ? "-" : `-${lines}`]);
		if (result.code !== 0) throw new Error(`capture-pane failed: ${result.stderr}`);

		let output = stripAnsi(result.stdout);
		// Trim trailing blank lines (tmux pads to pane height)
		output = output.replace(/\n+$/, "\n");
		return output;
	}

	// --- tool ---

	pi.registerTool({
		name: "tmux",
		label: "tmux",
		description:
			"Manage tmux panes for long-running processes (dev servers, watchers, etc). " +
			"Actions: run (start command in named pane), read (capture output), send (send keys like C-c), stop (snapshot and close pane), list (show panes). " +
			"All commands automatically close their pane on completion and deliver exit code + snapshot path in the current session folder. Use the read tool on that path for results.",
		promptGuidelines: [
			"Use `tmux` run for long-running processes (dev servers, watchers, builds) instead of `bash`.",
			"Use `bash` only for short-lived commands that complete quickly.",
			"Every tmux run automatically delivers completion + a snapshot file path; do not poll for completion. Read the snapshot with the read tool.",
			"Never create, kill, or move tmux windows (tabs) or sessions (`tmux new-window`, `new-session`, `break-pane`, `kill-window`, ...). They are user-managed; such commands are blocked. Use this tool's panes instead.",
			"Layout: one full-height column per spawn depth, left to right: pi | its panes (tmux tool + subagents) | their panes | … Each column stacks vertically, auto-rebalanced to equal heights.",
		],
		parameters: Type.Object({
			action: StringEnum(["run", "read", "send", "stop", "list"] as const, {
				description: "Action to perform",
			}),
			pane: Type.Optional(Type.String({ description: "Pane name (required for run/read/send/stop)" })),
			command: Type.Optional(Type.String({ description: "Bash command to run (for run action)" })),
			keys: Type.Optional(
				Type.String({
					description: "Keys to send, space-separated (for send action). Examples: C-c, Enter, q, y",
				}),
			),
			text: Type.Optional(
				Type.String({
					description: "Literal text to type into the pane (for send action). Sent as-is, no key lookup.",
				}),
			),
			lines: Type.Optional(
				Type.Number({ description: "Scrollback lines to capture (for read action, default: 20)" }),
			),
			restart: Type.Optional(
				Type.Boolean({ description: "Kill existing pane before starting (for run action, default: false)" }),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory (for run action)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { action } = params;

			switch (action) {
				case "run": {
					const { pane, command, restart, cwd } = params;
					if (!pane) throw new Error("'pane' is required for run");
					if (!command) throw new Error("'command' is required for run");

					const existing = await findPane(pane);
					if (existing?.alive && !restart) {
						throw new Error(
							`Pane '${pane}' already exists (running ${existing.command}). Use restart: true to replace it.`,
						);
					}
					if (existing) await killPane(existing, ctx.sessionManager.getSessionDir());

					const dir = await snapshotDirectory(ctx.sessionManager.getSessionDir());
					let newPaneId: string;
					try {
						newPaneId = createWorkerPane({
							title: pane,
							tag: { key: "@pi_name", value: pane },
							cwd,
						});
					} catch (error) {
						await rm(dir, { recursive: true, force: true });
						throw error;
					}
					const channel = `pi-tmux-${newPaneId.slice(1)}-${Date.now()}`;
					const run: PaneRun = {
						pane, paneId: newPaneId, command, started: Date.now(),
						fullOutputPath: join(dir, "output.txt"),
						statusPath: join(dir, "exit-code"),
						scriptPath: join(dir, "command.sh"),
					};
					runs.set(newPaneId, run);
					// The outer EXIT trap also reports syntax errors, exit, exec and C-c.
					// The command's subshell waits for background jobs before completion.
					const script = `status_file=${shellQuote(run.statusPath!)}
channel=${shellQuote(channel)}
trap 'status=$?; printf "%s\\n" "$status" > "$status_file"; tmux wait-for -S "$channel"' EXIT
trap ':' INT
(
trap 'wait' EXIT
${command}
)
`;
					try {
						await writeFile(run.scriptPath!, script, { mode: 0o600 });
						watchers.set(newPaneId, channel);
						// Register before Enter so even immediately finishing commands are caught.
						void pi.exec("tmux", ["wait-for", channel])
							.then((result) => {
								if (result.code !== 0) throw new Error(`wait-for failed: ${result.stderr}`);
								return finishPane(run);
							})
							.catch((error) => {
								watchers.delete(newPaneId);
								pi.sendMessage(
									{
										customType: "tmux_result",
										content: `tmux pane '${pane}' watcher error: ${String(error)}. Pane may still be open; inspect it with tmux read/list.`,
										display: true,
										details: { pane, command, exitCode: -1, elapsed: 0, error: String(error) },
									},
									{ triggerTurn: true, deliverAs: "steer" },
								);
							});
						for (const args of [
							["send-keys", "-l", "-t", newPaneId, `bash ${shellQuote(run.scriptPath!)}`],
							["send-keys", "-t", newPaneId, "Enter"],
						]) {
							const result = await pi.exec("tmux", args);
							if (result.code !== 0) throw new Error(`send-keys failed: ${result.stderr}`);
						}
					} catch (error) {
						await finishPane(run, "failed to start");
						throw error;
					}

					return {
						content: [{
							type: "text",
							text: `Started '${command}' in pane '${pane}' (${newPaneId}). Completion will be delivered automatically; do not poll.\nFinal snapshot will be saved to: ${run.fullOutputPath}\nUse the read tool with this path after completion.`,
						}],
						details: { action: "run", pane, paneId: newPaneId, command, fullOutputPath: run.fullOutputPath },
					};
				}

				case "read": {
					const { pane, lines } = params;
					if (!pane) throw new Error("'pane' is required for read");

					const existing = await findPane(pane);
					if (!existing) throw new Error(`Pane '${pane}' not found. Use action 'list' to see managed panes.`);

					const output = await capturePane(existing.paneId, lines ?? 20);

					const truncation = truncateTail(output, {
						maxLines: DEFAULT_MAX_LINES,
						maxBytes: DEFAULT_MAX_BYTES,
					});

					let text = truncation.content;
					if (truncation.truncated) {
						text = `[Showing last ${truncation.outputLines} of ${truncation.totalLines} lines]\n${text}`;
					}

					return {
						content: [{ type: "text", text }],
						details: { action: "read", pane, alive: existing.alive, command: existing.command },
					};
				}

				case "send": {
					const { pane, keys, text } = params;
					if (!pane) throw new Error("'pane' is required for send");
					if (!keys && !text) throw new Error("'keys' or 'text' is required for send");

					const existing = await findPane(pane);
					if (!existing) throw new Error(`Pane '${pane}' not found.`);

					// Send literal text first (if provided)
					if (text) {
						await pi.exec("tmux", ["send-keys", "-l", "-t", existing.paneId, text]);
					}

					// Then send special keys (if provided)
					if (keys) {
						const keyArgs = keys.split(/\s+/).filter(Boolean);
						await pi.exec("tmux", ["send-keys", "-t", existing.paneId, ...keyArgs]);
					}

					const desc = [text && `"${text}"`, keys].filter(Boolean).join(" + ");
					return {
						content: [{ type: "text", text: `Sent ${desc} to pane '${pane}'` }],
						details: { action: "send", pane, keys, text },
					};
				}

				case "stop": {
					const { pane } = params;
					if (!pane) throw new Error("'pane' is required for stop");

					const existing = await findPane(pane);
					if (!existing) throw new Error(`Pane '${pane}' not found.`);

					const result = await killPane(existing, ctx.sessionManager.getSessionDir());

					return {
						content: [{ type: "text", text: `Stopped pane '${pane}'. Snapshot: ${result.fullOutputPath}\nUse the read tool with this path to inspect pane content.` }],
						details: { action: "stop", pane, ...result },
					};
				}

				case "list": {
					const panes = await listAllPanes();

					if (panes.length === 0) {
						return {
							content: [{ type: "text", text: "No panes (besides pi)." }],
							details: { action: "list", panes: [] },
						};
					}

					const text = panes
						.map((p) => {
							const label = p.name || `[${p.command}]`;
							const managed = p.name ? "" : " (unmanaged)";
							return `${label}: ${p.alive ? "running" : "dead"} (${p.command}) [${p.paneId}]${managed}`;
						})
						.join("\n");

					return {
						content: [{ type: "text", text }],
						details: { action: "list", panes },
					};
				}

				default:
					throw new Error(`Unknown action: ${action}`);
			}
		},

		// --- rendering ---

		renderCall(args, theme) {
			const action = args.action || "?";
			let text = theme.fg("toolTitle", theme.bold("tmux "));
			text += theme.fg("accent", action);

			if (args.pane) text += theme.fg("muted", ` ${args.pane}`);
			if (args.command) text += theme.fg("dim", ` › ${args.command}`);
			if (args.text) text += theme.fg("dim", ` › "${args.text}"`);
			if (args.keys) text += theme.fg("dim", ` › ${args.keys}`);

			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as Record<string, any> | undefined;
			if (!details) {
				const c = result.content?.[0];
				return new Text(c?.type === "text" ? c.text : "", 0, 0);
			}

			switch (details.action) {
				case "run": {
					let t = theme.fg("success", `▶ ${details.pane}`);
					t += theme.fg("dim", ` › ${details.command}`);
					if (details.fullOutputPath) t += theme.fg("muted", `\nSnapshot on completion: ${details.fullOutputPath}`);
					return new Text(t, 0, 0);
				}

				case "read": {
					const dot = details.alive ? theme.fg("success", "●") : theme.fg("error", "●");
					let t = `${dot} ${theme.fg("accent", details.pane)}`;

					if (expanded) {
						const c = result.content?.[0];
						if (c?.type === "text") {
							const outputLines = c.text.split("\n").slice(0, 40);
							t += "\n" + outputLines.map((l: string) => theme.fg("dim", l)).join("\n");
							const total = c.text.split("\n").length;
							if (total > 40) {
								t += `\n${theme.fg("muted", `... (${total} total lines)`)}`;
							}
						}
					}
					return new Text(t, 0, 0);
				}

				case "send": {
					const desc = [details.text && `"${details.text}"`, details.keys].filter(Boolean).join(" + ");
					return new Text(theme.fg("accent", `⏎ ${details.pane} › ${desc}`), 0, 0);
				}

				case "stop": {
					let t = theme.fg("warning", `■ ${details.pane}`);
					if (details.fullOutputPath) t += theme.fg("dim", `\n${details.fullOutputPath}`);
					return new Text(t, 0, 0);
				}

				case "list": {
					const panes = details.panes as PaneInfo[];
					if (!panes?.length) return new Text(theme.fg("dim", "no panes"), 0, 0);

					const lines = panes.map((p) => {
						const dot = p.alive ? theme.fg("success", "●") : theme.fg("error", "●");
						const label = p.name
							? theme.fg("accent", p.name)
							: theme.fg("muted", `[${p.command}]`);
						const extra = p.name ? "" : theme.fg("dim", " (unmanaged)");
						return `${dot} ${label} ${theme.fg("dim", p.command)}${extra}`;
					});
					return new Text(lines.join("\n"), 0, 0);
				}

				default: {
					const c = result.content?.[0];
					return new Text(c?.type === "text" ? c.text : "", 0, 0);
				}
			}
		},
	});

	pi.registerMessageRenderer("tmux_result", (message, _options, theme) => {
		const d = message.details as { pane: string; command: string; exitCode: number; elapsed: number; fullOutputPath?: string; error?: string } | undefined;
		if (!d) return undefined;
		const ok = d.exitCode === 0;
		let t = theme.fg(ok ? "success" : "error", `${ok ? "✔" : "✖"} ${d.pane}`);
		t += theme.fg("dim", ` › ${d.command} (exit ${d.exitCode}, ${d.elapsed}s)`);
		if (d.fullOutputPath) t += theme.fg("dim", `\n${d.fullOutputPath}`);
		if (d.error) t += theme.fg("error", `\n${d.error}`);
		return new Text(t, 0, 0);
	});
}
