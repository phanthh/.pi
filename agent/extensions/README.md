# Pi extensions

Personal TypeScript extension workspace for [pi](https://pi.dev). Extensions run directly from source and are auto-discovered from `~/.pi/agent/extensions`.

> Extensions execute with full user permissions. Read code and dependencies before installing this setup.

## Extensions

| Directory | Surface | Purpose |
|---|---|---|
| `ask` | `ask` tool | Structured text, single-choice, and multi-choice questions |
| [`anthropic-auth`](anthropic-auth/README.md) | Provider | Anthropic Pro/Max OAuth, Claude models, quota-aware routing, and cache controls |
| [`bash-guard`](bash-guard/README.md) | Bash hook | Blocks catastrophic commands and optionally prompts for risky ones |
| `codemode` | `code_exec` tool | Runs type-checked TypeScript orchestration in a QuickJS sandbox |
| [`context`](context/README.md) | Commands and tools | Context views, compaction, recall, memory, and topic cutovers |
| `cursor-auth` | Provider | Cursor OAuth and model access |
| `goal` | `goal` tool | Keeps long-running objectives active until completion or drop |
| `idle-timer` | Footer status | `💤 3m12s` since agent settled or a blocking prompt opened |
| `lsp` | `lsp` tool | Language-server navigation, diagnostics, and refactors |
| [`project-skill-rules`](project-skill-rules/README.md) | Prompt hook | Filters project skills by working directory |
| [`reload`](reload/README.md) | `reload_pi` tool | Reloads extensions and resources, then resumes work |
| `tmux` | `tmux` tool | Manages named panes for long-running processes |
| `tmux-layout` | Library | Shared pane layout helpers |
| [`tmux-subagents`](tmux-subagents/README.md) | `tmux_subagent` tool | Runs asynchronous pi subagents in visible tmux panes |
| [`ttsr`](ttsr/README.md) | Stream hook | Interrupts and retries responses that violate markdown rules |
| `web-fetch` | `web_fetch` tool | Fetches and extracts readable web content |
| `web-search` | `web_search` tool | Searches a configurable SearXNG instance |

## Development

```bash
pnpm install --frozen-lockfile
pnpm check
```

Workspace uses strict TypeScript with source entry points—no normal build step. Run package-specific checks when changing packages that define them:

```bash
pnpm --filter pi-codemode selftest
pnpm --filter pi-context selftest
pnpm --filter @pi-ext/project-skill-rules test
pnpm --filter @pi-ext/cursor-auth check
```

Contributor conventions and architecture notes live in [`AGENTS.md`](AGENTS.md).
