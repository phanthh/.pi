/**
 * `/usage` dashboard: one card per account, grouped by provider.
 *
 *   ╭─ Claude ──────────────────────────────╮
 *   │ ● main · me@x.com · Max 20x           │
 *   │   5h        ██████░░░░░░  48%   2h13m │
 *   │   Extra     $12.30 / $50.00           │
 *   │   polled 1m ago                       │
 *   ╰───────────────────────────────────────╯
 */
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PROVIDER_NAMES, PROVIDERS, type ProviderId, type UsageAccount, type UsageLimit } from "./types.ts";
import { formatAmount, formatDuration, sanitize } from "./util.ts";

export type Color = "accent" | "muted" | "dim" | "warning" | "error" | "success" | "border" | "text";
export interface Style {
	fg(color: Color, text: string): string;
	bold(text: string): string;
}

export interface DashboardState {
	accounts: UsageAccount[];
	loading: boolean;
	/** `provider:accountKey` of the account serving the active model. */
	activeKey?: string;
	now: number;
}

const LABEL_WIDTH = 18;

function limitColor(limit: UsageLimit): Color {
	if (limit.status === "exhausted") return "error";
	if (limit.status === "warning" || (limit.usedFraction ?? 0) >= 0.8) return "warning";
	return "success";
}

function bar(fraction: number, width: number, style: Style, color: Color): string {
	const clamped = Math.min(1, Math.max(0, fraction));
	const filled = Math.round(clamped * width);
	return style.fg(color, "█".repeat(filled)) + style.fg("dim", "░".repeat(width - filled));
}

function ago(ms: number): string {
	return ms < 60_000 ? "just now" : `${formatDuration(ms)} ago`;
}

function limitTail(limit: UsageLimit, now: number): string {
	const reset = limit.resetsAt !== undefined && limit.resetsAt > now ? formatDuration(limit.resetsAt - now) : "";
	const money = limit.amount ? formatAmount(limit.amount) : "";
	return [money, reset ? `↻ ${reset}` : ""].filter(Boolean).join("  ");
}

/** One bar width per card so rows align: widest that fits every row's tail. */
function cardBarWidth(accounts: UsageAccount[], inner: number, now: number): number {
	const tails = accounts.flatMap((account) =>
		(account.report?.limits ?? []).filter((l) => l.usedFraction !== undefined).map((l) => visibleWidth(limitTail(l, now))),
	);
	const room = inner - 2 - LABEL_WIDTH - 5 - 2 - Math.max(0, ...tails);
	return Math.max(6, Math.min(30, room));
}

function limitLine(limit: UsageLimit, barWidth: number, style: Style, now: number): string {
	const name = truncateToWidth(sanitize(limit.label), LABEL_WIDTH - 1, "…", true);
	const label = name + " ".repeat(Math.max(0, LABEL_WIDTH - visibleWidth(name)));
	if (limit.usedFraction === undefined) {
		const money = limit.amount ? formatAmount(limit.amount) : "";
		return `  ${style.fg("muted", label)}${money || style.fg("dim", limit.status)}`;
	}
	const color = limitColor(limit);
	const pct = `${Math.round(limit.usedFraction * 100)}%`.padStart(5);
	const tail = limitTail(limit, now);
	return `  ${style.fg("muted", label)}${bar(limit.usedFraction, barWidth, style, color)}${style.fg(color, pct)}${
		tail ? `  ${style.fg("dim", tail)}` : ""
	}`;
}

