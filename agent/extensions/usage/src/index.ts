/**
 * Subscription usage for Claude (anthropic + anthropic-auth fallbacks), Codex, OpenCode Go.
 *
 *   footer   `setStatus("usage")` → active provider's windows; refreshed from
 *            response headers (`after_provider_response`), Codex websocket
 *            `codex.rate_limits` events, and TTL-gated polls
 *   /usage   dashboard of every account (cards + bars); `r` forces a poll
 *
 * Reports are shared across pi processes via `~/.pi/agent/cache/usage.json`.
 */
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { ANTHROPIC_MAIN_KEY } from "./accounts.ts";
import { DashboardView, renderDashboard, type Style } from "./dashboard.ts";
import { formatFooter } from "./footer.ts";
import { UsageService } from "./service.ts";
import { PROVIDERS, type ProviderId } from "./types.ts";
import { MINUTE_MS } from "./util.ts";

const STATUS_KEY = "usage";
const TICK_MS = MINUTE_MS;

function activeProvider(ctx: ExtensionContext): ProviderId | undefined {
	const provider = ctx.model?.provider;
	return PROVIDERS.find((candidate) => candidate === provider);
}

const plainStyle: Style = { fg: (_color, text) => text, bold: (text) => text };

export default function usageExtension(pi: ExtensionAPI) {
	const service = new UsageService({ cachePath: join(getAgentDir(), "cache", "usage.json") });
	let ctx: ExtensionContext | undefined;
	let tick: ReturnType<typeof setInterval> | undefined;
	let refreshing = false;
	/** Single-account providers: last discovered key, for footer lookup. */
	const lastKeys = new Map<ProviderId, string>();

	const activeAccountKey = (provider: ProviderId): string | undefined => {
		if (provider === "anthropic") return service.lastAnthropicAccount;
		return undefined;
	};

	const renderFooter = () => {
		if (!ctx || ctx.mode !== "tui") return;
		const provider = activeProvider(ctx);
		if (!provider) return ctx.ui.setStatus(STATUS_KEY, undefined);
		const theme = ctx.ui.theme;
		const accountKey = activeAccountKey(provider) ?? lastKeys.get(provider);
		const report = accountKey ? service.report(provider, accountKey) : undefined;
		const text = report ? formatFooter(report, ctx.model?.id, (color, value) => theme.fg(color, value)) : undefined;
		if (!text) return ctx.ui.setStatus(STATUS_KEY, undefined);
		const who =
			provider === "anthropic" && accountKey !== ANTHROPIC_MAIN_KEY && report?.label
				? theme.fg("dim", `${report.label} `)
				: "";
		ctx.ui.setStatus(STATUS_KEY, `${who}${text}`);
	};

	const refreshActive = async (force = false) => {
		const current = ctx;
		const provider = current && activeProvider(current);
		if (!current || !provider || refreshing) return renderFooter();
		refreshing = true;
		try {
			const accounts = await service.accounts(current.modelRegistry, [provider], { force });
			const first = accounts[0];
			if (provider !== "anthropic" && first) lastKeys.set(provider, first.accountKey);
		} catch {
			// Footer keeps its last report; /usage surfaces errors.
		} finally {
			refreshing = false;
			renderFooter();
		}
	};

	service.onChange(() => renderFooter());

	pi.on("session_start", async (_event, c) => {
		ctx = c;
		if (c.mode !== "tui") return;
		await service.hydrate().catch(() => {});
		void refreshActive();
		if (!tick) {
			tick = setInterval(() => void refreshActive(), TICK_MS);
			tick.unref();
		}
	});

	pi.on("model_select", (_event, c) => {
		ctx = c;
		if (c.mode !== "tui") return;
		renderFooter();
		void refreshActive();
	});

	pi.on("after_provider_response", (event, c) => {
		ctx = c;
		// Fire-and-forget: pi awaits handlers before the body streams.
		void service.ingestHeaders(event.headers, event.status).catch(() => {});
	});

	// Typed locally: runtime pi (~/dev/pi) emits it, npm typings 0.87.1 predate it.
	const onStreamEvent = pi.on.bind(pi) as unknown as (
		event: "provider_stream_event",
		handler: (event: { provider: string; data: unknown }, ctx: ExtensionContext) => void,
	) => void;
	onStreamEvent("provider_stream_event", (event, c) => {
		// Hot path (every delta): cheap type check first. Websocket Codex has no headers.
		const data = event.data as { type?: unknown } | null;
		if (event.provider !== "openai-codex" || data?.type !== "codex.rate_limits") return;
		ctx = c;
		void service.ingestCodexEvent(data).catch(() => {});
	});

	pi.on("session_shutdown", (_event, c) => {
		clearInterval(tick);
		tick = undefined;
		if (c.mode === "tui") c.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("usage", {
		description: "Subscription usage: Claude, Codex, OpenCode Go (r refresh)",
		handler: async (_args, c) => {
			ctx = c;
			const provider = activeProvider(c);
			const activeKey = provider ? `${provider}:${activeAccountKey(provider) ?? lastKeys.get(provider) ?? ""}` : undefined;

			if (c.mode !== "tui") {
				const accounts = await service.accounts(c.modelRegistry, PROVIDERS);
				const text = renderDashboard({ accounts, loading: false, activeKey, now: Date.now() }, 100, plainStyle).join("\n");
				c.ui.notify(text, "info");
				return;
			}

			await c.ui.custom<void>((tui, theme, _keys, done) => {
				let closed = false;
				const style: Style = { fg: (color, text) => theme.fg(color, text), bold: (text) => theme.bold(text) };
				const load = async (force: boolean) => {
					view.update({ loading: true, now: Date.now() });
					tui.requestRender();
					try {
						const accounts = await service.accounts(c.modelRegistry, PROVIDERS, { force });
						if (closed) return;
						for (const account of accounts) {
							if (account.provider !== "anthropic") lastKeys.set(account.provider, account.accountKey);
						}
						view.update({ accounts, loading: false, now: Date.now() });
					} catch (error) {
						if (closed) return;
						view.update({ loading: false, now: Date.now() });
						c.ui.notify(`usage: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
					tui.requestRender();
					renderFooter();
				};
				const view = new DashboardView({ accounts: [], loading: true, activeKey, now: Date.now() }, style, (data) => {
					if (matchesKey(data, "escape") || data === "q") {
						closed = true;
						done();
					} else if (data === "r") {
						void load(true);
					}
				});
				void load(false);
				return view;
			});
		},
	});
}
