import { type AccountHandle, ANTHROPIC_ACCOUNT_HEADER, ANTHROPIC_MAIN_KEY, type CredentialSource, discoverAccounts } from "./accounts.ts";
import { type CacheEntry, readCache, writeCache } from "./cache.ts";
import { fetchClaudeProfile, fetchClaudeUsage, limitsFromQuotaSnapshot, parseClaudeRateLimitHeaders } from "./providers/claude.ts";
import { fetchCodexUsage, parseCodexRateLimitHeaders, parseCodexRateLimitsEvent } from "./providers/codex.ts";
import { fetchOpenCodeGoUsage } from "./providers/opencode-go.ts";
import {
	type FetchImpl,
	type ProviderId,
	type UsageAccount,
	UsageHttpError,
	type UsageLimit,
	type UsageReport,
} from "./types.ts";
import { MINUTE_MS } from "./util.ts";

export const POLL_TTL_MS = 5 * MINUTE_MS;
const FAILURE_BACKOFF_MS = 2 * MINUTE_MS;
const RATE_LIMIT_BACKOFF_MS = 5 * MINUTE_MS;
const HEADER_PERSIST_INTERVAL_MS = 15_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface UsageServiceOptions {
	cachePath: string;
	fetch?: FetchImpl;
	now?: () => number;
	/** Test seam; defaults to {@link discoverAccounts}. */
	discover?: (registry: CredentialSource, providers: readonly ProviderId[]) => Promise<AccountHandle[]>;
}

const keyOf = (provider: ProviderId, accountKey: string) => `${provider}:${accountKey}`;

/** Replace limits by id, keep the rest; header windows refresh poll rows in place. */
export function mergeLimits(prior: readonly UsageLimit[], incoming: readonly UsageLimit[]): UsageLimit[] {
	const byId = new Map(incoming.map((limit) => [limit.id, limit]));
	const merged = prior.map((limit) => {
		const next = byId.get(limit.id);
		byId.delete(limit.id);
		return next ?? limit;
	});
	return [...merged, ...byId.values()];
}

function errorText(error: unknown): string {
	if (error instanceof UsageHttpError) return error.status === 429 ? "rate limited (HTTP 429)" : error.message;
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timed out";
	return error instanceof Error ? error.message : String(error);
}

export class UsageService {
	readonly #cachePath: string;
	readonly #fetch: FetchImpl;
	readonly #now: () => number;
	readonly #discover: NonNullable<UsageServiceOptions["discover"]>;
	#entries: Record<string, CacheEntry> = {};
	#handles: AccountHandle[] = [];
	readonly #inflight = new Map<string, Promise<CacheEntry>>();
	readonly #lastPersist = new Map<string, number>();
	readonly #listeners = new Set<() => void>();
	/** anthropic-auth account that served the latest response in this process. */
	lastAnthropicAccount = ANTHROPIC_MAIN_KEY;

