export type ProviderId = "anthropic" | "openai-codex" | "opencode-go";

export const PROVIDERS: readonly ProviderId[] = ["anthropic", "openai-codex", "opencode-go"];

export const PROVIDER_NAMES: Record<ProviderId, string> = {
	anthropic: "Claude",
	"openai-codex": "Codex",
	"opencode-go": "OpenCode Go",
};

export type UsageStatus = "ok" | "warning" | "exhausted" | "unknown";

/** One quota window or balance, normalized across providers. */
export interface UsageLimit {
	/** Stable id, e.g. `anthropic:5h`, `openai-codex:primary`. Header merges replace by id. */
	id: string;
	/** Display label, e.g. `5 Hour`, `Weekly (Opus)`. */
	label: string;
	/** Compact window tag (`5h`, `7d`, `mo`) for footer/cards. */
	windowTag?: string;
	durationMs?: number;
	resetsAt?: number;
	/** 0..1 used; undefined for one-sided amounts. */
	usedFraction?: number;
	/** Absolute amount (money/credits) when the provider reports one. */
	amount?: { used: number; limit?: number; unit: string };
	status: UsageStatus;
	/** Gates every request on the account, whatever the model. */
	shared?: boolean;
	/** Model family slug for model-scoped windows (`opus`, `sonnet`, `spark`). */
	tier?: string;
}

export interface UsageReport {
	provider: ProviderId;
	/** Cache/merge identity: `main`, fallback id, ChatGPT account id, key hash. */
	accountKey: string;
	/** Human identity (email / label). */
	label?: string;
	plan?: string;
	fetchedAt: number;
	/** Last time response headers refreshed the windows. */
	headersAt?: number;
	source: "poll" | "headers" | "snapshot";
	limits: UsageLimit[];
}

/** An account the extension knows about, with or without a report. */
export interface UsageAccount {
	provider: ProviderId;
	accountKey: string;
	label: string;
	report?: UsageReport;
	/** Why no fresh report is available (auth missing, 429, network…). */
	error?: string;
}

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export class UsageHttpError extends Error {
	readonly status: number;
	readonly retryAfterMs?: number;

	// No parameter properties: node's type stripping runs the tests.
	constructor(message: string, status: number, retryAfterMs?: number) {
		super(message);
		this.name = "UsageHttpError";
		this.status = status;
		if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
	}
}
