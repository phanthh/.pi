# cursor-auth

Pi extension providing Cursor OAuth and model access. Provider ID remains `cursor`; use `/login cursor`.

**Capabilities:**

- **Image support** — base64 `image_url` content parts forwarded to Cursor end-to-end
- **Compaction support:** old turns archived as inline text to reduce blob retrieval work; bridge termination errors surface as failures instead of silent empty responses; server checkpoints preserved across Pi compaction
- **Reliability** — transparent retry for transient Cursor protocol errors (internal / unavailable / deadline_exceeded); HTTP/2 PING keepalive detects dead connections; stall timer kills stuck bridges; bridge timeouts hardened and configurable; SSE keepalive prevents pi from timing out during blob-fetching; conversation state and checkpoints survive transient failures and client disconnects
- **Model support** — per-model context window inference (vs. hardcoded 200 k); runtime cap scaling when Cursor enforces a tighter window; detailed cost table for all current families; effort-suffix variants deduplicated so pi's reasoning-level setting drives the suffix automatically
- **Thinking-tag filtering** — inline `<think>` / `<reasoning>` tags stripped from the response and routed to `reasoning_content`
- **Fixes & observability** — `pi -p` exit hang fixed; dead TTL eviction code removed; opt-in JSONL debug logging with a bundled timeline viewer