function accountLines(account: UsageAccount, active: boolean, barWidth: number, style: Style, now: number): string[] {
	const report = account.report;
	const title = [
		account.accountKey === "main" && account.provider === "anthropic" ? "main" : undefined,
		sanitize(account.label),
		report?.plan ? sanitize(report.plan) : undefined,
	]
		.filter((part, index, parts): part is string => Boolean(part) && parts.indexOf(part) === index)
		.join(" · ");
	const marker = active ? style.fg("accent", "● ") : "  ";
	const lines = [marker + style.bold(title)];
	const limits = report?.limits ?? [];
	for (const limit of limits) lines.push(limitLine(limit, barWidth, style, now));
	if (report && limits.length === 0) lines.push(`  ${style.fg("dim", "no limits reported")}`);
	const meta: string[] = [];
	if (report) {
		const source = report.source === "snapshot" ? "anthropic-auth snapshot" : "polled";
		meta.push(`${source} ${ago(now - report.fetchedAt)}`);
		if (report.headersAt && report.headersAt > report.fetchedAt) meta.push(`headers ${ago(now - report.headersAt)}`);
	}
	if (meta.length) lines.push(`  ${style.fg("dim", meta.join(" · "))}`);
	if (account.error) lines.push(`  ${style.fg(report ? "warning" : "error", `⚠ ${sanitize(account.error)}`)}`);
	return lines;
}

function card(title: string, body: string[], width: number, style: Style): string[] {
	const inner = width - 4;
	const head = `╭─ ${title} `;
	const top = style.fg("border", head + "─".repeat(Math.max(0, width - visibleWidth(head) - 1)) + "╮");
	const rows = body.map((line) => {
		const clipped = truncateToWidth(line, inner);
		return `${style.fg("border", "│")} ${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))} ${style.fg("border", "│")}`;
	});
	return [top, ...rows, style.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`)];
}

const CREDENTIAL_HINTS: Record<ProviderId, string> = {
	anthropic: "/login anthropic",
	"openai-codex": "/login openai-codex",
	"opencode-go": "OPENCODE_API_KEY or /login opencode-go",
};

export function renderDashboard(state: DashboardState, width: number, style: Style): string[] {
	const cardWidth = Math.max(24, Math.min(width, 88));
	const inner = cardWidth - 4;
	const lines: string[] = [
		`${style.bold(style.fg("accent", "Usage"))}  ${style.fg("dim", state.loading ? "refreshing…" : "r refresh · esc close")}`,
	];
	for (const provider of PROVIDERS) {
		const accounts = state.accounts.filter((account) => account.provider === provider);
		if (accounts.length === 0) continue;
		const body: string[] = [];
		const barWidth = cardBarWidth(accounts, inner, state.now);
		accounts.forEach((account, index) => {
			if (index > 0) body.push("");
			const active = state.activeKey === `${account.provider}:${account.accountKey}`;
			body.push(...accountLines(account, active, barWidth, style, state.now));
		});
		lines.push("", ...card(style.bold(PROVIDER_NAMES[provider]), body, cardWidth, style));
	}
	if (state.accounts.length === 0) {
		lines.push(
			"",
			style.fg("dim", state.loading ? "Loading…" : "No Claude, Codex, or OpenCode Go credentials found. /login first."),
		);
	} else if (!state.loading) {
		// Missing credentials otherwise hide a card silently (e.g. env key added after pi started).
		const missing = PROVIDERS.filter((provider) => !state.accounts.some((account) => account.provider === provider));
		if (missing.length > 0) {
			lines.push(
				"",
				...missing.map((provider) =>
					style.fg("dim", `${PROVIDER_NAMES[provider]}: no credentials — ${CREDENTIAL_HINTS[provider]}`),
				),
			);
		}
	}
	return lines.map((line) => truncateToWidth(line, width));
}

export class DashboardView implements Component {
	#state: DashboardState;
	readonly #style: Style;
	readonly #onKey: (data: string) => void;
	#cache?: { width: number; lines: string[] };

	constructor(state: DashboardState, style: Style, onKey: (data: string) => void) {
		this.#state = state;
		this.#style = style;
		this.#onKey = onKey;
	}

	update(state: Partial<DashboardState>): void {
		this.#state = { ...this.#state, ...state };
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.#cache?.width === width) return this.#cache.lines;
		const lines = renderDashboard(this.#state, width, this.#style);
		this.#cache = { width, lines };
		return lines;
	}

	handleInput(data: string): void {
		this.#onKey(data);
	}

	invalidate(): void {
		this.#cache = undefined;
	}
}
