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
- `pnpm check` (= `tsc --noEmit`) is the typecheck gate. Run it after every edit.
- `/reload` in a live session hot-reloads these (auto-discovered location).
- New extension = new dir + `package.json` with `pi.extensions` + `src/index.ts`; then `pnpm install`.
- Shared code goes in a plain library package (see `@pi-ext/tmux-layout`), consumed via
  `"@pi-ext/x": "workspace:*"`.

## Extensions

| Dir | Surface | Notes |
|---|---|---|
| `ask` | `ask` tool | interactive question UI (text / single / multi select), built on pi-tui |
| `anthropic-auth` | provider | Anthropic Pro/Max OAuth, Claude model catalog, request conversion, quota-aware routing, cache controls; internal auth/account/quota/cache/relay/routing code lives in `src/core` |
| `context` | `/context`, `/compact`, `/recall`; `recall` tool | monolithic context management: usage/injection views, deterministic compaction/searchable history, Observer → Reflector → Dropper memory (`~/.pi/agent/om.json`), idle-aware compaction, optional agent-editable live context (`/context live on`, disabled by default). Has its own `README.md`. `pnpm --filter pi-context selftest` |
| `goal` | `/goal` + `goal` tool | pins objective in system prompt, nudges until complete/drop, token budget |
| `idle-timer` | footer status | `💤 <dur>` while waiting on user (agent settled, or blocking UI prompt mid-run); resumed sessions count from last branch entry. `pnpm --filter @pi-ext/idle-timer test` |
| `lsp` | `lsp` tool | LSP client, per-project-root servers (typescript, pyright, gopls, rust-analyzer) |
| `tmux` | `tmux` tool + `tool_call` guard | named panes for long-running processes; `src/guard.ts` blocks `bash`/`tmux`-tool commands that create/kill/move tmux windows or sessions (user-managed; `-L`/`-S` isolated servers allowed). Guard: `pnpm --filter pi-tmux test`; layout: `pnpm --filter @pi-ext/tmux-layout test` |
| `tmux-layout` | library | pane creation/close/balance, shared by `tmux` + `tmux-subagents`; one full-height column per spawn depth (`@pi_depth` tags). `pnpm --filter @pi-ext/tmux-layout test` (live, isolated tmux server) |
| `tmux-subagents` | `tmux_subagent` tool | async child pi sessions in panes + live widget; agent defs in `agents/*.md` (model fixed per def, no caller override). `pnpm --filter pi-tmux-subagents test` |
| `ttsr` | stream watcher | Time-Traveling Stream Rules: aborts mid-stream on rule violation, injects rule, retries. Rules = md+frontmatter in `rules/`, shadowed by `~/.pi/agent/ttsr` then `.pi/ttsr` |
| `up-history` | native editor Up/Down history | seeds latest 30 unique saved user prompts for current cwd; preserves custom editor, honors custom session dirs, TUI-only. No settings/commands/history files. `pnpm --filter @pi-ext/up-history test` |
| `usage` | footer status + `/usage` | Claude (main + anthropic-auth fallbacks), Codex, OpenCode Go subscription windows; polls TTL-gated via shared `~/.pi/agent/cache/usage.json`, live updates from `after_provider_response` headers + Codex `codex.rate_limits` stream events. Has `README.md`. `pnpm --filter @pi-ext/usage test` |
| `web-fetch` | `web_fetch` tool | wreq-js TLS impersonation + defuddle extraction |
| `web-search` | `web_search` tool | SearXNG; base URL from `~/.pi/agent/web-search.json` → `SEARXNG_URL` → localhost:8888 |

## Conventions

- Tool schemas via `typebox` `Type.*`; renderers via `@earendil-works/pi-tui` (`Text`, etc.).
- Per-extension runtime config lives in `~/.pi/agent/<name>.json` (read with `getAgentDir()`), not here.
- Env signals available: `PI_SUBAGENT_DEPTH`, `PI_SUBAGENT_ID` (set by tmux-subagents) — used to change
  behaviour between main session and children.
- Nontrivial extensions carry their own `README.md` (`tmux-subagents`, `ttsr`, `usage`) — read it
  before touching them; keep it in sync with behaviour changes.
- pi runs from source (`~/dev/pi`, `~/.local/bin/pi` → `packages/coding-agent/dist/cli.js`); pi packages are `link:`ed to
  it, so types track the local build. Rebuild pi (`npm run build` in `~/dev/pi`) before `pnpm check` after pulling.
- pi API docs: `~/dev/pi/packages/coding-agent/docs/` (`extensions.md`, `tui.md`) and `examples/`.