[Pi](https://github.com/earendil-works/pi) extension that provides access to [Cursor](https://cursor.com) models (Claude, GPT, Gemini, Grok, Kimi, Composer) via OAuth and a local OpenAI-compatible proxy.

## Install

This extension is part of the local `~/.pi/agent/extensions` pnpm workspace and auto-loads globally.

```bash
cd ~/.pi/agent/extensions
pnpm install
```

## Release 0.7

Requires Pi 0.84 or newer under the `@earendil-works` package namespace and Node.js 22.19 or newer. The package is source distributed; no build step is needed.

The bundled catalog is refreshed from Cursor discovery. It is a startup fallback, not a guarantee of access: your account's live catalog takes precedence. Model names preserve Cursor's privacy labels. In particular, **Fable is marked `NO ZDR`**. Do not treat the bridge's ghost mode header as a zero data retention guarantee, and do not send sensitive material to a model without confirming your organization's policy.

Pricing is an estimate, not a Cursor invoice. Missing prices retain family or generic estimates. Account surcharges and premiums for longer contexts are not included. The proxy also scales usage for compaction, so its token counts are not a reliable billing record.

Discovery does not supply output limits. The registered 64,000 token output budget is an adapter default; the proxy does not forward `max_tokens` as an enforced Cursor generation limit. Context windows are estimates and may differ from the runtime cap. GPT 5.6 uses Cursor's documented default of 272 k, not its separately advertised 1M maximum.

In release testing, Cursor streamed responses from Grok 4.6, GPT 5.6 Sol, and Claude Opus 5. Grok also completed a tool call and result replay. Fable requests were blocked by Cursor's administrative model access controls. The adapter now displays Cursor's own error title, detail, and additional display information rather than replacing them with local explanations or a generic finish reason. Astra was absent from the account catalog and has no verified Cursor ID in this release. Catalog visibility does not establish working access.

## Usage

```
/login cursor     # authenticate via browser
/model            # select a Cursor model
```

## How it works

```
pi  →  openai-completions  →  localhost:PORT/v1/chat/completions
                                      ↓
                              proxy.ts (HTTP server)
                                      ↓
                              h2-bridge.mjs (Node HTTP/2)
                                      ↓
                              api2.cursor.sh gRPC
```

1. **PKCE OAuth** — browser-based login to Cursor, no client secret needed
2. **Model discovery** — queries Cursor's `GetUsableModels` gRPC endpoint
3. **Local proxy** — translates OpenAI `/v1/chat/completions` to Cursor's protobuf/HTTP2 Connect protocol
4. **Instruction and tool routing** — loads Pi's `AGENTS.md` as the first Cursor user message, exposes Pi's tools via MCP, prohibits selecting Cursor's advertised native tools, and rejects any native call that still occurs

## Security

The proxy binds only to `127.0.0.1` and uses an ephemeral random bearer token. Pi supplies that token automatically; the Cursor OAuth credential never becomes the local bearer token. Browser Origin headers and unexpected Host headers are rejected. Chat requests require JSON, have a finite body size, and are validated before upstream credentials are resolved.

This is not a sandbox against code already running as your user. Extensions have full process access. Debug logging is explicitly opt in and can contain prompts, responses, and tool arguments. Keep logs private and inspect them before sharing. New log files are created with owner only permissions, symlink targets are rejected, and log write failures do not print payloads to stderr.

## Configuration

| Env var | Default | Description |
| ------- | ------- | ----------- |
| `PI_CURSOR_PROVIDER_DEBUG` | off | Set to any truthy value to enable JSONL debug logging |
| `PI_CURSOR_PROVIDER_DEBUG_FILE` | auto in tmpdir | Override the debug log file path |
| `PI_CURSOR_BRIDGE_INITIAL_TIMEOUT_MS` | `120000` | Kill bridge if no HTTP/2 activity within this many ms of spawn |
| `PI_CURSOR_BRIDGE_ACTIVITY_TIMEOUT_MS` | `300000` | Kill bridge if no HTTP/2 activity for this many ms after the first frame |
| `PI_CURSOR_BRIDGE_PING_INTERVAL_MS` | `15000` | HTTP/2 PING interval to detect dead connections |
| `PI_CURSOR_BRIDGE_PING_TIMEOUT_MS` | `10000` | Timeout for each HTTP/2 PING before declaring the connection dead |
| `PI_CURSOR_BRIDGE_STALL_TIMEOUT_MS` | `120000` | Kill bridge if no data received from Cursor within this many ms |
| `PI_CURSOR_MAX_BRIDGE_RETRIES` | `2` | Max transparent retries on transient Cursor errors or bridge crashes |
| `PI_CURSOR_TURN_ARCHIVE_THRESHOLD` | `20` | Keep this many recent turns as raw blobs; older turns are archived as inline text |
| `PI_CURSOR_RAW_MODELS` | off | Set to disable model deduplication and see all raw Cursor model IDs |

## Features

### Image support

The proxy handles images in OpenAI-style `image_url` content parts:

- **Base64 images** — `data:image/png;base64,...` payloads are extracted from the request, stored as blobs in Cursor's protobuf format, and forwarded to Cursor.
- **Multi-turn state** — images are tracked per conversation turn and threaded correctly through session checkpoints, forks, and resumes.
- **Transparent to callers** — no API changes; just include standard `image_url` content parts in your messages as you would with any OpenAI-compatible client.

### `pi -p` exit fix

Two conditions can make `pi -p` hang after printing a response:

1. **Empty end-stream body misclassified as error.** Cursor's Connect end-stream frame often has a 0-byte body. `JSON.parse("")` throws, so the proxy took the error path even on clean completions.
2. **Bridge never unref'd on error path.** `bridge.end()` and `bridge.unref()` were only called in the success branch. On the error path the h2-bridge child process stayed ref'd, blocking process exit.

Empty and non-JSON end-stream bodies are treated as success, and the bridge is always unref'd regardless of the outcome.

### Removed dead eviction code

Conversation state has no dead TTL eviction path. All conversations created by pi include a session ID and use lifecycle cleanup.

### Conservative context window estimates

Cursor's `GetUsableModels` RPC does not return context or output limits. `inferContextWindow(id)` uses family estimates, not measured capacity. Claude remains registered at 200 k unless the ID explicitly indicates a larger window, because Cursor historically enforced a tighter cap than the native model specification. A `1M` display name alone does not establish the enforced capacity.

| Family | Window |
| ------ | ------ |
| Claude without an explicit larger window in the ID | 200 k |
| Gemini 2.5 / 3.x | 1 M |
| GPT nano / mini variants | 128 k |
| GPT 5.5 | 1 M |
| GPT 5.6 Sol / Terra / Luna | 272 k |
| GPT-5.x (other) | 400 k |
| Grok 4 | 256 k |
| Kimi K2.x | 262 k |
| Anything with `-1m` suffix | 1 M |
| Unknown / Composer | 200 k |

These estimates inform compaction thresholds. The runtime scaling below handles tighter caps when Cursor reports them. They are not a guarantee that every listed model supports the inferred maximum.

### Checkpoints across compaction

Pi compaction shortens the local message list, but Cursor's server checkpoint still carries conversation state and blob references. The `session_compact` hook deliberately preserves that checkpoint. Clearing it can lose server context because a synthetic reconstruction is not always equivalent. Session switches, forks, tree changes, and shutdown still clean up their state.

### Context window scaling when Cursor enforces a tighter cap

Cursor sometimes enforces a tighter context window at runtime than what the model ID implies (for example, capping Gemini at 200 k even though we registered 1 M). In that case the raw `usedTokens` from Cursor's `ConversationTokenDetails` would appear far below pi's compaction threshold, so pi would never compact — then Cursor would eventually error with a context-overflow.

The proxy reads `maxTokens` from `ConversationTokenDetails` and, when Cursor's cap is tighter than the inferred window, scales `total_tokens` proportionally:

```
total_tokens = round(usedTokens × piWindow / cursorWindow)
```

That makes pi's compaction threshold fire at the right time relative to the window Cursor is actually enforcing.

### Per-model cost estimation

The extension ships a detailed cost table (input / output / cache-read / cache-write prices in $/M tokens) covering every current model family — Claude 4.x, GPT-5.x, Gemini 2.5/3.x, Grok 4, Kimi K2, and Composer — plus a pattern-based fallback for variants not yet in the table. Pi uses this data to display cost estimates after each turn.

### Model deduplication with reasoning-effort mapping

Cursor's `GetUsableModels` RPC can return dozens of near-duplicate IDs that differ only by effort suffix (e.g. `gpt-5.4-low`, `gpt-5.4-medium`, `gpt-5.4-high`, `gpt-5.4-xhigh`). The extension deduplicates them: model variants that share the same base ID and differ only by effort suffix are collapsed into a single entry with `supportsReasoningEffort: true` and an effort map keyed by pi's reasoning levels (`minimal` / `low` / `medium` / `high` / `xhigh`). Pi's thinking-level setting then drives the effort suffix automatically, and the model list stays manageable. See the [Model Mapping](#model-mapping) section for the full deduplication rules.

### Thinking-tag filtering

Some models (notably certain Gemini variants) emit reasoning content inline with the response, wrapped in tags like `<think>`, `<thinking>`, `<reasoning>`, or `<thought>`. The proxy detects and strips these tags in the proxy's stream processor, routing the extracted content to the `reasoning_content` SSE field so pi renders it as structured reasoning rather than as part of the assistant's reply.

### Error display

Cursor supplies user facing text in protobuf `aiserver.v1.ErrorDetails`. The adapter decodes the same `CustomErrorDetails` title, detail, and additional information that Cursor's CLI displays. It ignores diagnostic `debug` fields and analytics. If structured display text is unavailable, it preserves Cursor's raw Connect message. There are no model specific messages or code to explanation translations.

Streaming errors use an OpenAI compatible SSE error object so Pi receives the actual message, not `Provider finish_reason: error`. Explicit upstream retryability is preserved. Native rate limit messages are no longer relabeled as context overflow.

### Structured debug logging

The extension provides opt-in JSONL event logging (set `PI_CURSOR_PROVIDER_DEBUG=1`) covering every stage of a request: HTTP ingress, message parsing, checkpoint reads/writes, bridge lifecycle, tool call pauses, tool result resumes, and stream completion. A bundled `debug:timeline` script converts a raw log file into a compact human-readable timeline for diagnosing proxy behaviour.

```bash
pnpm debug:timeline -- --latest
```

### Transparent retry for transient errors

When Cursor returns a retryable Connect-level error (`internal`, `unavailable`, `deadline_exceeded`) or the bridge process crashes mid-request, the proxy now automatically retries on a fresh HTTP/2 bridge — up to `PI_CURSOR_MAX_BRIDGE_RETRIES` times (default 2). The SSE response to pi stays open; the client sees at most a brief pause.

Retry is only attempted when no content has been streamed yet (so partial responses are never replayed). On retry the proxy rebuilds the Cursor request using the pre-turn checkpoint and replays cleanly.

Previously these transient errors were surfaced as `finish_reason: "error"`, requiring the user to manually continue each time.

### HTTP/2 PING keepalive and stall detection

The bridge now configures HTTP/2-level PINGs (`PI_CURSOR_BRIDGE_PING_INTERVAL_MS` / `PI_CURSOR_BRIDGE_PING_TIMEOUT_MS`) so dead TCP connections (NAT timeout, load-balancer cycling) are detected within seconds rather than waiting for the 5-minute activity timeout.

Additionally, a stall timer (`PI_CURSOR_BRIDGE_STALL_TIMEOUT_MS`, default 120 s) kills the bridge if no data arrives from Cursor — catching cases where the HTTP/2 connection is technically alive but the server is stuck processing a stale checkpoint.

### Usage reporting on tool-call continuations

When the proxy pauses mid-turn for a tool call and responds with pending tool calls (the partial-wait path), it now reports meaningful `usage` token counts instead of zeros. The stored `lastTotalTokens` from the previous stream segment is scaled proportionally if Cursor is enforcing a tighter context window than the model's nominal size. This lets pi track cumulative token usage accurately across multi-step tool-call turns.

### Bridge timeout hardening

Large conversations require Cursor to deserialise a big checkpoint and complete many `getBlobArgs` round-trips before it starts streaming tokens. The bridge uses 120-second initial and 300-second activity defaults and makes them configurable via `PI_CURSOR_BRIDGE_INITIAL_TIMEOUT_MS` and `PI_CURSOR_BRIDGE_ACTIVITY_TIMEOUT_MS` (see [Configuration](#configuration)).

### Bridge termination error propagation

The proxy checks the bridge exit code before any response in both paths:
- **Streaming path** — if the bridge exits with code ≠ 0 before any response, an SSE error chunk is sent so pi surfaces a real failure.
- **Non-streaming path** — same condition returns a 502 JSON error.
- **Both paths** — the conversation state is preserved so the next retry can resume from the last good checkpoint rather than rebuilding from scratch.

### Conversation history archiving

Cursor's `AgentService/Run` RPC is stateless per request: each turn sends the full conversation state as a checkpoint blob, and the server fetches individual turn blobs via `getBlobArgs` as needed. For a long conversation every request incurs O(history) round-trips; the compaction turn is the worst case because Cursor must read the entire history to generate a summary.

The proxy folds turns older than a configurable tail into a single `ConversationSummaryArchive` protobuf blob that stores the transcript as **inline text**. The server reads one blob instead of hundreds, cutting round-trips from O(N) to O(tail):

| Scenario | `getBlobArgs` before | `getBlobArgs` after |
| ---------------------- | --------------------- | ------------------- |
| 100-turn compaction | ~300 | ~61 |
| 20-turn normal turn | ~60 | ~60 (unchanged) |

The tail size is configurable via `PI_CURSOR_TURN_ARCHIVE_THRESHOLD` (default 20, see [Configuration](#configuration)).

Archiving is conservative: old turns are only replaced if every required blob is already in the local store. If any blob is missing the turns are left as-is, so no context is silently dropped.

### SSE keepalive during blob-fetching

Before the first token arrives, the proxy is silent: it sends HTTP 200 headers immediately but emits no SSE events while Cursor fetches conversation blobs. If pi's HTTP client has a request timeout (or a "time since last data" idle timeout), it fires during this window and the request is aborted with `Error: Request timed out.`

The proxy starts a 15-second keepalive timer alongside the SSE stream. While the response is open and no data has been sent yet, the timer periodically writes an SSE comment (`: ping`) which is invisible to pi's message parser but resets any inactivity timer in the HTTP layer.

### Conversation state preserved on transient errors

Previously, a bridge timeout (`exit code ≠ 0`) or a Connect-level error from Cursor caused the proxy to call `conversationStates.delete(convKey)`, wiping the stored checkpoint. On the next request pi would rebuild the Cursor conversation from scratch — losing any context accumulated since the last compaction.

Neither failure mode actually invalidates the checkpoint. A bridge timeout means Cursor stopped responding to the current request, not that its conversation state is corrupt. A Connect error (e.g. rate limit, transient upstream failure) also leaves the prior checkpoint intact.

The last good checkpoint survives errors, so the next request resumes from where the conversation was rather than starting over.

### Checkpoint saved on client disconnect

When pi closes the SSE connection (e.g. its own request timeout fires), the proxy previously guarded checkpoint persistence behind `if (!cancelled)`, discarding any checkpoint that Cursor had already sent for that turn. On the next request the proxy used a stale checkpoint, losing the partial turn's context.

If Cursor sent a checkpoint before the disconnect, it is saved and the retry picks it up.

## Model Mapping

Cursor exposes variants for reasoning effort, thinking, and speed. The extension groups related variants under a canonical picker ID while preserving the exact advertised RPC IDs in a lookup table. Effort suffixes include `minimal`, `none`, `low`, `medium`, `high`, `xhigh`, `extra-high`, and `max`.

### How it works

Each raw Cursor model ID is parsed into components:

```
{base}-{effort}[-thinking][-fast]
{base}[-thinking]-{effort}[-fast]
```

Examples:

| Raw Cursor ID                  | Base                | Effort   | Variant     |
| ------------------------------ | ------------------- | -------- | ----------- |
| `gpt-5.4-medium`               | `gpt-5.4`           | `medium` | —           |
| `gpt-5.4-high-fast`            | `gpt-5.4`           | `high`   | `-fast`     |
| `claude-4.6-opus-max-thinking` | `claude-4.6-opus`   | `max`    | `-thinking` |
| `gpt-5.1-codex-max-high`       | `gpt-5.1-codex-max` | `high`   | —           |
| `composer-2`                   | `composer-2`        | —        | —           |

Models sharing the same base, thinking mode, and speed are grouped even if only one mandatory effort tier exists. Pi's `thinkingLevelMap` selects an advertised tier; the proxy looks up its exact raw ID rather than assuming a suffix order.

| Pi Level  | Cursor Suffix                   |
| --------- | ------------------------------- |
| `off` | `none`, then the bare default; hidden if neither exists |
| `minimal` | `minimal`, then `none` or `low` |
| `low` | `low` or the nearest available fallback |
| `medium` | `medium` or the bare default |
| `high` | `high` or an available fallback |
| `xhigh` | `xhigh`, then `extra-high`, `max`, or `high` |
| `max` | `max`; hidden unless that tier is advertised |

Exact lookup preserves both historical and current suffix orders. Already raw IDs are left intact when no new effort is requested. For example, Fable's thinking variant uses `claude-fable-5-1-thinking-high`, while older Opus uses `claude-4.6-opus-high-thinking`.

```
pi selects: gpt-5.4-fast  +  effort: high    →  Cursor receives: gpt-5.4-high-fast
pi selects: gpt-5.4       +  effort: medium  →  Cursor receives: gpt-5.4-medium
pi selects: composer-2    +  (no effort)     →  Cursor receives: composer-2
```

**Collapsed** when Cursor returns either:

- **Multiple** effort suffixes for the same `(base, -fast, -thinking)` group, or
- **A single** variant whose parsed effort suffix is **non-empty** (for example only `claude-4.5-opus-high` is listed). The suffix is removed from the displayed ID so pi's reasoning-effort setting supplies it.

**Left as-is** when the group has **one** variant and the parsed effort suffix is **empty** — typically IDs with no effort segment, such as `composer-2`, `gemini-3.1-pro`, or `kimi-k2.5`.

### Disabling the mapping

To see all raw Cursor model variants without dedup:

```bash
PI_CURSOR_RAW_MODELS=1 pi
```

## Session Management

The proxy maintains per-session conversation state to enable multi-turn conversations with tool call continuations and clean lifecycle handling.

### State storage

- **Keyed by session ID** — pi injects its session ID into every request via a `before_provider_request` hook; the proxy uses it to key both bridge state and the stored conversation checkpoint.
- **Conversation history** — Pi's parsed messages are authoritative for normal follow-up requests. The proxy includes that transcript in the next Cursor user action because Cursor accepts reconstructed turn blobs and checkpoints without reliably exposing their text to the model.
- **Checkpoint** — Cursor sends `conversationCheckpointUpdate` messages during each turn. The proxy stores the latest checkpoint for interrupted-turn resumes and transparent retries, where it preserves Cursor's partial internal state.
- **Blob store** — protobuf blobs referenced by the checkpoint are cached locally and served back to Cursor on demand via `getBlobArgs` / `setBlobArgs`.
- **In-memory only** — all state lives in process memory. A proxy restart loses checkpoints; the next request rebuilds from pi's message history.

### Tool continuations

When Cursor requests a tool call, the proxy pauses the SSE stream, stores the live bridge in memory, and returns the tool call to pi. When pi sends the result on the next request, the proxy forwards it into the same in-flight Cursor run so the continuation stays part of the original turn.

### Lifecycle cleanup

Session state is cleared on Pi lifecycle events for session switch, fork, `/tree`, and shutdown. Compaction deliberately preserves the Cursor checkpoint.

### Error resilience

Transient Cursor errors (`internal`, `unavailable`, `deadline_exceeded`) and bridge crashes are retried automatically — up to `PI_CURSOR_MAX_BRIDGE_RETRIES` times — without dropping the SSE connection to pi. The last good checkpoint survives all error types and is used on retry. If Cursor sends a checkpoint before a client disconnect, that checkpoint is also preserved.

## Requirements

* [Pi](https://github.com/earendil-works/pi-mono) >= 0.84
* [Node.js](https://nodejs.org) >= 22.19
- Active [Cursor](https://cursor.com) subscription

## Development

```bash
pnpm install
pnpm check
HOME="$(mktemp -d)" pnpm smoke
```

Live tests send only synthetic prompts and require explicit opt in plus existing Cursor authentication:

```bash
pnpm test:live -- --live cursor-grok-4.6 gpt-5.6-sol
pnpm test:live -- --live --tool cursor-grok-4.6
```

Package is private and must not be published.

## Debug log timeline

When `PI_CURSOR_PROVIDER_DEBUG=1` is enabled, the proxy writes timestamped JSONL logs to `os.tmpdir()` by default. You can turn a log into a compact human-readable timeline with:

```bash
pnpm debug:timeline -- --latest
pnpm debug:timeline -- /path/to/pi-cursor-auth-debug-2026-04-08T14-06-07-565Z-41184.log
```

Add `--json` if you want the parsed summary as JSON instead of formatted text.
