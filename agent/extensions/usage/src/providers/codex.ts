/**
 * OpenAI Codex (ChatGPT subscription) usage via `GET chatgpt.com/backend-api/wham/usage`,
 * ported from omp `packages/ai/src/usage/openai-codex.ts`.
 *
 * `/wham/usage` describes the *plan* allowance only. When a plan window reads
 * `limit_reached` but credits fund overage, Codex keeps serving — so a spent
 * window renders as a warning, not exhausted.
 */
import { Type } from "typebox";
import type { FetchImpl, UsageLimit, UsageStatus } from "../types.ts";
import { UsageHttpError } from "../types.ts";
import { clampFraction, decodeJwtPayload, parseAs, parseRetryAfterMs, statusForFraction, toNumber } from "../util.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";

const OptionalNumber = Type.Optional(Type.Union([Type.Number(), Type.Null()]));
const OptionalBoolean = Type.Optional(Type.Union([Type.Boolean(), Type.Null()]));

const Window = Type.Object({
	used_percent: OptionalNumber,
	limit_window_seconds: OptionalNumber,
	reset_after_seconds: OptionalNumber,
	reset_at: OptionalNumber,
});

const RateLimit = Type.Object({
	allowed: OptionalBoolean,
	limit_reached: OptionalBoolean,
	primary_window: Type.Optional(Type.Unknown()),
	secondary_window: Type.Optional(Type.Unknown()),
});

const AdditionalRateLimit = Type.Object({
	limit_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	metered_feature: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	rate_limit: RateLimit,
});

const Credits = Type.Object({
	has_credits: OptionalBoolean,
	unlimited: OptionalBoolean,
	overage_limit_reached: OptionalBoolean,
});

const NumberLike = Type.Union([Type.Number(), Type.String()]);
const SpendControl = Type.Object({
	reached: OptionalBoolean,
	individual_limit: Type.Optional(
		Type.Union([
			Type.Null(),
			Type.Object({
				unit: Type.Optional(Type.String()),
				limit: NumberLike,
				used: NumberLike,
				used_percent: OptionalNumber,
				reset_at: OptionalNumber,
			}),
		]),
	),
});

const Payload = Type.Object({
	plan_type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	rate_limit: Type.Optional(Type.Union([RateLimit, Type.Null()])),
	additional_rate_limits: Type.Optional(Type.Union([Type.Array(Type.Unknown()), Type.Null()])),
	credits: Type.Optional(Type.Union([Credits, Type.Null()])),
	spend_control: Type.Optional(Type.Union([SpendControl, Type.Null()])),
});

const JwtClaims = Type.Object({
	[JWT_AUTH_CLAIM]: Type.Optional(Type.Object({ chatgpt_account_id: Type.Optional(Type.String()) })),
	[JWT_PROFILE_CLAIM]: Type.Optional(Type.Object({ email: Type.Optional(Type.String()) })),
});

interface ParsedWindow {
	usedPercent?: number;
	windowSeconds?: number;
	resetAt?: number;
	resetAfterSeconds?: number;
}

function parseWindow(value: unknown): ParsedWindow | undefined {
	const window = parseAs(Window, value);
	if (!window) return undefined;
	const parsed: ParsedWindow = {
		usedPercent: window.used_percent ?? undefined,
		windowSeconds: window.limit_window_seconds ?? undefined,
		resetAt: window.reset_at ?? undefined,
		resetAfterSeconds: window.reset_after_seconds ?? undefined,
	};
	return Object.values(parsed).some((v) => v !== undefined) ? parsed : undefined;
}

export function codexWindowLabel(seconds: number | undefined, key: string): { label: string; tag: string } {
	if (seconds === undefined) return { label: key === "primary" ? "Primary" : "Secondary", tag: key.slice(0, 1) };
	if (seconds === 604_800) return { label: "Weekly", tag: "7d" };
	if (seconds >= 86_400) {
		const days = Math.round(seconds / 86_400);
		return { label: `${days} Day`, tag: `${days}d` };
	}
	const hours = Math.max(1, Math.round(seconds / 3600));
	return { label: `${hours} Hour`, tag: `${hours}h` };
}

function resetMs(window: ParsedWindow, now: number): number | undefined {
	if (window.resetAt !== undefined) return window.resetAt > 1e12 ? window.resetAt : window.resetAt * 1000;
	if (window.resetAfterSeconds !== undefined) return now + window.resetAfterSeconds * 1000;
	return undefined;
}

