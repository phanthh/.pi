# pi extensions monorepo (`~/.pi/agent/extensions`)

Personal, global pi extensions. Part of the `phanthh/.pi` dotfiles repo. Everything here loads into
**every** pi session on this machine — a broken extension breaks all sessions.

## Layout

```
extensions/
├── package.json        pnpm workspace root (private, ESM). devDeps: @earendil-works/pi-{ai,coding-agent,tui} (link: ~/dev/pi/packages/*), typebox, typescript
├── pnpm-workspace.yaml packages: ["*"]  → each subdir is a workspace package
├── tsconfig.json       strict, noEmit, ESNext + bundler resolution, allowImportingTsExtensions, include: */src/**/*.ts
└── <ext>/package.json  { "pi": { "extensions": ["./src/index.ts"] } }  ← how pi picks it up
```

- TS runs **unbundled, from source** (`src/index.ts`); no build step. Imports of local files use
  explicit `.ts` extensions.
- `pnpm check` (= `tsc --noEmit`) is the only gate. Run it after every edit.
- No tests. Do not add test files, test scripts, test frameworks, or test-only deps.
- `/reload` in a live session hot-reloads these (auto-discovered location).
- New extension = new dir + `package.json` with `pi.extensions` + `src/index.ts`; then `pnpm install`.
- Shared code goes in a plain library package (see `@pi-ext/tmux-windows`), consumed via
  `"@pi-ext/x": "workspace:*"`.

## Extensions

| Dir | Surface | Notes |
|---|---|---|
| `ask` | `ask` tool | interactive question UI (text / single / multi select), built on pi-tui |
| `anthropic-auth` | provider | Anthropic Pro/Max OAuth, Claude model catalog, request conversion, quota-aware routing, cache controls; internal auth/account/quota/cache/relay/routing code lives in `src/core` |
| `context` | `/context`, `/compact`, `/recall`; `recall` tool | monolithic context management: usage/injection views, deterministic compaction/searchable history, Observer → Reflector → Dropper memory (`~/.pi/agent/om.json`), idle-aware compaction, optional agent-editable live context (`/context live on`, disabled by default). Has its own `README.md` |
| `goal` | `/goal` + `goal` tool | pins objective in system prompt, nudges until complete/drop, token budget |
| `idle-timer` | footer status | `💤 <dur>` while waiting on user (agent settled, or blocking UI prompt mid-run); resumed sessions count from last branch entry |
| `lsp` | `lsp` tool | explicit `root` required; outside-root files use that server/config/venv. Async pruned recursive disk watching (5k watchers/client, ~200ms batches), dynamic globs, open-doc resync + diagnostics invalidation; watcher failure → one-time warning. Pyright `.venv`/`venv`/computed Poetry interpreter changes → transparent restart, failed-start cache cleared; no venv → warning. Missing report ≠ clean. Has `README.md` |
| `tmux` | `tmux` tool + `tool_call` guard | named detached windows in pi's own tmux session, scoped to their owner (`@pi_owner` = pi's `TMUX_PANE`, `@pi_name`); window runs `command.sh` as its own shell-command (no send-keys); run state lives on `globalThis` so results survive `/reload`; 2s sweep delivers runs whose wait-for was lost or whose window was closed externally, adopts child handovers from `@pi_run` metadata; capture/write failures still close finished windows and steer one completion (bounded placeholder snapshot attempt); `subagent_done({ keepWindows: true })` moves live runs to parent session/owner (collision names suffixed), transfers widget/control/completion delivery; quit closes only still-owned run windows; `tmux-windows` widget above the editor lists running run windows (elapsed, name › command), same box as subagents; `src/guard.ts` blocks `bash`/`tmux`-tool commands that create/kill/move tmux windows or sessions (`-L`/`-S` isolated servers allowed) |
| `tmux-indicator` | tmux tab color | per-pane `@pi_indicator` state (running/waiting/error/idle) → window `window-status-style`; multi-pi window: waiting > error > running > idle, tie → lowest pane index; non-lead subagent children add `dim` (via `PI_SUBAGENT_LEAD`); current-style untouched; colors override `~/.pi/agent/tmux-indicator.json`; quit unsets, reload keeps. Has `README.md` |
| `tmux-windows` | library | create/close owner-tagged windows (own session) and sessions, list owned ones; `./widget` = shared bordered list box (`renderBox`, `formatElapsedMMSS`) + one shared above-editor slot (`setStackSection`, fixed `SECTION_ORDER`: tmux above subagents); shared by `tmux` + `tmux-subagents` |
| `tmux-subagents` | `tmux_subagent` + `room` tools | async child pi sessions + live widget; child = window in spawner's session, `lead: true` def = own new tmux session; live children survive `/reload` (globalThis handoff); bundled agent defs in `agents/*.md` are the only policy source (no agent names in code). Every pi process hosts a file-backed room for its direct children (`~/.pi/agent/rooms/<session id>`): roster + inboxes. `room` tool (every process) is the only agent-to-agent channel: parent, siblings, own children; `caller_ping` = flagged room message; no `tmux_subagent` send action. Credential-only auth/refresh preflight; bounded stderr + last-work crash diagnostics; dead adopted jobs → `lost` + one resume-hint steer. Optional def `fallbackModel` resumes same session once on provider refusal (reviewer/delegate only). Room send reports idle delivery vs busy tool/duration; roster shows unread count/age, ack on consumption (never interrupts tools). Finished members in `status`, re-watch after host restart |
| `ttsr` | stream watcher | Time-Traveling Stream Rules: aborts mid-stream on rule violation, injects rule, retries. Rules = md+frontmatter in `rules/`, shadowed by `~/.pi/agent/ttsr` then `.pi/ttsr` |
| `up-history` | native editor Up/Down history | seeds latest 30 unique saved user prompts for current cwd; preserves custom editor, honors custom session dirs, TUI-only. No settings/commands/history files |
| `usage` | footer status + `/usage` | Claude (main + anthropic-auth fallbacks), Codex, OpenCode Go subscription windows; polls TTL-gated via shared `~/.pi/agent/cache/usage.json`, live updates from `after_provider_response` headers + Codex `codex.rate_limits` stream events. Has `README.md` |
| `web-fetch` | `web_fetch` tool | wreq-js TLS impersonation + defuddle extraction |
| `web-search` | `web_search` tool | SearXNG; base URL from `~/.pi/agent/web-search.json` → `SEARXNG_URL` → localhost:8888; cross-process request spacing (`minIntervalMs`, default 1500) via `$TMPDIR/pi-web-search.next` |

## Conventions

- Tool schemas via `typebox` `Type.*`; renderers via `@earendil-works/pi-tui` (`Text`, etc.).
- Per-extension runtime config lives in `~/.pi/agent/<name>.json` (read with `getAgentDir()`), not here.
- Env signal available: `PI_SUBAGENT_ID` (set by tmux-subagents for every child) — used to change
  behaviour between the manual (0-depth) session and children.
- Nontrivial extensions carry their own `README.md` (`tmux-subagents`, `ttsr`, `usage`) — read it
  before touching them; keep it in sync with behaviour changes.
- pi runs from source (`~/dev/pi`, `~/.local/bin/pi` → `packages/coding-agent/dist/cli.js`); pi packages are `link:`ed to
  it, so types track the local build. Rebuild pi (`npm run build` in `~/dev/pi`) before `pnpm check` after pulling.
- pi API docs: `~/dev/pi/packages/coding-agent/docs/` (`extensions.md`, `tui.md`) and `examples/`.
