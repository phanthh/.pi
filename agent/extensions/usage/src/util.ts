import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { UsageStatus } from "./types.ts";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

/** Boundary parse: the value when it matches `schema`, else undefined. */
export function parseAs<T extends TSchema>(schema: T, value: unknown): Static<T> | undefined {
	return Value.Check(schema, value) ? (value as Static<T>) : undefined;
}

export function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

export function parseIsoMs(value: unknown): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

export function clampFraction(percent: number): number {
	return Math.min(Math.max(percent, 0), 100) / 100;
}

export function statusForFraction(fraction: number | undefined, warnAt = 0.9): UsageStatus {
	if (fraction === undefined) return "unknown";
	if (fraction >= 1) return "exhausted";
	if (fraction >= warnAt) return "warning";
	return "ok";
}

/** `Retry-After` as ms (seconds or HTTP date). */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
	if (!value?.trim()) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Compact countdown: `45s`, `12m`, `2h30m`, `6d4h`. */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0m";
	if (ms < MINUTE_MS) return `${Math.floor(ms / 1000)}s`;
	if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`;
	if (ms < DAY_MS) {
		const h = Math.floor(ms / HOUR_MS);
		const m = Math.floor((ms % HOUR_MS) / MINUTE_MS);
		return m > 0 ? `${h}h${m}m` : `${h}h`;
	}
	const d = Math.floor(ms / DAY_MS);
	const h = Math.floor((ms % DAY_MS) / HOUR_MS);
	return h > 0 ? `${d}d${h}h` : `${d}d`;
}

/** Compact window tag from a duration: `5h`, `7d`, `mo`. */
export function windowTag(durationMs: number | undefined, fallback: string): string {
	if (!durationMs) return fallback;
	const hours = durationMs / HOUR_MS;
	if (hours >= 28 * 24) return "mo";
	if (hours >= 24) return `${Math.round(hours / 24)}d`;
	return `${Math.max(1, Math.round(hours))}h`;
}

export function slugify(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function decodeJwtPayload(token: string | undefined): unknown {
	const part = token?.split(".")[1];
	if (!part) return undefined;
	try {
		return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
	} catch {
		return undefined;
	}
}

/** Strip control chars from provider-supplied text before it reaches the terminal. */
export function sanitize(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional
	return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
}

function isCredits(unit: string): boolean {
	return /^credits?$/i.test(unit);
}

export function formatMoney(amount: number, unit: string): string {
	const upper = unit.toUpperCase();
	const symbol = upper === "USD" ? "$" : upper === "GBP" ? "£" : upper === "EUR" ? "€" : undefined;
	if (symbol) return `${symbol}${amount.toFixed(2)}`;
	if (isCredits(unit)) return `${Math.round(amount).toLocaleString("en-US")} credits`;
	return `${amount.toFixed(2)} ${unit}`;
}

/** `$12.30 / $50.00`, `944 / 20,000 credits`. */
export function formatAmount(amount: { used: number; limit?: number; unit: string }): string {
	if (amount.limit === undefined) return formatMoney(amount.used, amount.unit);
	if (isCredits(amount.unit)) {
		const n = (value: number) => Math.round(value).toLocaleString("en-US");
		return `${n(amount.used)} / ${n(amount.limit)} credits`;
	}
	return `${formatMoney(amount.used, amount.unit)} / ${formatMoney(amount.limit, amount.unit)}`;
}