	constructor(options: UsageServiceOptions) {
		this.#cachePath = options.cachePath;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#now = options.now ?? Date.now;
		this.#discover = options.discover ?? ((registry, providers) => discoverAccounts(registry, providers));
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(): void {
		for (const listener of this.#listeners) listener();
	}

	/** Cached report without I/O. */
	report(provider: ProviderId, accountKey: string): UsageReport | undefined {
		return this.#entries[keyOf(provider, accountKey)]?.report;
	}

	entry(provider: ProviderId, accountKey: string): CacheEntry | undefined {
		return this.#entries[keyOf(provider, accountKey)];
	}

	/** Load the shared cache file so other processes' polls show without a fetch. */
	async hydrate(): Promise<void> {
		const disk = await readCache(this.#cachePath);
		for (const [key, entry] of Object.entries(disk)) {
			const mine = this.#entries[key];
			if (!mine || entry.polledAt > mine.polledAt) this.#entries[key] = entry;
		}
		this.#emit();
	}

	/** Discover accounts and refresh the stale ones. */
	async accounts(
		registry: CredentialSource,
		providers: readonly ProviderId[],
		options: { force?: boolean } = {},
	): Promise<UsageAccount[]> {
		const handles = await this.#discover(registry, providers);
		this.#handles = [
			...this.#handles.filter((handle) => !providers.includes(handle.provider)),
			...handles,
		];
		await Promise.all(handles.map((handle) => this.#refresh(handle, options.force ?? false)));
		return handles.map((handle) => {
			const entry = this.#entries[keyOf(handle.provider, handle.accountKey)];
			return {
				provider: handle.provider,
				accountKey: handle.accountKey,
				label: entry?.report?.label ?? handle.label,
				...(entry?.report ? { report: entry.report } : {}),
				...(entry?.error ? { error: entry.error } : handle.unavailable && !handle.token ? { error: handle.unavailable } : {}),
			};
		});
	}

	#refresh(handle: AccountHandle, force: boolean): Promise<CacheEntry> {
		const key = keyOf(handle.provider, handle.accountKey);
		const running = this.#inflight.get(key);
		if (running) return running;
		const task = this.#refreshUncached(handle, key, force).finally(() => this.#inflight.delete(key));
		this.#inflight.set(key, task);
		return task;
	}

	async #refreshUncached(handle: AccountHandle, key: string, force: boolean): Promise<CacheEntry> {
		const now = this.#now();
		const disk = (await readCache(this.#cachePath))[key];
		const memory = this.#entries[key];
		const cached = disk && (!memory || disk.polledAt >= memory.polledAt) ? disk : memory;
		// Keep the freshest header merge from this process.
		if (cached && memory?.report?.headersAt && (cached.report?.headersAt ?? 0) < memory.report.headersAt) {
			cached.report = memory.report;
		}
		if (cached) this.#entries[key] = cached;
		const fresh = cached && now - cached.polledAt < POLL_TTL_MS;
		const backingOff = cached?.retryAt !== undefined && cached.retryAt > now;
		if (cached && (backingOff || (fresh && !force))) return cached;

		let entry: CacheEntry;
		if (handle.token) {
			try {
				entry = { polledAt: now, report: await this.#poll(handle, handle.token, cached?.report) };
			} catch (error) {
				const retryAfter =
					error instanceof UsageHttpError && error.status === 429
						? (error.retryAfterMs ?? RATE_LIMIT_BACKOFF_MS)
						: FAILURE_BACKOFF_MS;
				entry = {
					polledAt: now,
					...(cached?.report ? { report: cached.report } : {}),
					error: errorText(error),
					retryAt: now + Math.max(retryAfter, 30_000),
				};
			}
		} else if (handle.snapshot) {
			// Headers ingested after anthropic-auth's snapshot are newer: keep them.
			const priorSeen = Math.max(cached?.report?.fetchedAt ?? 0, cached?.report?.headersAt ?? 0);
			const snapshotReport: UsageReport = {
				provider: handle.provider,
				accountKey: handle.accountKey,
				label: handle.label,
				fetchedAt: handle.snapshot.checkedAt,
				source: "snapshot",
				limits: limitsFromQuotaSnapshot(handle.snapshot.quota),
			};
			entry = {
				polledAt: now,
				report: cached?.report && priorSeen >= handle.snapshot.checkedAt ? cached.report : snapshotReport,
			};
		} else {
			entry = {
				polledAt: now,
				...(cached?.report ? { report: cached.report } : {}),
				error: handle.unavailable ?? "no credential",
			};
		}
		this.#entries[key] = entry;
		await writeCache(this.#cachePath, { [key]: entry }, now).catch(() => {});
		this.#emit();
		return entry;
	}

	async #poll(handle: AccountHandle, token: string, prior: UsageReport | undefined): Promise<UsageReport> {
		const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
		const base = { provider: handle.provider, accountKey: handle.accountKey, fetchedAt: this.#now(), source: "poll" as const };
		if (handle.provider === "anthropic") {
			const limits = await fetchClaudeUsage(token, this.#fetch, signal);
			// Identity rarely changes: one profile call per account, reused afterwards.
			const profile =
				prior?.label && prior.plan ? { email: prior.label, plan: prior.plan } : await fetchClaudeProfile(token, this.#fetch, signal);
			const label = profile?.email ?? (handle.accountKey === ANTHROPIC_MAIN_KEY ? prior?.label : handle.label);
			return { ...base, ...(label ? { label } : {}), ...(profile?.plan ? { plan: profile.plan } : {}), limits };
		}
		if (handle.provider === "openai-codex") {
			const usage = await fetchCodexUsage(token, this.#fetch, signal);
			return { ...base, label: handle.label, ...(usage.plan ? { plan: usage.plan } : {}), limits: usage.limits };
		}
		const limits = await fetchOpenCodeGoUsage(token, this.#fetch, signal);
		return { ...base, label: handle.label, plan: "Go", limits };
	}

	/**
	 * Merge rate-limit response headers into the serving account's report.
	 * Headers self-identify the provider; anthropic-auth names the account.
	 */
	async ingestHeaders(headers: Record<string, string>, status: number): Promise<boolean> {
		const lower: Record<string, string> = {};
		for (const [name, value] of Object.entries(headers)) lower[name.toLowerCase()] = value;
		let provider: ProviderId;
		let accountKey: string;
		let limits: UsageLimit[];
		if ("anthropic-ratelimit-unified-5h-utilization" in lower || "anthropic-ratelimit-unified-7d-utilization" in lower) {
			provider = "anthropic";
			accountKey = lower[ANTHROPIC_ACCOUNT_HEADER] || ANTHROPIC_MAIN_KEY;
			// API-key routes carry no subscription quota.
			if (accountKey.startsWith("api:")) return false;
			this.lastAnthropicAccount = accountKey;
			limits = parseClaudeRateLimitHeaders(lower);
		} else if ("x-codex-primary-used-percent" in lower || "x-codex-secondary-used-percent" in lower) {
			provider = "openai-codex";
			const handle = this.#handles.find((candidate) => candidate.provider === "openai-codex");
			if (!handle) return false;
			accountKey = handle.accountKey;
			limits = parseCodexRateLimitHeaders(lower, status, this.#now());
		} else {
			return false;
		}
		return this.#mergeLive(provider, accountKey, limits);
	}

	/** Merge a websocket `codex.rate_limits` stream event into the Codex account. */
	async ingestCodexEvent(data: unknown): Promise<boolean> {
		const usage = parseCodexRateLimitsEvent(data, this.#now());
		const handle = this.#handles.find((candidate) => candidate.provider === "openai-codex");
		if (!usage || !handle) return false;
		return this.#mergeLive("openai-codex", handle.accountKey, usage.limits);
	}

	async #mergeLive(provider: ProviderId, accountKey: string, limits: UsageLimit[]): Promise<boolean> {
		if (limits.length === 0) return false;
		const now = this.#now();
		const key = keyOf(provider, accountKey);
		const prior = this.#entries[key];
		const report: UsageReport = prior?.report
			? { ...prior.report, limits: mergeLimits(prior.report.limits, limits), headersAt: now }
			: { provider, accountKey, fetchedAt: now, headersAt: now, source: "headers", limits };
		// polledAt untouched: live updates never postpone the next full poll (extra usage, scoped rows).
		const entry: CacheEntry = { ...(prior ?? { polledAt: 0 }), report };
		this.#entries[key] = entry;
		this.#emit();
		const exhausted = limits.some((limit) => limit.status === "exhausted");
		if (exhausted || now - (this.#lastPersist.get(key) ?? 0) >= HEADER_PERSIST_INTERVAL_MS) {
			this.#lastPersist.set(key, now);
			await writeCache(this.#cachePath, { [key]: entry }, now).catch(() => {});
		}
		return true;
	}
}