function windowStatus(fraction: number | undefined, stillServing: boolean): UsageStatus {
	const status = statusForFraction(fraction);
	return status === "exhausted" && stillServing ? "warning" : status;
}

function buildLimit(args: {
	id: string;
	key: "primary" | "secondary";
	window: ParsedWindow;
	suffix?: string;
	tier?: string;
	stillServing: boolean;
	now: number;
}): UsageLimit {
	const { label, tag } = codexWindowLabel(args.window.windowSeconds, args.key);
	const usedFraction = args.window.usedPercent === undefined ? undefined : clampFraction(args.window.usedPercent);
	const resetsAt = resetMs(args.window, args.now);
	return {
		id: args.id,
		label: args.suffix ? `${label} (${args.suffix})` : label,
		windowTag: tag,
		...(args.window.windowSeconds !== undefined ? { durationMs: args.window.windowSeconds * 1000 } : {}),
		...(resetsAt !== undefined ? { resetsAt } : {}),
		...(usedFraction !== undefined ? { usedFraction } : {}),
		status: windowStatus(usedFraction, args.stillServing),
		shared: args.tier === undefined,
		...(args.tier ? { tier: args.tier } : {}),
	};
}

function additionalSlug(limitName?: string, meteredFeature?: string): string {
	const probe = `${limitName ?? ""} ${meteredFeature ?? ""}`.toLowerCase();
	if (probe.includes("spark") || probe.includes("bengalfox")) return "spark";
	const source = (meteredFeature ?? limitName ?? "extra").toLowerCase();
	return (
		source
			.replace(/^codex[-_]/, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "extra"
	);
}

function additionalName(slug: string, limitName?: string): string {
	if (slug === "spark") return "Spark";
	if (limitName) return limitName;
	return slug.replace(/(^|-)([a-z])/g, (_m, sep: string, ch: string) => `${sep ? " " : ""}${ch.toUpperCase()}`);
}

export function formatCodexPlan(planType: string | undefined): string | undefined {
	if (!planType) return undefined;
	return planType
		.split(/[_-]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

export interface CodexUsage {
	plan?: string;
	limits: UsageLimit[];
}

/** Parse one `/wham/usage` body. */
export function parseCodexUsagePayload(value: unknown, now = Date.now()): CodexUsage {
	const payload = parseAs(Payload, value);
	if (!payload) return { limits: [] };
	const limits: UsageLimit[] = [];
	const rateLimit = payload.rate_limit ?? undefined;
	const credits = payload.credits ?? undefined;
	const creditOverage =
		rateLimit?.limit_reached === true &&
		(credits?.unlimited === true || credits?.has_credits === true) &&
		credits?.overage_limit_reached !== true &&
		payload.spend_control?.reached !== true;
	if (rateLimit) {
		const stillServing = creditOverage || (rateLimit.allowed === true && rateLimit.limit_reached === false);
		for (const key of ["primary", "secondary"] as const) {
			const window = parseWindow(rateLimit[`${key}_window`]);
			if (window) limits.push(buildLimit({ id: `openai-codex:${key}`, key, window, stillServing, now }));
		}
	}
	for (const raw of payload.additional_rate_limits ?? []) {
		const extra = parseAs(AdditionalRateLimit, raw);
		if (!extra) continue;
		const limitName = extra.limit_name ?? undefined;
		const slug = additionalSlug(limitName, extra.metered_feature ?? undefined);
		const name = additionalName(slug, limitName);
		const stillServing = extra.rate_limit.allowed === true && extra.rate_limit.limit_reached === false;
		for (const key of ["primary", "secondary"] as const) {
			const window = parseWindow(extra.rate_limit[`${key}_window`]);
			if (!window) continue;
			limits.push(
				buildLimit({ id: `openai-codex:${slug}:${key}`, key, window, suffix: name, tier: slug, stillServing, now }),
			);
		}
	}
	const spend = payload.spend_control?.individual_limit;
	const spendUsed = toNumber(spend?.used);
	const spendLimit = toNumber(spend?.limit);
	if (spend && spendUsed !== undefined && spendLimit !== undefined && spendLimit > 0) {
		const usedFraction = spend.used_percent != null ? clampFraction(spend.used_percent) : spendUsed / spendLimit;
		const resetAt = spend.reset_at ?? undefined;
		limits.push({
			id: "openai-codex:spend",
			label: "Workspace credits",
			windowTag: "cr",
			...(resetAt !== undefined ? { resetsAt: resetAt > 1e12 ? resetAt : resetAt * 1000 } : {}),
			amount: { used: spendUsed, limit: spendLimit, unit: spend.unit ?? "credits" },
			usedFraction,
			status: payload.spend_control?.reached ? "exhausted" : statusForFraction(usedFraction),
		});
	}
	const plan = formatCodexPlan(payload.plan_type ?? undefined);
	return { ...(plan ? { plan } : {}), limits };
}

/**
 * Parse `x-codex-{primary,secondary}-*` response headers. A 2xx response is
 * an explicit "still serving" verdict, so 100% reads as a warning there.
 */
export function parseCodexRateLimitHeaders(
	headers: Record<string, string>,
	status: number,
	now = Date.now(),
): UsageLimit[] {
	const limits: UsageLimit[] = [];
	const stillServing = status >= 200 && status < 300;
	for (const key of ["primary", "secondary"] as const) {
		const usedPercent = toNumber(headers[`x-codex-${key}-used-percent`]);
		if (usedPercent === undefined) continue;
		const minutes = toNumber(headers[`x-codex-${key}-window-minutes`]);
		const window: ParsedWindow = {
			usedPercent,
			windowSeconds: minutes === undefined ? undefined : minutes * 60,
			resetAt: toNumber(headers[`x-codex-${key}-reset-at`]),
			resetAfterSeconds: toNumber(headers[`x-codex-${key}-reset-after-seconds`]),
		};
		limits.push(buildLimit({ id: `openai-codex:${key}`, key, window, stillServing, now }));
	}
	return limits;
}

function eventWindow(value: unknown): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	const window = value as Record<string, unknown>;
	const minutes = toNumber(window.window_minutes);
	return minutes === undefined || window.limit_window_seconds !== undefined
		? window
		: { ...window, limit_window_seconds: minutes * 60 };
}

function eventRateLimit(value: unknown): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	const limit = value as Record<string, unknown>;
	return {
		allowed: limit.allowed,
		limit_reached: limit.limit_reached,
		primary_window: eventWindow(limit.primary_window ?? limit.primary),
		secondary_window: eventWindow(limit.secondary_window ?? limit.secondary),
	};
}

/**
 * Parse the websocket `codex.rate_limits` stream event (pi's default Codex
 * transport fires no `after_provider_response`, so headers never arrive).
 * Windows use `window_minutes` + `primary`/`secondary`; normalized into the
 * `/wham/usage` shape so ids match poll rows.
 */
export function parseCodexRateLimitsEvent(value: unknown, now = Date.now()): CodexUsage | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const event = value as Record<string, unknown>;
	if (event.type !== "codex.rate_limits") return undefined;
	const additional = Array.isArray(event.additional_rate_limits)
		? event.additional_rate_limits.map((raw: unknown) => {
				if (typeof raw !== "object" || raw === null) return raw;
				const entry = raw as Record<string, unknown>;
				return { ...entry, rate_limit: eventRateLimit(entry.rate_limit ?? entry.rate_limits) };
			})
		: undefined;
	return parseCodexUsagePayload(
		{
			plan_type: event.plan_type,
			rate_limit: eventRateLimit(event.rate_limits),
			additional_rate_limits: additional,
			credits: event.credits,
		},
		now,
	);
}

export function codexIdentity(accessToken: string): { accountId?: string; email?: string } {
	const claims = parseAs(JwtClaims, decodeJwtPayload(accessToken));
	const accountId = claims?.[JWT_AUTH_CLAIM]?.chatgpt_account_id;
	const email = claims?.[JWT_PROFILE_CLAIM]?.email?.trim().toLowerCase();
	return { ...(accountId ? { accountId } : {}), ...(email ? { email } : {}) };
}

export async function fetchCodexUsage(
	accessToken: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<CodexUsage> {
	const { accountId } = codexIdentity(accessToken);
	const response = await fetchImpl(USAGE_URL, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
			"User-Agent": "pi-usage-extension",
			...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
		},
		signal,
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new UsageHttpError(
			`Codex usage returned HTTP ${response.status}`,
			response.status,
			parseRetryAfterMs(response.headers.get("retry-after")),
		);
	}
	return parseCodexUsagePayload(await response.json());
}
