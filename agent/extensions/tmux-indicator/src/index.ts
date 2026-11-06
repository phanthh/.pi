import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

// Colors the tmux tab (window-status-style) of the window pi runs in by agent state.
// Each pi publishes its state on its own pane (@pi_indicator); any pi in a window
// recomputes the window style from all panes: waiting > error > running > idle,
// ties → lowest pane index. window-status-current-style is left alone.

type State = "waiting" | "error" | "running" | "idle";
type Colors = Record<State, { bg: string; fg: string }>;

const PRIORITY: State[] = ["waiting", "error", "running", "idle"];
const PANE_OPT = "@pi_indicator";
const DEFAULTS: Colors = {
	running: { bg: "#e0af68", fg: "#1a1b26" },
	waiting: { bg: "#bb9af7", fg: "#1a1b26" },
	error: { bg: "#f7768e", fg: "#1a1b26" },
	idle: { bg: "#9ece6a", fg: "#1a1b26" },
};

const run = promisify(execFile);

function loadColors(): Colors {
	let raw: Partial<Record<State, Partial<{ bg: string; fg: string }>>> = {};
	try {
		raw = JSON.parse(readFileSync(join(getAgentDir(), "tmux-indicator.json"), "utf8"));
	} catch {}
	const out = { ...DEFAULTS };
	for (const s of PRIORITY) out[s] = { ...DEFAULTS[s], ...raw[s] };
	return out;
}

export default function tmuxIndicator(pi: ExtensionAPI) {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane) return;
	const colors = loadColors();

	let base: "idle" | "running" | "error" = "idle";
	let prompts = 0;
	let compacting = false;
	let lastRunErrored = false;
	let queue: Promise<unknown> = Promise.resolve();

	const tmux = (...args: string[]) => run("tmux", args).then((r) => r.stdout);

	// Pane option set/unset, then recompute window style from every pane in the window.
	const sync = (state: State | undefined) => {
		queue = queue
			.then(async () => {
				await tmux("set", "-p", ...(state ? [] : ["-u"]), "-t", pane, PANE_OPT, ...(state ? [state] : []));
				const lines = (await tmux("list-panes", "-t", pane, "-F", `#{pane_index} #{${PANE_OPT}}`)).split("\n");
				let pick: State | undefined;
				let pickIdx = Infinity;
				for (const line of lines) {
					const [idx, s] = line.split(" ") as [string, State | undefined];
					if (!s || !PRIORITY.includes(s)) continue;
					const better =
						!pick || PRIORITY.indexOf(s) < PRIORITY.indexOf(pick) || (s === pick && Number(idx) < pickIdx);
					if (better) [pick, pickIdx] = [s, Number(idx)];
				}
				if (pick) await tmux("set", "-w", "-t", pane, "window-status-style", `bg=${colors[pick].bg},fg=${colors[pick].fg}`);
				else await tmux("set", "-w", "-u", "-t", pane, "window-status-style");
			})
			.catch(() => {});
		return queue;
	};

	const update = () => sync(prompts > 0 ? "waiting" : compacting ? "running" : base);

	pi.on("session_start", (_e, c) => {
		base = c.isIdle() ? "idle" : "running";
		prompts = 0;
		compacting = false;
		update();
	});
	pi.on("agent_start", () => {
		base = "running";
		lastRunErrored = false;
		update();
	});
	pi.on("agent_end", (e) => {
		const last = e.messages.findLast((m) => m.role === "assistant");
		lastRunErrored = last?.role === "assistant" && last.stopReason === "error";
	});
	pi.on("agent_settled", (e) => {
		base = !e.aborted && lastRunErrored ? "error" : "idle";
		update();
	});
	pi.on("ui_prompt_start", () => {
		prompts++;
		update();
	});
	pi.on("ui_prompt_end", () => {
		prompts = Math.max(0, prompts - 1);
		update();
	});
	pi.on("session_before_compact", () => {
		compacting = true;
		update();
	});
	const endCompact = () => {
		compacting = false;
		update();
	};
	pi.on("session_compact", endCompact);
	pi.on("session_compact_failed", endCompact);
	// reload/new/resume/fork: next session_start re-applies; only quit clears.
	pi.on("session_shutdown", async (e) => {
		if (e.reason === "quit") await sync(undefined);
	});
}
