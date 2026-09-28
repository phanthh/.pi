/**
 * Cross-process report cache (`~/.pi/agent/cache/usage.json`). Every pi
 * process (main session + tmux subagents) reads it before polling, so one
 * account is polled at most once per TTL machine-wide — Anthropic's usage
 * endpoint rate-limits per source IP.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "typebox";
import type { UsageReport } from "./types.ts";
import { DAY_MS, parseAs } from "./util.ts";

export interface CacheEntry {
	report?: UsageReport;
	/** Last poll attempt (success or failure). */
	polledAt: number;
	error?: string;
	/** Poll backoff (429 / failures): no poll before this. */
	retryAt?: number;
}

const CacheFile = Type.Object({
	version: Type.Literal(1),
	entries: Type.Record(Type.String(), Type.Unknown()),
});

const Entry = Type.Object({
	polledAt: Type.Number(),
	report: Type.Optional(
		Type.Object({
			provider: Type.String(),
			accountKey: Type.String(),
			fetchedAt: Type.Number(),
			limits: Type.Array(Type.Object({ id: Type.String(), label: Type.String(), status: Type.String() })),
		}),
	),
	error: Type.Optional(Type.String()),
	retryAt: Type.Optional(Type.Number()),
});

export async function readCache(path: string): Promise<Record<string, CacheEntry>> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch {
		return {};
	}
	const file = parseAs(CacheFile, raw);
	if (!file) return {};
	const entries: Record<string, CacheEntry> = {};
	for (const [key, value] of Object.entries(file.entries)) {
		// Own file, own writer: a shape match is the trust boundary.
		if (parseAs(Entry, value)) entries[key] = value as CacheEntry;
	}
	return entries;
}

/** Read-merge-write: other processes' entries survive; entries idle >1 day are pruned. */
export async function writeCache(path: string, updates: Record<string, CacheEntry>, now = Date.now()): Promise<void> {
	const entries = { ...(await readCache(path)), ...updates };
	for (const [key, entry] of Object.entries(entries)) {
		const lastSeen = Math.max(entry.polledAt, entry.report?.fetchedAt ?? 0, entry.report?.headersAt ?? 0);
		if (now - lastSeen > DAY_MS) delete entries[key];
	}
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, `${JSON.stringify({ version: 1, entries })}\n`, { mode: 0o600 });
		await rename(temp, path);
	} finally {
		await rm(temp, { force: true }).catch(() => {});
	}
}
