---
name: complain
description: How to report problems with tooling, the coding environment, system prompts, skills, or subagents to ~/.pi/agent/complains.md. MUST load before writing any complaint.
---

# Complain

Something wrong with tooling, environment, prompts, skills, or subagents → complain. Be vocal and demanding. Be constructive: include the better way when there clearly is one.

## Where

- `~/.pi/agent/complains.md`. Every agent (subagents included) may append, even outside `pwd`.
- Append only: bash `cat >> ~/.pi/agent/complains.md <<'EOF'`. Never rewrite, edit, or delete existing entries; never use `write`.
- No bash → list complaints under a `Complaints` heading in your final result; the parent appends them.

## Before appending

- `rg -i <keywords> ~/.pi/agent/complains.md`.
- Same issue already there → append nothing, unless you have NEW facts. Then one line:
  `- <date> re "<existing heading>": <new fact>`.

## Format

```
## <YYYY-MM-DD> — <component>: <title>
- symptom, with the exact error
- impact
- suggested fix
```

One issue per entry. At most 5 bullets.

## Not a complaint

- Caveats the tool already prints (e.g. lsp "no venv" notes).
- Repo/product bugs that are part of the task itself.
- Your own mistakes: fix your habit instead.
