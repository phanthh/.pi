/**
 * OpenCode Go usage via `GET opencode.ai/zen/go/v1/usage`, ported from omp
 * `packages/ai/src/usage/opencode-go.ts`. First-party but undocumented route;
 * per window `status` is `ok | rate-limited`, `percent` a floored 0-100 int,
 * `resetsAt` ISO. Monthly anchors on the subscription anniversary, so it has
 * no fixed duration.
 */
import { Type } from "typebox";
import type { FetchImpl, UsageLimit } from "../types.ts";
import { UsageHttpError } from "../types.ts";
import { clampFraction, DAY_MS, HOUR_MS, parseAs, parseIsoMs, parseRetryAfterMs, statusForFraction } from "../util.ts";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

const WINDOWS = [
	{ key: "rolling", id: "opencode-go:5h", label: "5 Hour", tag: "5h", durationMs: 5 * HOUR_MS },
	{ key: "weekly", id: "opencode-go:7d", label: "Weekly", tag: "7d", durationMs: 7 * DAY_MS },
	{ key: "monthly", id: "opencode-go:monthly", label: "Monthly", tag: "mo", durationMs: undefined },
] as const;

const Window = Type.Object({
	status: Type.Union([Type.Literal("ok"), Type.Literal("rate-limited")]),
	percent: Type.Number({ minimum: 0, maximum: 100 }),
	resetsAt: Type.String(),
});

const Payload = Type.Object({ usage: Type.Record(Type.String(), Type.Unknown()) });

/** Parse one `/v1/usage` body; malformed windows are skipped. */
export function parseOpenCodeGoPayload(value: unknown): UsageLimit[] {
	const payload = parseAs(Payload, value);
	if (!payload) return [];
	const limits: UsageLimit[] = [];
	for (const descriptor of WINDOWS) {
		const window = parseAs(Window, payload.usage[descriptor.key]);
		const resetsAt = parseIsoMs(window?.resetsAt);
		if (!window || resetsAt === undefined) continue;
		const usedFraction = clampFraction(window.percent);
		limits.push({
			id: descriptor.id,
			label: descriptor.label,
			windowTag: descriptor.tag,
			...(descriptor.durationMs !== undefined ? { durationMs: descriptor.durationMs } : {}),
			resetsAt,
			usedFraction,
			status: window.status === "rate-limited" ? "exhausted" : statusForFraction(usedFraction, 0.8),
			// Monthly is display-only: "Use balance" can keep an exhausted month serving.
			shared: descriptor.key !== "monthly",
		});
	}
	return limits;
}

export async function fetchOpenCodeGoUsage(
	apiKey: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<UsageLimit[]> {
	const response = await fetchImpl(USAGE_URL, {
		headers: { accept: "application/json", authorization: `Bearer ${apiKey}`, "User-Agent": "pi-usage-extension" },
		signal,
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new UsageHttpError(
			response.status === 403
				? "OpenCode Go: no active subscription (HTTP 403)"
				: `OpenCode Go usage returned HTTP ${response.status}`,
			response.status,
			parseRetryAfterMs(response.headers.get("retry-after")),
		);
	}
	const limits = parseOpenCodeGoPayload(await response.json());
	if (limits.length === 0) throw new UsageHttpError("OpenCode Go usage response had no windows", response.status);
	return limits;
}
