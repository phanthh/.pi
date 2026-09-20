/**
 * tmux extension — gives the agent named panes for long-running processes.
 *
 * Actions:
 *   run   — create a named pane (split right) and run a command in it
 *           (autoExit: true → wait for completion in background, steer
 *            output + exit code back to the agent, close the pane)
 *   read  — capture output from a named pane
 *   send  — send keys to a named pane (C-c, Enter, q, etc.)
 *   stop  — kill a named pane
 *   list  — list all managed panes
 *
 * Panes are tagged with @pi_name tmux user options for discovery.
 * The tool is disabled when not running inside tmux, or when pi is running inside herdr.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { closeWorkerPane, createWorkerPane, isPaneAlive } from "@pi-ext/tmux-layout";

interface PaneInfo {
	name: string;
	paneId: string;
	alive: boolean;
	command: string;
	pid: string;
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

	let myPaneId: string | null = null;
	let myWindowId: string | null = null;
	// paneId → wait-for channel of an active autoExit watcher
	const watchers = new Map<string, string>();

	// Kill pane; wake its autoExit watcher (if any) so it reports instead of hanging forever.
	async function killPane(paneId: string) {
		const ch = watchers.get(paneId);
		closeWorkerPane(paneId);
		if (ch) await pi.exec("tmux", ["wait-for", "-S", ch]);
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

	async function capturePane(paneId: string, lines: number): Promise<string> {
		const result = await pi.exec("tmux", ["capture-pane", "-t", paneId, "-p", "-S", `-${lines}`]);
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
			"Actions: run (start command in named pane), read (capture output), send (send keys like C-c), stop (kill pane), list (show panes).",
		promptGuidelines: [
			"Use `tmux` run for long-running processes (dev servers, watchers, builds) instead of `bash`.",
			"Use `bash` only for short-lived commands that complete quickly.",
			"Layout: pi runs on the left. Worker panes (tmux tool + subagents) share one column on the right, stacked vertically and auto-rebalanced to equal heights.",
		],
		parameters: Type.Object({
			action: StringEnum(["run", "read", "send", "stop", "list"] as const, {
				description: "Action to perform",
			}),
			pane: Type.Optional(Type.String({ description: "Pane name (required for run/read/send/stop)" })),
			command: Type.Optional(Type.String({ description: "Shell command to run (for run action)" })),
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
			autoExit: Type.Optional(
				Type.Boolean({
					description:
						"For run action: when the command finishes, close the pane and deliver its output + exit code back to you automatically (default: false). Use for one-shot commands like builds/tests; do not poll.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { action } = params;

			switch (action) {
				case "run": {
					const { pane, command, restart, cwd, autoExit } = params;
					if (!pane) throw new Error("'pane' is required for run");
					if (!command) throw new Error("'command' is required for run");

					const existing = await findPane(pane);

					// Dead pane → always replace. Alive pane → error unless restart.
					if (existing?.alive && !restart) {
						throw new Error(
							`Pane '${pane}' already exists (running ${existing.command}). Use restart: true to replace it.`,
						);
					}
					if (existing) {
						await killPane(existing.paneId);
					}

					// Unified layout: right column, stacked + rebalanced.
					const newPaneId = createWorkerPane({
						title: pane,
						tag: { key: "@pi_name", value: pane },
						cwd,
					});

					// autoExit: wrap so the shell prints an exit marker and signals a tmux channel when done.
					// trap INT: otherwise C-c makes the shell drop the rest of the line and the watcher hangs.
					const channel = `pi-tmux-${newPaneId.slice(1)}-${Date.now()}`;
					const shellCmd = autoExit
						? `trap ':' INT; ( ${command} ); printf '\\n[pi:exit %d]\\n' $?; trap - INT; tmux wait-for -S ${channel}`
						: command;

					// Send command (literal text + Enter)
					await pi.exec("tmux", ["send-keys", "-l", "-t", newPaneId, shellCmd]);
					await pi.exec("tmux", ["send-keys", "-t", newPaneId, "Enter"]);

					if (autoExit) {
						const started = Date.now();
						watchers.set(newPaneId, channel);
						pi.exec("tmux", ["wait-for", channel])
							.then(async () => {
								watchers.delete(newPaneId);
								if (!isPaneAlive(newPaneId)) {
									pi.sendMessage(
										{
											customType: "tmux_result",
											content: `tmux pane '${pane}' killed before '${command}' finished (stop/restart). No output captured.`,
											display: true,
											details: { pane, command, exitCode: -1, elapsed: Math.round((Date.now() - started) / 1000) },
										},
										{ triggerTurn: false },
									);
									return;
								}
								const full = await capturePane(newPaneId, 100000);
								// Last marker only; shell prompt may already be printed after it.
								const m = [...full.matchAll(/\[pi:exit (\d+)\]/g)].at(-1);
								const exitCode = m ? Number(m[1]) : -1;
								const output = m ? full.slice(0, m.index).replace(/\n+$/, "\n") : full;
								const truncation = truncateTail(output, {
									maxLines: DEFAULT_MAX_LINES,
									maxBytes: DEFAULT_MAX_BYTES,
								});
								let text = truncation.content;
								if (truncation.truncated) {
									text = `[Showing last ${truncation.outputLines} of ${truncation.totalLines} lines]\n${text}`;
								}
								const elapsed = Math.round((Date.now() - started) / 1000);
								if (isPaneAlive(newPaneId)) closeWorkerPane(newPaneId);
								pi.sendMessage(
									{
										customType: "tmux_result",
										content: `tmux pane '${pane}' finished: '${command}' (exit ${exitCode}, ${elapsed}s). Pane closed.\n\n${text}`,
										display: true,
										details: { pane, command, exitCode, elapsed },
									},
									{ triggerTurn: true, deliverAs: "steer" },
								);
							})
							.catch((err) => {
								watchers.delete(newPaneId);
								pi.sendMessage(
									{
										customType: "tmux_result",
										content: `tmux pane '${pane}' watcher error: ${err?.message ?? String(err)}`,
										display: true,
										details: { pane, command, exitCode: -1, elapsed: 0, error: String(err) },
									},
									{ triggerTurn: true, deliverAs: "steer" },
								);
							});
					}

					// Wait briefly and capture initial output
					await new Promise((r) => setTimeout(r, 1500));
					const initialOutput = isPaneAlive(newPaneId) ? await capturePane(newPaneId, 20) : "(already finished)";

					const hint = autoExit
						? "\n\n(autoExit: result will be delivered to you when the command finishes; do not poll.)"
						: "";
					return {
						content: [
							{
								type: "text",
								text: `Started '${command}' in pane '${pane}' (${newPaneId})${hint}\n\n${initialOutput}`,
							},
						],
						details: { action: "run", pane, paneId: newPaneId, command, autoExit: !!autoExit },
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

					if (existing.paneId === myPaneId) {
						throw new Error("Refusing to kill the pane pi is running in.");
					}

					await killPane(existing.paneId);

					return {
						content: [{ type: "text", text: `Stopped pane '${pane}'` }],
						details: { action: "stop", pane },
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
					if (details.autoExit) t += theme.fg("muted", " (autoExit)");
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
					return new Text(theme.fg("warning", `■ ${details.pane}`), 0, 0);
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
		const d = message.details as { pane: string; command: string; exitCode: number; elapsed: number } | undefined;
		if (!d) return undefined;
		const ok = d.exitCode === 0;
		let t = theme.fg(ok ? "success" : "error", `${ok ? "✔" : "✖"} ${d.pane}`);
		t += theme.fg("dim", ` › ${d.command} (exit ${d.exitCode}, ${d.elapsed}s)`);
		return new Text(t, 0, 0);
	});
}
