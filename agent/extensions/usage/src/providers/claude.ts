/**
 * Claude subscription usage (`GET api.anthropic.com/api/oauth/usage`), ported
 * from omp `packages/ai/src/usage/claude.ts`.
 *
 * Legacy account-wide buckets (`five_hour`, `seven_day`) stay populated; the
 * per-model weekly buckets (`seven_day_opus/sonnet`) went permanently null on
 * 2026-07-02 and model-scoped caps now arrive only as `limits[]` entries with
 * `kind: "weekly_scoped"`. `is_active` is ignored: it marks the binding limit,
 * not bucket existence.
 */
import { CLAUDE_CODE_VERSION } from "../../../anthropic-auth/src/core/constants.ts";
import type { OAuthQuotaSnapshot } from "../../../anthropic-auth/src/core/accounts.ts";
import { type Static, Type } from "typebox";
import type { FetchImpl, UsageLimit } from "../types.ts";
import { UsageHttpError } from "../types.ts";
import {
	clampFraction,
	HOUR_MS,
	parseAs,
	parseIsoMs,
	parseRetryAfterMs,
	slugify,
	statusForFraction,
	toNumber,
	WEEK_MS,
} from "../util.ts";

const OAUTH_BASE = "https://api.anthropic.com/api/oauth";

const NullableNumber = Type.Union([Type.Number(), Type.Null()]);
const NullableString = Type.Union([Type.String(), Type.Null()]);

const Bucket = Type.Object({
	utilization: Type.Optional(NullableNumber),
	resets_at: Type.Optional(NullableString),
});

const LimitEntry = Type.Object({
	kind: Type.String(),
	percent: Type.Optional(NullableNumber),
	resets_at: Type.Optional(NullableString),
	scope: Type.Optional(
		Type.Union([
			Type.Null(),
			Type.Object({
				model: Type.Optional(
					Type.Union([Type.Null(), Type.Object({ display_name: Type.Optional(NullableString) })]),
				),
			}),
		]),
	),
});

const Money = Type.Object({
	amount_minor: Type.Integer({ minimum: 0 }),
	currency: Type.String(),
	exponent: Type.Integer({ minimum: 0 }),
});

const Spend = Type.Object({
	enabled: Type.Boolean(),
	used: Money,
	limit: Type.Union([Money, Type.Null()]),
});

const LegacyExtraUsage = Type.Object({
	is_enabled: Type.Boolean(),
	monthly_limit: Type.Optional(NullableNumber),
	used_credits: Type.Number({ minimum: 0 }),
	decimal_places: Type.Optional(Type.Integer({ minimum: 0 })),
	currency: Type.Optional(Type.String()),
});

const Profile = Type.Object({
	account: Type.Optional(
		Type.Object({
			email: Type.Optional(Type.String()),
			has_claude_max: Type.Optional(Type.Boolean()),
			has_claude_pro: Type.Optional(Type.Boolean()),
		}),
	),
	organization: Type.Optional(
		Type.Object({
			name: Type.Optional(Type.String()),
			organization_type: Type.Optional(Type.String()),
		}),
	),
});

interface ParsedBucket {
	utilization?: number;
	resetsAt?: number;
}

function parseBucket(value: unknown): ParsedBucket | undefined {
	const bucket = parseAs(Bucket, value);
	if (!bucket) return undefined;
	const utilization = bucket.utilization ?? undefined;
	const resetsAt = parseIsoMs(bucket.resets_at);
	if (utilization === undefined && resetsAt === undefined) return undefined;
	return { utilization, resetsAt };
}

interface ParsedLimitEntry {
	kind: string;
	bucket: ParsedBucket;
	displayName?: string;
}

function parseLimitEntries(value: unknown): ParsedLimitEntry[] {
	if (!Array.isArray(value)) return [];
	const entries: ParsedLimitEntry[] = [];
	for (const raw of value) {
		const entry = parseAs(LimitEntry, raw);
		if (!entry) continue;
		const utilization = entry.percent ?? undefined;
		const resetsAt = parseIsoMs(entry.resets_at);
		if (utilization === undefined && resetsAt === undefined) continue;
		const displayName = entry.scope?.model?.display_name?.trim() || undefined;
		entries.push({ kind: entry.kind, bucket: { utilization, resetsAt }, ...(displayName ? { displayName } : {}) });
	}
	return entries;
}

