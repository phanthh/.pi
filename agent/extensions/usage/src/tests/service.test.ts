import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AccountHandle } from "../accounts.ts";
import { readCache, writeCache } from "../cache.ts";
import { mergeLimits, POLL_TTL_MS, UsageService } from "../service.ts";
import type { FetchImpl, ProviderId, UsageLimit } from "../types.ts";

const dir = await mkdtemp(join(tmpdir(), "usage-ext-test-"));
after(() => rm(dir, { recursive: true, force: true }));
let counter = 0;
const freshPath = () => join(dir, `cache-${counter++}.json`);

const registry = { getApiKeyForProvider: async () => undefined };

function claudeFetch(calls: string[], status = 200): FetchImpl {
	return async (url) => {
		calls.push(url);
		if (status !== 200) return new Response("", { status, headers: { "retry-after": "60" } });
		if (url.endsWith("/profile")) {
			return Response.json({ account: { email: "me@x.com", has_claude_max: true } });
		}
		return Response.json({ five_hour: { utilization: 40, resets_at: "2030-01-01T00:00:00Z" }, seven_day: { utilization: 10 } });
	};
}

function service(options: { path: string; fetch: FetchImpl; handles: AccountHandle[]; clock: { now: number } }) {
	return new UsageService({
		cachePath: options.path,
		fetch: options.fetch,
		now: () => options.clock.now,
		discover: async (_registry, providers: readonly ProviderId[]) =>
			options.handles.filter((handle) => providers.includes(handle.provider)),
	});
}

const main: AccountHandle = { provider: "anthropic", accountKey: "main", label: "main", token: "tok" };

test("mergeLimits replaces by id, keeps order, appends new", () => {
	const a = { id: "a", label: "A", status: "ok" } as UsageLimit;
	const b = { id: "b", label: "B", status: "ok" } as UsageLimit;
	const b2 = { ...b, label: "B2" };
	const c = { id: "c", label: "C", status: "ok" } as UsageLimit;
	assert.deepEqual(
		mergeLimits([a, b], [b2, c]).map((l) => l.label),
		["A", "B2", "C"],
	);
});

test("poll once per TTL; second process reuses shared cache", async () => {
	const path = freshPath();
	const clock = { now: 1_000_000 };
	const calls: string[] = [];
	const first = service({ path, fetch: claudeFetch(calls), handles: [main], clock });
	const [account] = await first.accounts(registry, ["anthropic"]);
	assert.equal(account.report?.limits[0].usedFraction, 0.4);
	assert.equal(account.label, "me@x.com");
	assert.equal(account.report?.plan, "Max");
	assert.equal(calls.length, 2); // usage + profile

	const secondCalls: string[] = [];
	const second = service({ path, fetch: claudeFetch(secondCalls), handles: [main], clock });
	await second.accounts(registry, ["anthropic"]);
	assert.equal(secondCalls.length, 0, "fresh disk entry → no poll");

	clock.now += POLL_TTL_MS + 1;
	await second.accounts(registry, ["anthropic"]);
	assert.deepEqual(secondCalls.map((u) => u.split("/").at(-1)), ["usage"], "profile reused from cached report");
});

test("force bypasses TTL; concurrent refreshes share one poll", async () => {
	const path = freshPath();
	const clock = { now: 1_000_000 };
	const calls: string[] = [];
	const svc = service({ path, fetch: claudeFetch(calls), handles: [main], clock });
	await Promise.all([svc.accounts(registry, ["anthropic"]), svc.accounts(registry, ["anthropic"])]);
	assert.equal(calls.filter((u) => u.endsWith("/usage")).length, 1);
	await svc.accounts(registry, ["anthropic"], { force: true });
	assert.equal(calls.filter((u) => u.endsWith("/usage")).length, 2);
});

test("429 → error kept with prior report, backoff blocks even forced polls", async () => {
	const path = freshPath();
	const clock = { now: 1_000_000 };
	const okCalls: string[] = [];
	await service({ path, fetch: claudeFetch(okCalls), handles: [main], clock }).accounts(registry, ["anthropic"]);

	clock.now += POLL_TTL_MS + 1;
	const calls: string[] = [];
	const svc = service({ path, fetch: claudeFetch(calls, 429), handles: [main], clock });
	const [account] = await svc.accounts(registry, ["anthropic"]);
	assert.equal(account.error, "rate limited (HTTP 429)");
	assert.equal(account.report?.limits[0].usedFraction, 0.4, "stale report survives");
	const entry = (await readCache(path))["anthropic:main"];
	assert.equal(entry?.retryAt, clock.now + 60_000);

	await svc.accounts(registry, ["anthropic"], { force: true });
	assert.equal(calls.length, 1, "backoff honoured");
});

