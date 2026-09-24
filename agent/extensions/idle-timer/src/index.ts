import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "idle-timer";

export function formatIdle(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
	return `${Math.floor(h / 24)}d${h % 24}h`;
}

// Footer status showing how long pi has been waiting on the user: since the
// agent settled, or since a blocking UI prompt (e.g. `ask`) opened mid-run.
export default function idleTimer(pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let idleSince: number | undefined;
	let tick: ReturnType<typeof setInterval> | undefined;

	const render = () => {
		if (ctx?.mode !== "tui") return;
		ctx.ui.setStatus(
			STATUS_KEY,
			idleSince === undefined ? undefined : ctx.ui.theme.fg("dim", `💤 ${formatIdle(Date.now() - idleSince)}`),
		);
	};

	const startIdle = (c: ExtensionContext, since = Date.now()) => {
		ctx = c;
		idleSince = since;
		render();
		if (!tick && c.mode === "tui") {
			tick = setInterval(render, 1000);
			tick.unref();
		}
	};

	const stopIdle = (c: ExtensionContext) => {
		ctx = c;
		idleSince = undefined;
		clearInterval(tick);
		tick = undefined;
		render();
	};

	pi.on("session_start", (_event, c) => {
		if (!c.isIdle()) return stopIdle(c);
		// Resumed/reloaded session: count from last recorded activity, not from load.
		const last = c.sessionManager.getBranch().at(-1)?.timestamp;
		const since = last ? Date.parse(last) : NaN;
		startIdle(c, Number.isNaN(since) ? Date.now() : Math.min(since, Date.now()));
	});
	pi.on("agent_start", (_event, c) => stopIdle(c));
	pi.on("agent_settled", (_event, c) => startIdle(c));
	pi.on("ui_prompt_start", (_event, c) => {
		if (idleSince === undefined) startIdle(c);
	});
	pi.on("ui_prompt_end", (_event, c) => {
		if (!c.isIdle()) stopIdle(c);
	});
	pi.on("session_shutdown", (_event, c) => stopIdle(c));
}
