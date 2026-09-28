import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderDashboard, type Style } from "../dashboard.ts";
import { footerLimits, formatFooter } from "../footer.ts";
import type { UsageReport } from "../types.ts";

const now = 1_000_000_000;
const report: UsageReport = {
	provider: "anthropic",
	accountKey: "main",
	label: "me@x.com",
	plan: "Max",
	fetchedAt: now - 120_000,
	source: "poll",
	limits: [
		{ id: "anthropic:7d", label: "Weekly", windowTag: "7d", durationMs: 604_800_000, usedFraction: 0.12, status: "ok", shared: true },
		{
			id: "anthropic:5h",
			label: "5 Hour",
			windowTag: "5h",
			durationMs: 18_000_000,
			usedFraction: 0.48,
			resetsAt: now + 2 * 3_600_000 + 13 * 60_000,
			status: "ok",
			shared: true,
		},
		{ id: "anthropic:7d:opus", label: "Weekly (Opus)", windowTag: "7d", usedFraction: 0.9, status: "warning", tier: "opus" },
		{
			id: "anthropic:extra",
			label: "Extra usage",
			windowTag: "mo",
			amount: { used: 12.3, limit: 50, unit: "USD" },
			usedFraction: 0.246,
			status: "ok",
		},
	],
};

const plain: Style = { fg: (_c, text) => text, bold: (text) => text };

test("footer: shared windows shortest-first + model-scoped tier only for matching model", () => {
	assert.deepEqual(
		footerLimits(report, "claude-sonnet-4-6").map((l) => l.id),
		["anthropic:5h", "anthropic:7d"],
	);
	assert.deepEqual(
		footerLimits(report, "claude-opus-4-8").map((l) => l.id),
		["anthropic:5h", "anthropic:7d", "anthropic:7d:opus"],
	);
	assert.equal(formatFooter(report, "claude-opus-4-8", (_c, t) => t, now), "5h 48% 2h13m · 7d 12% · 7d·opus 90%");
	assert.equal(formatFooter({ ...report, limits: [] }, undefined, (_c, t) => t, now), undefined);
});

test("dashboard: cards per provider, bars, active marker, errors, width-safe", () => {
	const lines = renderDashboard(
		{
			accounts: [
				{ provider: "anthropic", accountKey: "main", label: "me@x.com", report },
				{ provider: "anthropic", accountKey: "fb1", label: "work", error: "token expired" },
				{ provider: "opencode-go", accountKey: "k", label: "key …abcd", error: "rate limited (HTTP 429)" },
			],
			loading: false,
			activeKey: "anthropic:main",
			now,
		},
		70,
		plain,
	);
	const text = lines.join("\n");
	assert.match(text, /╭─ Claude /);
	assert.match(text, /╭─ OpenCode Go /);
	assert.doesNotMatch(text, /╭─ Codex/);
	assert.match(text, /● main · me@x\.com · Max/);
	assert.match(text, /5 Hour\s+█+░+\s+48%\s+↻ 2h13m/);
	assert.match(text, /Extra usage\s+█*░+\s+25%\s+\$12\.30 \/ \$50\.00/);
	assert.match(text, /polled 2m ago/);
	assert.match(text, /⚠ token expired/);
	for (const line of lines) assert.ok(visibleWidth(line) <= 70, `overflow: ${line}`);

	for (const width of [20, 40, 200]) {
		for (const line of renderDashboard({ accounts: [{ provider: "anthropic", accountKey: "main", label: "x", report }], loading: true, now }, width, plain)) {
			assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
		}
	}
	const codex = renderDashboard(
		{
			accounts: [
				{
					provider: "openai-codex",
					accountKey: "a",
					label: "me",
					report: {
						...report,
						provider: "openai-codex",
						limits: [
							{
								id: "openai-codex:spend",
								label: "Workspace credits (very long label)",
								amount: { used: 944.25, limit: 20_000, unit: "credit" },
								usedFraction: 0.047,
								status: "ok",
							},
						],
					},
				},
			],
			loading: false,
			now,
		},
		90,
		plain,
	)
		.join("\n")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: strip SGR resets from truncation
		.replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(codex, /│ {3}Workspace credit… █*░+ +5% {2}944 \/ 20,000 credits/);
	assert.match(renderDashboard({ accounts: [], loading: false, now }, 80, plain).join("\n"), /No Claude, Codex, or OpenCode Go credentials/);
	assert.match(codex, /^Claude: no credentials — \/login anthropic$/m);
	assert.match(codex, /^OpenCode Go: no credentials — OPENCODE_API_KEY or \/login opencode-go$/m);
});
