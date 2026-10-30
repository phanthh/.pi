/**
 * tmux extension — gives the agent named windows for long-running processes.
 *
 * Actions:
 *   run   — create a named detached window in pi's own tmux session and run a command in it
 *           (always watch completion, save a snapshot in the session folder, close the window,
 *            and steer the snapshot path + exit code back to the agent)
 *   read  — capture output from a named window
 *   send  — send keys to a named window (C-c, Enter, q, etc.)
 *   stop  — save a snapshot and close a named window
 *   list  — list this pi's windows
 *
 * Windows carry @pi_owner=<pi's TMUX_PANE> + @pi_name (see tmux-windows); each pi
 * sees only its own. The `pane` parameter keeps its name for schema stability.
 * The tool is disabled when not running inside tmux, or when pi is running inside herdr.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { closeWindow, createWindow, isPaneAlive, ownedWindows, userShell, viaUserShell } from "@pi-ext/tmux-windows";
import { blockReason, findBlockedTmuxCommand } from "./guard.ts";
import { registerResurrect } from "./resurrect.ts";

interface PaneInfo {
	name: string;
	paneId: string;
	command: string;
}

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

interface SharedState {
	api?: ExtensionAPI;
	runs: Map<string, PaneRun>;
	/** paneId → wait-for channel of an active completion watcher */
	watchers: Map<string, string>;
	sweep?: NodeJS.Timeout;
	sweepNow?: () => void;
}

