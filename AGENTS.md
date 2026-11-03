# `~/.pi` repo (`phanthh/.pi`)

Live pi config for this machine, tracked as a dotfiles repo. Edits take effect in every pi session
(after `/reload` or restart). A broken change here breaks all sessions.

## Layout

```
~/.pi/
├── .gitignore          whitelist: ignore all, allow listed paths; new tracked path → add `!` entry
├── AGENTS.md           this file (repo work only)
├── README.md
└── agent/
    ├── AGENTS.md       global agent instructions (loaded in every project)
    ├── extensions/     pnpm TS workspace; own AGENTS.md with layout + conventions
    ├── skills/         <name>/SKILL.md
    ├── themes/
    └── settings.json, om.json, web-search.json
```

Everything else under `agent/` (auth, sessions, caches, logs, rooms, `complains.md`) is machine-local
state: never commit, never print secrets from `*auth*.json`.

## Rules

- Typecheck before every `git push`: `cd agent/extensions && pnpm check` MUST pass. No CI exists;
  this is the only gate. If it fails on missing `@earendil-works/pi-*` types, rebuild pi first
  (`npm run build` in `~/dev/pi`).
- Run the package tests for any extension you touch (see `agent/extensions/AGENTS.md`).
- Changed behaviour → update matching README (`README.md`, `agent/README.md`, extension READMEs).
- Commits: conventional style (`feat(<ext>): ...`, `fix(...)`, `docs: ...`, `chore: ...`). Commit only
  your own changes; leave unrelated dirty files alone.
- Push straight to `main` (personal repo, no PRs).
