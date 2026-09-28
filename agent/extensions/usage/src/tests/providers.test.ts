import assert from "node:assert/strict";
import { test } from "node:test";
import {
	fetchClaudeUsage,
	limitsFromQuotaSnapshot,
	parseClaudeRateLimitHeaders,
	parseClaudeUsagePayload,
} from "../providers/claude.ts";
import {
	codexIdentity,
	parseCodexRateLimitHeaders,
	parseCodexRateLimitsEvent,
	parseCodexUsagePayload,
} from "../providers/codex.ts";
import { parseOpenCodeGoPayload } from "../providers/opencode-go.ts";
import { UsageHttpError } from "../types.ts";

const byId = <T extends { id: string }>(limits: T[]): Record<string, T> =>
	Object.fromEntries(limits.map((limit) => [limit.id, limit]));

test("claude payload: legacy buckets, scoped limits[], spend", () => {
	const limits = parseClaudeUsagePayload({
		five_hour: { utilization: 48, resets_at: "2026-07-10T12:00:00Z" },
		seven_day: { utilization: 100, resets_at: "2026-07-14T00:00:00Z" },
		seven_day_opus: null,
		limits: [
			{ kind: "weekly_scoped", percent: 30, resets_at: "2026-07-14T00:00:00Z", scope: { model: { display_name: "Opus" } } },
			{ kind: "weekly_scoped", percent: null, resets_at: null, scope: null },
		],
		spend: {
			enabled: true,
			used: { amount_minor: 1230, currency: "USD", exponent: 2 },
			limit: { amount_minor: 5000, currency: "USD", exponent: 2 },
		},
	});
	const map = byId(limits);
	assert.deepEqual(Object.keys(map), ["anthropic:5h", "anthropic:7d", "anthropic:7d:opus", "anthropic:extra"]);
	assert.equal(map["anthropic:5h"].usedFraction, 0.48);
	assert.equal(map["anthropic:5h"].shared, true);
	assert.equal(map["anthropic:5h"].resetsAt, Date.parse("2026-07-10T12:00:00Z"));
	assert.equal(map["anthropic:7d"].status, "exhausted");
	assert.equal(map["anthropic:7d:opus"].tier, "opus");
	assert.equal(map["anthropic:7d:opus"].shared, undefined);
	assert.deepEqual(map["anthropic:extra"].amount, { used: 12.3, limit: 50, unit: "USD" });
});

test("claude payload: garbage → no limits; disabled extra dropped", () => {
	assert.deepEqual(parseClaudeUsagePayload(null), []);
	assert.deepEqual(parseClaudeUsagePayload({ five_hour: "x", extra_usage: { is_enabled: false, used_credits: 1 } }), []);
});

test("claude headers: unified 5h/7d fractions + epoch-second resets", () => {
	const limits = parseClaudeRateLimitHeaders({
		"anthropic-ratelimit-unified-5h-utilization": "0.25",
		"anthropic-ratelimit-unified-5h-reset": "1780000000",
		"anthropic-ratelimit-unified-7d-utilization": "0.9",
	});
	const map = byId(limits);
	assert.equal(map["anthropic:5h"].usedFraction, 0.25);
	assert.equal(map["anthropic:5h"].resetsAt, 1_780_000_000_000);
	assert.equal(map["anthropic:7d"].status, "warning");
	assert.equal(map["anthropic:7d"].resetsAt, undefined);
	assert.deepEqual(parseClaudeRateLimitHeaders({}), []);
});

test("claude quota snapshot → limits", () => {
	const limits = limitsFromQuotaSnapshot({
		five_hour: { usedPercent: 10, remainingPercent: 90, resetsAt: "2026-07-10T12:00:00Z" },
		seven_day: { usedPercent: 60, remainingPercent: 40 },
		scoped: [{ modelName: "Sonnet", usedPercent: 5, remainingPercent: 95 }],
	} as never);
	assert.deepEqual(
		limits.map((limit) => [limit.id, limit.usedFraction]),
		[
			["anthropic:5h", 0.1],
			["anthropic:7d", 0.6],
			["anthropic:7d:sonnet", 0.05],
		],
	);
});

test("claude fetch: 429 → UsageHttpError with retry-after", async () => {
	const fetchImpl = async () => new Response("slow down", { status: 429, headers: { "retry-after": "120" } });
	await assert.rejects(fetchClaudeUsage("tok", fetchImpl), (error: unknown) => {
		assert.ok(error instanceof UsageHttpError);
		assert.equal(error.status, 429);
		assert.equal(error.retryAfterMs, 120_000);
		return true;
	});
});