// v2: runs are managed windows. Pre-window (pane) state stays under the old key, handled by its own closures.
const STATE_KEY = Symbol.for("pi-tmux/state-v2");
const SWEEP_INTERVAL_MS = 2000;

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

	const myPaneId = process.env.TMUX_PANE;
	// Runs outlive this extension instance: after /reload or a session switch the old `pi`
	// is stale (its exec/sendMessage throw), so pending runs always report via the latest one.
	const g = globalThis as any;
	const state: SharedState = (g[STATE_KEY] ??= { runs: new Map(), watchers: new Map() });
	state.api = pi;
	const api = () => state.api!;
	const { runs, watchers } = state;
	// tmux-subagents' child.ts holds auto-exit while any of these are pending.
	g[Symbol.for("pi-tmux/auto-exit-watchers")] = watchers;

	// Fallback when the wait-for signal is lost, or the pane is closed outside this tool:
	// otherwise the result is never delivered and the pane counts as pending forever.
	state.sweepNow = () => {
		for (const run of runs.values()) {
			if (run.result || !run.statusPath) continue;
			const gone = !isPaneAlive(run.paneId);
			if (!gone && !existsSync(run.statusPath)) continue;
			void finishPane(run, gone ? "closed outside the tool" : "finished").catch(() => {});
		}
	};
	clearInterval(state.sweep);
	state.sweep = setInterval(state.sweepNow, SWEEP_INTERVAL_MS);
	state.sweep.unref();

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
			const alive = isPaneAlive(run.paneId);
			const output = alive ? await capturePane(run.paneId) : "(window was closed before its output could be captured)\n";
			await writeFile(run.fullOutputPath, output, { mode: 0o600 });
			if (alive) closeWindow(run.paneId);
			const channel = watchers.get(run.paneId);
			// Release a wait-for client the runner will never signal.
			if (channel && reason !== "finished") await api().exec("tmux", ["wait-for", "-S", channel]);
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
			api().sendMessage(
				{
					customType: "tmux_result",
					content: `tmux window '${run.pane}' ${reason}: '${run.command}' (exit ${exitCode}, ${result.elapsed}s). Window closed.\nSnapshot: ${run.fullOutputPath}\nUse the read tool with this path to inspect window content.`,
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

	// Quit: run windows would outlive pi with nobody to report to. Other reasons
	// keep them; the shared state delivers results through the next instance.
	pi.on("session_shutdown", (event) => {
		if (event.reason !== "quit") return;
		clearInterval(state.sweep);
		for (const w of ownedWindows("@pi_name")) closeWindow(w.paneId);
	});

	// --- helpers ---

	function listAllPanes(): PaneInfo[] {
		return ownedWindows("@pi_name")
			.filter((w) => w.paneId !== myPaneId)
			.map((w) => ({ name: w.tag, paneId: w.paneId, command: w.command }));
	}

	function findPane(name: string): PaneInfo | null {
		return listAllPanes().find((p) => p.name === name) ?? null;
	}

	async function capturePane(paneId: string, lines?: number): Promise<string> {
		const result = await api().exec("tmux", ["capture-pane", "-t", paneId, "-p", "-J", "-S", lines === undefined ? "-" : `-${lines}`]);
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
			"Manage named tmux windows for long-running processes (dev servers, watchers, etc). Windows open detached in your own tmux session. " +
			"Actions: run (start command in named window), read (capture output), send (send keys like C-c), stop (snapshot and close window), list (show your windows). " +
			"All commands automatically close their window on completion and deliver exit code + snapshot path in the current session folder. Use the read tool on that path for results.",
		promptGuidelines: [
			"Use `tmux` run for long-running processes (dev servers, watchers, builds) instead of `bash`.",
			"Use `bash` only for short-lived commands that complete quickly.",
			"Every tmux run automatically delivers completion + a snapshot file path; do not poll for completion. Read the snapshot with the read tool.",
			"Each run opens a detached window in your own tmux session; you see and control only windows you created. The `pane` param is the window name.",
			"Never create, kill, or move tmux windows or sessions via bash (`tmux new-window`, `new-session`, `break-pane`, `kill-window`, ...); such commands are blocked. Use this tool (windows) or `tmux_subagent` instead.",
		],
		parameters: Type.Object({
			action: StringEnum(["run", "read", "send", "stop", "list"] as const, {
				description: "Action to perform",
			}),
			pane: Type.Optional(Type.String({ description: "Window name (required for run/read/send/stop)" })),
			command: Type.Optional(Type.String({ description: "Bash command to run (for run action)" })),
			keys: Type.Optional(
				Type.String({
					description: "Keys to send, space-separated (for send action). Examples: C-c, Enter, q, y",
				}),
			),
			text: Type.Optional(
				Type.String({
					description: "Literal text to type into the window (for send action). Sent as-is, no key lookup.",
				}),
			),
			lines: Type.Optional(
				Type.Number({ description: "Scrollback lines to capture (for read action, default: 20)" }),
			),
			restart: Type.Optional(
				Type.Boolean({ description: "Kill existing window before starting (for run action, default: false)" }),
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

					const existing = findPane(pane);
					if (existing && !restart) {
						throw new Error(
							`Window '${pane}' already exists (running ${existing.command}). Use restart: true to replace it.`,
						);
					}
					if (existing) await killPane(existing, ctx.sessionManager.getSessionDir());

					const dir = await snapshotDirectory(ctx.sessionManager.getSessionDir());
					const channel = `pi-tmux-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
					const run: PaneRun = {
						pane, paneId: "", command, started: Date.now(),
						fullOutputPath: join(dir, "output.txt"),
						statusPath: join(dir, "exit-code"),
						scriptPath: join(dir, "command.sh"),
					};
					// The outer EXIT trap also reports syntax errors, exit, exec and C-c.
					// The command's subshell waits for background jobs before completion.
					// Panes have a TTY, so pagers would block unattended runs.
					// umask 0022: files must stay readable by containers (bind-mounted init scripts).
					const script = `umask 0022
export PAGER=cat GIT_PAGER=cat GH_PAGER=cat MANPAGER=cat SYSTEMD_PAGER= LESS=FRX
status_file=${shellQuote(run.statusPath!)}
channel=${shellQuote(channel)}
trap 'status=$?; printf "%s\\n" "$status" > "$status_file"; tmux wait-for -S "$channel"' EXIT
trap ':' INT
(
trap 'wait' EXIT
${command}
)
`;
					await writeFile(run.scriptPath!, script, { mode: 0o600 });
					// The window runs the script as its own command (inside an interactive shell, for
					// the user's rc env); the trailing shell keeps it open until finishPane captures it.
					const inner = `bash ${shellQuote(run.scriptPath!)}; exec ${shellQuote(userShell())}`;
					let newPaneId: string;
					try {
						newPaneId = createWindow({
							name: pane,
							tag: { key: "@pi_name", value: pane },
							cwd,
							command: viaUserShell(inner),
						});
					} catch (error) {
						await rm(dir, { recursive: true, force: true });
						throw error;
					}
					run.paneId = newPaneId;
					runs.set(newPaneId, run);
					watchers.set(newPaneId, channel);
					// A runner that finished before this registers already set the channel; wait-for returns at once.
					void api().exec("tmux", ["wait-for", channel])
						.then((result) => {
							if (result.code !== 0) throw new Error(`wait-for failed: ${result.stderr}`);
							return finishPane(run);
						})
						.catch((error) => {
							watchers.delete(newPaneId);
							api().sendMessage(
								{
									customType: "tmux_result",
									content: `tmux window '${pane}' watcher error: ${String(error)}. Window may still be open; inspect it with tmux read/list.`,
									display: true,
									details: { pane, command, exitCode: -1, elapsed: 0, error: String(error) },
								},
								{ triggerTurn: true, deliverAs: "steer" },
							);
						});

					return {
						content: [{
							type: "text",
							text: `Started '${command}' in window '${pane}' (${newPaneId}). Completion will be delivered automatically; do not poll.\nFinal snapshot will be saved to: ${run.fullOutputPath}\nUse the read tool with this path after completion.`,
						}],
						details: { action: "run", pane, paneId: newPaneId, command, fullOutputPath: run.fullOutputPath },
					};
				}

				case "read": {
					const { pane, lines } = params;
					if (!pane) throw new Error("'pane' is required for read");

					const existing = findPane(pane);
					if (!existing) throw new Error(`Window '${pane}' not found. Use action 'list' to see your windows.`);

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
						details: { action: "read", pane, alive: true, command: existing.command },
					};
				}

				case "send": {
					const { pane, keys, text } = params;
					if (!pane) throw new Error("'pane' is required for send");
					if (!keys && !text) throw new Error("'keys' or 'text' is required for send");

					const existing = findPane(pane);
					if (!existing) throw new Error(`Window '${pane}' not found.`);

					// Send literal text first (if provided)
					if (text) {
						await api().exec("tmux", ["send-keys", "-l", "-t", existing.paneId, text]);
					}

					// Then send special keys (if provided)
					if (keys) {
						const keyArgs = keys.split(/\s+/).filter(Boolean);
						await api().exec("tmux", ["send-keys", "-t", existing.paneId, ...keyArgs]);
					}

					const desc = [text && `"${text}"`, keys].filter(Boolean).join(" + ");
					return {
						content: [{ type: "text", text: `Sent ${desc} to window '${pane}'` }],
						details: { action: "send", pane, keys, text },
					};
				}

				case "stop": {
					const { pane } = params;
					if (!pane) throw new Error("'pane' is required for stop");

					const existing = findPane(pane);
					if (!existing) throw new Error(`Window '${pane}' not found.`);

					const result = await killPane(existing, ctx.sessionManager.getSessionDir());

					return {
						content: [{ type: "text", text: `Stopped window '${pane}'. Snapshot: ${result.fullOutputPath}\nUse the read tool with this path to inspect window content.` }],
						details: { action: "stop", pane, ...result },
					};
				}

				case "list": {
					const panes = listAllPanes();

					if (panes.length === 0) {
						return {
							content: [{ type: "text", text: "No windows." }],
							details: { action: "list", panes: [] },
						};
					}

					const text = panes.map((p) => `${p.name}: running (${p.command}) [${p.paneId}]`).join("\n");

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
					if (!panes?.length) return new Text(theme.fg("dim", "no windows"), 0, 0);

					const lines = panes.map((p) => `${theme.fg("success", "●")} ${theme.fg("accent", p.name)} ${theme.fg("dim", p.command)}`);
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
