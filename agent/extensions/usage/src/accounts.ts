/**
 * Account discovery for the three supported subscriptions.
 *
 *   anthropic     main  → pi auth (`anthropic` OAuth, refreshed by pi)
 *                 fallbacks → anthropic-auth store (`anthropic-auth.json` + state).
 *                   Live token only while unexpired: refreshing here would race
 *                   anthropic-auth's rotating refresh tokens. Otherwise its
 *                   persisted quota snapshot stands in.
 *   openai-codex  pi auth OAuth; identity from the access-token JWT
 *   opencode-go   pi auth / env API key
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { OAuthQuotaSnapshot } from "../../anthropic-auth/src/core/accounts.ts";
import { codexIdentity } from "./providers/codex.ts";
import type { ProviderId } from "./types.ts";

/** Response header anthropic-auth stamps on `onResponse` to name the serving account. */
export const ANTHROPIC_ACCOUNT_HEADER = "x-pi-anthropic-auth-account";
export const ANTHROPIC_MAIN_KEY = "main";

export interface AccountHandle {
	provider: ProviderId;
	accountKey: string;
	/** Fallback display label until a report supplies one. */
	label: string;
	/** Live credential; undefined → no poll possible. */
	token?: string;
	/** anthropic-auth persisted quota for fallbacks without a live token. */
	snapshot?: { quota: OAuthQuotaSnapshot; checkedAt: number };
	/** Why `token` is missing. */
	unavailable?: string;
}

export interface CredentialSource {
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

const TOKEN_EXPIRY_MARGIN_MS = 60_000;

async function tokenFor(registry: CredentialSource, provider: string): Promise<string | undefined> {
	try {
		return (await registry.getApiKeyForProvider(provider))?.trim() || undefined;
	} catch {
		return undefined;
	}
}

function anthropicAuthPath(): string {
	return process.env.PI_ANTHROPIC_AUTH_FILE?.trim() || join(getAgentDir(), "anthropic-auth.json");
}

type AnthropicAuthAccounts = typeof import("../../anthropic-auth/src/core/accounts.ts");

async function anthropicFallbacks(now: number): Promise<AccountHandle[]> {
	let mod: AnthropicAuthAccounts;
	let storage: Awaited<ReturnType<AnthropicAuthAccounts["loadAccounts"]>>;
	try {
		// Lazy: keeps anthropic-auth's module graph out of unit tests.
		mod = await import("../../anthropic-auth/src/core/accounts.ts");
		storage = await mod.loadAccounts(anthropicAuthPath());
	} catch {
		return [];
	}
	const { isOAuthAccount, quotaSnapshotCheckedAt } = mod;
	const handles: AccountHandle[] = [];
	for (const account of storage?.accounts ?? []) {
		if (!isOAuthAccount(account) || account.enabled === false) continue;
		const label = account.label?.trim() || `fallback ${account.id.slice(0, 8)}`;
		const live = account.access && (account.expires ?? 0) > now + TOKEN_EXPIRY_MARGIN_MS;
		const checkedAt = quotaSnapshotCheckedAt(account.quota);
		handles.push({
			provider: "anthropic",
			accountKey: account.id,
			label,
			...(live ? { token: account.access } : { unavailable: "token expired (anthropic-auth refreshes on use)" }),
			...(account.quota && checkedAt ? { snapshot: { quota: account.quota, checkedAt } } : {}),
		});
	}
	return handles;
}

function isAnthropicOAuthToken(token: string): boolean {
	return !token.startsWith("sk-ant-api");
}

export async function discoverAccounts(
	registry: CredentialSource,
	providers: readonly ProviderId[],
	now = Date.now(),
): Promise<AccountHandle[]> {
	const found = await Promise.all(
		providers.map(async (provider): Promise<AccountHandle[]> => {
			if (provider === "anthropic") {
				const token = await tokenFor(registry, "anthropic");
				const main: AccountHandle[] = token
					? [
							{
								provider,
								accountKey: ANTHROPIC_MAIN_KEY,
								label: "main",
								...(isAnthropicOAuthToken(token)
									? { token }
									: { unavailable: "API key — subscription usage needs OAuth login" }),
							},
						]
					: [];
				return [...main, ...(await anthropicFallbacks(now))];
			}
			if (provider === "openai-codex") {
				const token = await tokenFor(registry, "openai-codex");
				if (!token) return [];
				const identity = codexIdentity(token);
				return [
					{
						provider,
						accountKey: identity.accountId ?? "default",
						label: identity.email ?? identity.accountId ?? "account",
						token,
					},
				];
			}
			const token = await tokenFor(registry, "opencode-go");
			if (!token) return [];
			const hash = createHash("sha256").update(token).digest("hex").slice(0, 12);
			return [{ provider, accountKey: hash, label: `key …${token.slice(-4)}`, token }];
		}),
	);
	return found.flat();
}
