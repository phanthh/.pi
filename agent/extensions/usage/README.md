# usage

Subscription usage for Claude, Codex, and OpenCode Go. Ported from oh-my-pi's `packages/ai/src/usage`.

## Surfaces

- **Footer** (`setStatus("usage")`): active provider's windows, e.g. `5h 36% 4h15m · 7d 6% 6d1h`. Account-wide windows shortest-first; model-scoped weekly rows (`7d·opus`, Codex `spark`) only when the active model matches. Anthropic fallback accounts are prefixed with their label.
- **`/usage`**: one card per provider, one block per account, bars + reset countdowns + money/credit amounts. `r` forces a poll, `esc`/`q` closes. A provider without credentials gets a `no credentials` hint line instead of a card. Credentials are read from pi's process: an env key (e.g. `OPENCODE_API_KEY`) exported after pi started won't be visible until you restart pi. Non-TUI modes print the same layout via `notify`.

## Sources

| Provider | Credential | Poll | Headers |
|---|---|---|---|
| `anthropic` | pi `anthropic` OAuth (main) + enabled anthropic-auth OAuth fallbacks | `api.anthropic.com/api/oauth/usage` + `/profile` (once per account) | `anthropic-ratelimit-unified-{5h,7d}-*`, account from `x-pi-anthropic-auth-account` |
| `openai-codex` | pi OAuth; account id/email from JWT | `chatgpt.com/backend-api/wham/usage` | websocket `codex.rate_limits` stream event (default transport); `x-codex-{primary,secondary}-*` on SSE |
| `opencode-go` | pi auth / env API key | `opencode.ai/zen/go/v1/usage` | — |

Fallback accounts are polled only while their access token is unexpired — refreshing here would race anthropic-auth's rotating refresh tokens. Otherwise anthropic-auth's persisted quota snapshot is shown.

## Caching

`~/.pi/agent/cache/usage.json` is shared by every pi process (main + subagents): at most one poll per account per 5 min machine-wide. 429s back off (`retry-after`, default 5 min), other failures 2 min; the last good report stays visible with the error. Live merges (headers / stream events) update rows in place, never postpone the next poll, and persist at most every 15 s (immediately when a window is exhausted). Entries idle >1 day are pruned.

## Development

```bash
pnpm --filter @pi-ext/usage test   # node --test, no network
pnpm check
```