function windowLimit(args: {
	id: string;
	label: string;
	tag: string;
	durationMs: number;
	bucket: ParsedBucket | undefined;
	shared?: boolean;
	tier?: string;
}): UsageLimit | undefined {
	if (args.bucket?.utilization === undefined) return undefined;
	const usedFraction = clampFraction(args.bucket.utilization);
	return {
		id: args.id,
		label: args.label,
		windowTag: args.tag,
		durationMs: args.durationMs,
		...(args.bucket.resetsAt !== undefined ? { resetsAt: args.bucket.resetsAt } : {}),
		usedFraction,
		status: statusForFraction(usedFraction),
		...(args.shared ? { shared: true } : {}),
		...(args.tier ? { tier: args.tier } : {}),
	};
}

const fiveHour = (bucket: ParsedBucket | undefined) =>
	windowLimit({ id: "anthropic:5h", label: "5 Hour", tag: "5h", durationMs: 5 * HOUR_MS, bucket, shared: true });
const sevenDay = (bucket: ParsedBucket | undefined) =>
	windowLimit({ id: "anthropic:7d", label: "Weekly", tag: "7d", durationMs: WEEK_MS, bucket, shared: true });
const scopedWeekly = (name: string, bucket: ParsedBucket | undefined) => {
	const tier = slugify(name);
	return tier
		? windowLimit({ id: `anthropic:7d:${tier}`, label: `Weekly (${name})`, tag: "7d", durationMs: WEEK_MS, bucket, tier })
		: undefined;
};

function extraUsageLimit(payload: Record<string, unknown>): UsageLimit | undefined {
	let used: number;
	let limit: number | undefined;
	let unit: string;
	if (payload.spend !== undefined && payload.spend !== null) {
		const spend = parseAs(Spend, payload.spend);
		if (!spend?.enabled) return undefined;
		used = spend.used.amount_minor / 10 ** spend.used.exponent;
		unit = spend.used.currency;
		if (spend.limit) {
			if (spend.limit.currency !== unit) return undefined;
			limit = spend.limit.amount_minor / 10 ** spend.limit.exponent;
		}
	} else {
		const extra = parseAs(LegacyExtraUsage, payload.extra_usage);
		if (!extra?.is_enabled) return undefined;
		const divisor = 10 ** (extra.decimal_places ?? 2);
		used = extra.used_credits / divisor;
		unit = extra.currency ?? "USD";
		if (extra.monthly_limit !== undefined && extra.monthly_limit !== null) limit = extra.monthly_limit / divisor;
	}
	if (limit !== undefined && limit <= 0) return undefined;
	const usedFraction = limit === undefined ? undefined : used / limit;
	return {
		id: "anthropic:extra",
		label: "Extra usage",
		windowTag: "mo",
		amount: { used, ...(limit !== undefined ? { limit } : {}), unit },
		...(usedFraction !== undefined ? { usedFraction } : {}),
		status: usedFraction === undefined ? "ok" : statusForFraction(usedFraction),
	};
}

/** Parse one `/api/oauth/usage` body into normalized limits. */
export function parseClaudeUsagePayload(payload: unknown): UsageLimit[] {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
	const body = payload as Record<string, unknown>;
	const entries = parseLimitEntries(body.limits);
	const limits: (UsageLimit | undefined)[] = [
		fiveHour(parseBucket(body.five_hour) ?? entries.find((e) => e.kind === "session")?.bucket),
		sevenDay(parseBucket(body.seven_day) ?? entries.find((e) => e.kind === "weekly_all")?.bucket),
		scopedWeekly("Opus", parseBucket(body.seven_day_opus)),
		scopedWeekly("Sonnet", parseBucket(body.seven_day_sonnet)),
	];
	const seen = new Set(limits.filter((l) => l !== undefined).map((l) => l.id));
	for (const entry of entries) {
		if (entry.kind !== "weekly_scoped" || !entry.displayName) continue;
		const limit = scopedWeekly(entry.displayName, entry.bucket);
		if (!limit || seen.has(limit.id)) continue;
		seen.add(limit.id);
		limits.push(limit);
	}
	limits.push(extraUsageLimit(body));
	return limits.filter((limit): limit is UsageLimit => limit !== undefined);
}