test("tokenless fallback uses anthropic-auth snapshot; unavailable reason surfaces", async () => {
	const clock = { now: 5_000_000 };
	const handles: AccountHandle[] = [
		{
			provider: "anthropic",
			accountKey: "fb1",
			label: "work",
			unavailable: "token expired",
			snapshot: {
				checkedAt: 4_000_000,
				quota: { five_hour: { usedPercent: 70, remainingPercent: 30 } } as never,
			},
		},
		{ provider: "anthropic", accountKey: "fb2", label: "old", unavailable: "token expired" },
	];
	const svc = service({ path: freshPath(), fetch: claudeFetch([]), handles, clock });
	const [snap, none] = await svc.accounts(registry, ["anthropic"]);
	assert.equal(snap.report?.source, "snapshot");
	assert.equal(snap.report?.fetchedAt, 4_000_000);
	assert.equal(snap.report?.limits[0].usedFraction, 0.7);
	assert.equal(none.report, undefined);
	assert.equal(none.error, "token expired");
});

test("ingestHeaders: routes by anthropic-auth account header, merges, skips api routes", async () => {
	const path = freshPath();
	const clock = { now: 1_000_000 };
	const svc = service({ path, fetch: claudeFetch([]), handles: [main], clock });
	await svc.accounts(registry, ["anthropic"]);

	clock.now += 1000;
	const ok = await svc.ingestHeaders(
		{ "Anthropic-Ratelimit-Unified-5h-Utilization": "0.75", "x-pi-anthropic-auth-account": "main" },
		200,
	);
	assert.equal(ok, true);
	const report = svc.report("anthropic", "main");
	assert.equal(report?.limits.find((l) => l.id === "anthropic:5h")?.usedFraction, 0.75);
	assert.equal(report?.limits.find((l) => l.id === "anthropic:7d")?.usedFraction, 0.1, "poll row kept");
	assert.equal(report?.label, "me@x.com");
	assert.equal(report?.headersAt, clock.now);
	assert.equal(svc.entry("anthropic", "main")?.polledAt, 1_000_000, "headers never postpone polls");

	await svc.ingestHeaders(
		{ "anthropic-ratelimit-unified-5h-utilization": "0.2", "x-pi-anthropic-auth-account": "fb9" },
		200,
	);
	assert.equal(svc.lastAnthropicAccount, "fb9");
	assert.equal(svc.report("anthropic", "fb9")?.source, "headers");

	assert.equal(
		await svc.ingestHeaders(
			{ "anthropic-ratelimit-unified-5h-utilization": "0.2", "x-pi-anthropic-auth-account": "api:k" },
			200,
		),
		false,
	);
	assert.equal(svc.lastAnthropicAccount, "fb9");
	assert.equal(await svc.ingestHeaders({ "content-type": "text/event-stream" }, 200), false);
	// First ingest for an account persists immediately (no prior persist).
	const disk = JSON.parse(await readFile(path, "utf8"));
	assert.ok(disk.entries["anthropic:fb9"]);
});

test("codex live updates (headers + ws event) need a discovered account", async () => {
	const clock = { now: 1_000_000 };
	const codex: AccountHandle = { provider: "openai-codex", accountKey: "acct", label: "me" };
	const svc = service({ path: freshPath(), fetch: claudeFetch([]), handles: [codex], clock });
	const headers = { "x-codex-primary-used-percent": "30", "x-codex-primary-window-minutes": "300" };
	assert.equal(await svc.ingestHeaders(headers, 200), false);
	await svc.accounts(registry, ["openai-codex"]);
	assert.equal(await svc.ingestHeaders(headers, 200), true);
	assert.equal(svc.report("openai-codex", "acct")?.limits[0].usedFraction, 0.3);
	const event = {
		type: "codex.rate_limits",
		rate_limits: { allowed: true, limit_reached: false, primary: { used_percent: 55, window_minutes: 300 } },
	};
	assert.equal(await svc.ingestCodexEvent(event), true);
	assert.equal(svc.report("openai-codex", "acct")?.limits[0].usedFraction, 0.55);
	assert.equal(await svc.ingestCodexEvent({ type: "other" }), false);
});

test("cache: merge-write keeps other entries, prunes >1 day idle, ignores garbage", async () => {
	const path = freshPath();
	const now = 10 * 86_400_000;
	await writeCache(path, { "a:1": { polledAt: now - 2 * 86_400_000 }, "b:1": { polledAt: now } }, now - 2 * 86_400_000);
	await writeCache(path, { "c:1": { polledAt: now } }, now);
	assert.deepEqual(Object.keys(await readCache(path)).sort(), ["b:1", "c:1"]);
	const bad = freshPath();
	await writeCache(bad, { "x:1": { polledAt: now } }, now);
	await (await import("node:fs/promises")).writeFile(bad, '{"version":1,"entries":{"x:1":{"polledAt":"nope"}}}');
	assert.deepEqual(await readCache(bad), {});
	assert.deepEqual(await readCache(join(dir, "missing.json")), {});
});
