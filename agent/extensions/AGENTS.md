# pi extensions monorepo (`~/.pi/agent/extensions`)

Personal, global pi extensions. Part of the `phanthh/.pi` dotfiles repo. Everything here loads into
**every** pi session on this machine — a broken extension breaks all sessions.

## Layout

```
extensions/
├── package.json        pnpm workspace root (private, ESM). devDeps: @earendil-works/pi-{ai,coding-agent,tui}, typebox, typescript
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
| `anthropic-auth` | provider | Anthropic Pro/Max OAuth, Claude model catalog, request conversion, quota-aware routing, cache controls |
| `anthropic-auth-core` | library | auth, account, quota, cache, relay, and routing logic shared by `anthropic-auth` |
| `bash-guard` | hook on `bash` | subagents: headless hard-block; main session: off by default + irreversible-op floor. `/bash-guard` toggles |
| `codemode` | `code_exec` tool | type-checked TS program run in QuickJS sandbox; calls pi tools from inside |
| `context` | `/context`, `/compact`, `/recall`; `recall` + `new_topic` tools | monolithic context management: usage/injection views, deterministic compaction/searchable history, Observer → Reflector → Dropper memory (`~/.pi/agent/om.json`), topic cutovers. Has its own `README.md` |
| `goal` | `/goal` + `goal` tool | pins objective in system prompt, nudges until complete/drop, token budget |
| `lsp` | `lsp` tool | LSP client, per-project-root servers (typescript, pyright, gopls, rust-analyzer) |
| `tmux` | `tmux` tool | named panes for long-running processes |
| `tmux-layout` | library | pane creation/close/balance, shared by `tmux` + `tmux-subagents` |
| `tmux-subagents` | `tmux_subagent` tool | async child pi sessions in panes + live widget; agent defs in `agents/*.md` |
| `ttsr` | stream watcher | Time-Traveling Stream Rules: aborts mid-stream on rule violation, injects rule, retries. Rules = md+frontmatter in `rules/`, shadowed by `~/.pi/agent/ttsr` then `.pi/ttsr` |
| `web-fetch` | `web_fetch` tool | wreq-js TLS impersonation + defuddle extraction |
| `web-search` | `web_search` tool | SearXNG; base URL from `~/.pi/agent/web-search.json` → `SEARXNG_URL` → localhost:8888 |

## Conventions

- Tool schemas via `typebox` `Type.*`; renderers via `@earendil-works/pi-tui` (`Text`, etc.).
- Per-extension runtime config lives in `~/.pi/agent/<name>.json` (read with `getAgentDir()`), not here.
- Env signals available: `PI_SUBAGENT_DEPTH`, `PI_SUBAGENT_ID` (set by tmux-subagents) — used to change
  behaviour between main session and children.
- Nontrivial extensions carry their own `README.md` (`bash-guard`, `tmux-subagents`, `ttsr`) — read it
  before touching them; keep it in sync with behaviour changes.
- pi API docs: [`extensions.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), [`tui.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md), and official examples.
