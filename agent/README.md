# Agent configuration

Contents of this directory map to pi's global config directory, `~/.pi/agent`.

## Tracked

| Path | Purpose |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Global instructions loaded into every pi session |
| [`settings.json`](settings.json) | Model, theme, package, trust, and UI defaults |
| [`extensions/`](extensions/README.md) | Auto-discovered TypeScript extensions |
| [`skills/`](skills) | On-demand Agent Skills |
| [`themes/`](themes) | Custom TUI themes |
| [`om.json`](om.json) | Observational-memory pipeline settings |
| [`web-search.json`](web-search.json) | SearXNG endpoint |

## Local-only state

Root allowlist ignores everything else by default, including:

- Provider credentials and OAuth state
- Sessions and transcripts
- MCP config and caches
- Downloaded packages and binaries
- Usage caches, crash reports, and logs

Keep those files untracked. Before committing new config, check both `git status --ignored` and staged diff for tokens, local paths, or personal data.

## Adapting this config

At minimum, review these fields in [`settings.json`](settings.json):

- `defaultProvider`, `defaultModel`, and `defaultThinkingLevel`
- `packages` and `extensions`
- `defaultProjectTrust` — this repo uses `always`, which allows project-local code to load without an interactive prompt

Use `/settings` for supported preferences and `/login` for credentials. Never add credentials to this repo.
