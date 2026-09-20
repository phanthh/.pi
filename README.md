# .pi

[![Check](https://github.com/phanthh/.pi/actions/workflows/check.yml/badge.svg)](https://github.com/phanthh/.pi/actions/workflows/check.yml)

Personal [pi](https://pi.dev) setup: TypeScript extensions, agent instructions, skills, and a Tokyo Night theme.

This is a working dotfiles repo, not a stable distribution. Review every extension before using it: pi extensions run with your full user permissions.

## Highlights

- Context inspection, deterministic compaction, recall, and observational memory
- LSP, web search/fetch, structured questions, and typed code execution
- tmux-backed processes and asynchronous subagents
- Bash guardrails, goal tracking, hot reload, and stream-time rules
- Stacked-PR and decision-grilling skills

See [agent/extensions](agent/extensions/README.md) for the full extension list and [agent](agent/README.md) for config details.

## Install

Requirements: [pi](https://pi.dev), Node.js 22.19+, [pnpm](https://pnpm.io), Git, and tmux. Optional features also use `gh`, `ast-grep`, language servers, and a local [SearXNG](https://docs.searxng.org) instance.

Back up any existing `~/.pi` directory, then:

```bash
git clone https://github.com/phanthh/.pi.git ~/.pi
cd ~/.pi/agent/extensions
pnpm install --frozen-lockfile
pnpm check
```

Review `agent/settings.json`, especially provider, model, package, and project-trust choices. Start pi and authenticate interactively:

```text
pi
/login
```

Web search defaults to SearXNG at `http://localhost:8888`; change `agent/web-search.json` if needed.

## Layout

```text
agent/
├── AGENTS.md       Global agent instructions
├── extensions/     TypeScript extension workspace
├── skills/         Reusable agent skills
├── themes/         Custom TUI themes
├── settings.json   Global pi settings
├── om.json         Observational-memory settings
└── web-search.json Web-search endpoint
```

Credentials, sessions, caches, logs, installed packages, and machine-local state are intentionally ignored.

## Development

```bash
cd agent/extensions
pnpm install --frozen-lockfile
pnpm check
```

Individual packages may expose additional tests or self-checks. See their `package.json` and README files.

## License

MIT.