test("codex payload: windows, credit overage, spark tier, plan", () => {
	const now = 1_000_000;
	const usage = parseCodexUsagePayload(
		{
			plan_type: "pro_lite",
			rate_limit: {
				allowed: false,
				limit_reached: true,
				primary_window: { used_percent: 100, limit_window_seconds: 18_000, reset_after_seconds: 60 },
				secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: 2_000_000 },
			},
			credits: { has_credits: true },
			additional_rate_limits: [
				{
					limit_name: "GPT-5.3-Codex-Spark",
					rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 5, limit_window_seconds: 18_000 } },
				},
			],
		},
		now,
	);
	assert.equal(usage.plan, "Pro Lite");
	const map = byId(usage.limits);
	assert.equal(map["openai-codex:primary"].label, "5 Hour");
	// Credits fund overage → spent window still serving.
	assert.equal(map["openai-codex:primary"].status, "warning");
	assert.equal(map["openai-codex:primary"].resetsAt, now + 60_000);
	assert.equal(map["openai-codex:secondary"].label, "Weekly");
	assert.equal(map["openai-codex:secondary"].resetsAt, 2_000_000_000);
	assert.equal(map["openai-codex:spark:primary"].tier, "spark");
	assert.equal(map["openai-codex:spark:primary"].label, "5 Hour (Spark)");
	assert.equal(map["openai-codex:spark:primary"].shared, false);
});

test("codex headers: 2xx keeps 100% serving; 429 exhausts", () => {
	const headers = { "x-codex-primary-used-percent": "100", "x-codex-primary-window-minutes": "300" };
	assert.equal(parseCodexRateLimitHeaders(headers, 200)[0].status, "warning");
	assert.equal(parseCodexRateLimitHeaders(headers, 429)[0].status, "exhausted");
	assert.equal(parseCodexRateLimitHeaders(headers, 200)[0].windowTag, "5h");
});

test("codex websocket codex.rate_limits event → poll-compatible limits", () => {
	const now = 5_000;
	// Captured live (self_serve_business_prolite), trimmed.
	const event = {
		type: "codex.rate_limits",
		plan_type: "self_serve_business_prolite",
		rate_limits: {
			allowed: true,
			limit_reached: false,
			primary: { used_percent: 2, window_minutes: 10080, reset_after_seconds: 601352, reset_at: 1791184787 },
			secondary: null,
		},
		code_review_rate_limits: null,
		additional_rate_limits: [
			{ limit_name: "GPT-5.3-Codex-Spark", rate_limits: { allowed: true, limit_reached: false, primary: { used_percent: 9, window_minutes: 300 } } },
		],
		credits: { has_credits: true, unlimited: false, balance: null },
		promo: null,
	};
	const usage = parseCodexRateLimitsEvent(event, now);
	assert.equal(usage?.plan, "Self Serve Business Prolite");
	const map = byId(usage?.limits ?? []);
	assert.deepEqual(Object.keys(map), ["openai-codex:primary", "openai-codex:spark:primary"]);
	assert.equal(map["openai-codex:primary"].label, "Weekly");
	assert.equal(map["openai-codex:primary"].usedFraction, 0.02);
	assert.equal(map["openai-codex:primary"].resetsAt, 1_791_184_787_000);
	assert.equal(map["openai-codex:spark:primary"].windowTag, "5h");
	assert.equal(parseCodexRateLimitsEvent({ type: "response.created" }), undefined);
	assert.equal(parseCodexRateLimitsEvent(null), undefined);
});

test("codex identity from JWT claims", () => {
	const claims = {
		"https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
		"https://api.openai.com/profile": { email: " Me@X.com " },
	};
	const token = `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
	assert.deepEqual(codexIdentity(token), { accountId: "acct-1", email: "me@x.com" });
	assert.deepEqual(codexIdentity("garbage"), {});
});

test("opencode-go payload: rate-limited status, monthly display-only", () => {
	const limits = parseOpenCodeGoPayload({
		usage: {
			rolling: { status: "rate-limited", percent: 100, resetsAt: "2026-07-10T12:00:00Z" },
			weekly: { status: "ok", percent: 50, resetsAt: "2026-07-14T00:00:00Z" },
			monthly: { status: "ok", percent: 10, resetsAt: "2026-08-01T00:00:00Z" },
			bogus: { status: "nope" },
		},
	});
	const map = byId(limits);
	assert.equal(map["opencode-go:5h"].status, "exhausted");
	assert.equal(map["opencode-go:7d"].usedFraction, 0.5);
	assert.equal(map["opencode-go:monthly"].shared, false);
	assert.deepEqual(parseOpenCodeGoPayload({}), []);
});
