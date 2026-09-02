# pi-ttsr

Port of oh-my-pi TTSR (Time Traveling Stream Rules) as a pi extension. Watches the
assistant stream (text, thinking, tool-call args) for rule violations, aborts
mid-stream, injects the violated rule, and retries the turn.

## Rules

Markdown files with YAML frontmatter:

- Builtin: `extensions/ttsr/rules/*.md` (27 defaults ported from oh-my-pi, lowest priority)
- Global: `~/.pi/agent/ttsr/*.md`
- Project: `.pi/ttsr/*.md`

Later shadows earlier on name duplicate: builtin < global < project. Disable a
builtin per-session with `/ttsr disable NAME`, or shadow it with your own file
of the same name.

Rule name = filename without `.md`. Body = injected instruction.

```markdown
---
condition: ["(?i)\\beval\\s*\\("]   # regex list; inline (?i)(?m)(?s) supported
astCondition: ["eval($A)"]          # ast-grep patterns (needs ast-grep on PATH)
scope: [text, "tool:edit(*.ts)", "tool:write(*.ts)"]
interruptMode: always               # always | never | prose-only | tool-only
globs: ["src/**/*.ts"]              # optional global path gate
---
Never use eval(). Use JSON.parse or explicit dispatch instead.
```

At least one of `condition` / `astCondition` required.

### scope tokens

- `text` — assistant prose
- `thinking` — reasoning stream
- `tool` — all tool-call args
- `tool:NAME` / `tool:NAME(glob,glob)` — specific tool, optional path filter

Default scope (omitted): text + all tools, no thinking.

## Behavior

- Regex rules match mid-stream on text/thinking deltas and tool-arg streams.
  `edit`/`write` match against reconstructed source snapshots (newText/content),
  not raw JSON wire.
- AST rules match mid-stream on edit/write snapshots via `ast-grep` shellout
  (language inferred from file extension, deduped, 3s timeout). Final gate at
  `tool_call` with complete args covers stream races.
- Interrupting match: abort → hidden `<system-interrupt>` injection → retry.
  Aborted partial output is discarded from LLM context (filtered when followed
  by the injection).
- Non-interrupting tool match: `<system-reminder>` prepended to tool result.
- Non-interrupting prose match: deferred injection after message completes.
- Repeat policy: once per rule per session, in-memory.

## /ttsr command

- `/ttsr` — list rules with status
- `/ttsr reload` — re-scan rule dirs
- `/ttsr enable NAME` / `/ttsr disable NAME` — session-scoped toggle