function headerWindow(headers: Record<string, string>, window: "5h" | "7d"): ParsedBucket | undefined {
	const prefix = `anthropic-ratelimit-unified-${window}-`;
	const fraction = toNumber(headers[`${prefix}utilization`]);
	if (fraction === undefined) return undefined;
	const resetSeconds = toNumber(headers[`${prefix}reset`]);
	return {
		utilization: fraction * 100,
		...(resetSeconds !== undefined && resetSeconds > 0 ? { resetsAt: resetSeconds * 1000 } : {}),
	};
}

/**
 * Parse `anthropic-ratelimit-unified-{5h,7d}-*` response headers. The
 * model-scoped `7d_oi` window is skipped: headers don't name its model family.
 */
export function parseClaudeRateLimitHeaders(headers: Record<string, string>): UsageLimit[] {
	return [fiveHour(headerWindow(headers, "5h")), sevenDay(headerWindow(headers, "7d"))].filter(
		(limit): limit is UsageLimit => limit !== undefined,
	);
}

/** Convert an anthropic-auth persisted quota snapshot (fallback accounts without a live token). */
export function limitsFromQuotaSnapshot(snapshot: OAuthQuotaSnapshot | undefined): UsageLimit[] {
	if (!snapshot) return [];
	const bucket = (window: { usedPercent: number; resetsAt?: string } | undefined): ParsedBucket | undefined =>
		window ? { utilization: window.usedPercent, resetsAt: parseIsoMs(window.resetsAt) } : undefined;
	const limits: (UsageLimit | undefined)[] = [fiveHour(bucket(snapshot.five_hour)), sevenDay(bucket(snapshot.seven_day))];
	for (const scoped of snapshot.scoped ?? []) limits.push(scopedWeekly(scoped.modelName, bucket(scoped)));
	const extra = snapshot.extraUsage;
	if (extra) {
		const used = extra.used.amountMinor / 10 ** extra.used.exponent;
		const limit = extra.limit.amountMinor / 10 ** extra.limit.exponent;
		const usedFraction = limit > 0 ? used / limit : undefined;
		limits.push({
			id: "anthropic:extra",
			label: "Extra usage",
			windowTag: "mo",
			amount: { used, limit, unit: extra.used.currency },
			...(usedFraction !== undefined ? { usedFraction } : {}),
			status: extra.exhausted ? "exhausted" : statusForFraction(usedFraction),
		});
	}
	return limits.filter((limit): limit is UsageLimit => limit !== undefined);
}

function oauthHeaders(accessToken: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
		"anthropic-beta": "oauth-2025-04-20",
		"User-Agent": `claude-code/${CLAUDE_CODE_VERSION}`,
	};
}

async function getJson(fetchImpl: FetchImpl, url: string, accessToken: string, signal?: AbortSignal): Promise<unknown> {
	const response = await fetchImpl(url, { headers: oauthHeaders(accessToken), signal });
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new UsageHttpError(
			`Claude ${url.slice(OAUTH_BASE.length + 1)} returned HTTP ${response.status}`,
			response.status,
			parseRetryAfterMs(response.headers.get("retry-after")),
		);
	}
	return (await response.json()) as unknown;
}

export async function fetchClaudeUsage(
	accessToken: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<UsageLimit[]> {
	return parseClaudeUsagePayload(await getJson(fetchImpl, `${OAUTH_BASE}/usage`, accessToken, signal));
}

export interface ClaudeProfile {
	email?: string;
	plan?: string;
}

function formatPlan(profile: Static<typeof Profile>): string | undefined {
	const orgType = profile.organization?.organization_type?.replace(/^claude_/, "");
	if (orgType) return orgType.charAt(0).toUpperCase() + orgType.slice(1);
	if (profile.account?.has_claude_max) return "Max";
	if (profile.account?.has_claude_pro) return "Pro";
	return undefined;
}

/** Identity + plan label; best-effort (undefined on any failure). */
export async function fetchClaudeProfile(
	accessToken: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<ClaudeProfile | undefined> {
	try {
		const profile = parseAs(Profile, await getJson(fetchImpl, `${OAUTH_BASE}/profile`, accessToken, signal));
		if (!profile) return undefined;
		const plan = formatPlan(profile);
		return { ...(profile.account?.email ? { email: profile.account.email } : {}), ...(plan ? { plan } : {}) };
	} catch {
		return undefined;
	}
}
