# tmux-subagents

Async subagents in tmux panes, exposed through one tool: `tmux_subagent`.

Hot-loaded from `~/.pi/agent/extensions/tmux-subagents/index.ts`; `/reload` picks up edits.

## Flow

```
tmux_subagent({ name, task, agent })  → returns immediately ("started")
child pi runs in its own tmux pane    → widget above the editor shows live state
you keep working                      → session stays interactive
child finishes                        → result is steered back, triggering a turn
```

Widget:

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  Scout: Auth (scout)        active · bash 7m │
│ 00:45  Scout: DB (scout)                waiting 2m │
╰────────────────────────────────────────────────────╯
```

States: `starting`, `active`, `waiting`, `stalled`. They come from an activity
snapshot the child writes (`activity.ts`), not from session-file growth. Stall
and recovery transitions steer a note back to the parent, except for
`interactive` children (the user is driving that pane already).

Panes: layout shared with the `tmux` tool via `@pi-ext/tmux-layout` — one
full-height column per spawn depth, so a pane is always right of its spawner:

```
| pi (+ your panes) | depth 1: subagents + tmux panes of pi | depth 2: panes of depth-1 agents |
```

Each column stacks vertically, rebalanced to equal heights on create/close;
worker columns share the width right of pi. Columns are ordered by numeric
`@pi_depth`, even when a shallower column is recreated after its panes close.
Only tagged panes count as workers. Your own splits retain their split tree
in the left region; its width stays fixed while workers remain. The first
worker column shares the window with that region; closing the final worker
returns the full window to it.

Live pane depth determines the next column, with `PI_SUBAGENT_DEPTH` as a
fallback. Launches and resumes both propagate this depth and obey the same
nesting cap. Layout changes are serialized across pi processes in one window.

Nested delegation: an auto-exit child does not exit while it still has running
subagents or pending tmux panes (exiting would kill them). Every tmux command
closes its pane on completion and delivers a snapshot path in the session folder.
Results steer back, trigger a turn, and the child exits after that turn.
`subagent_done` refuses for the same reason.

## Actions

| Call | Effect |
| --- | --- |
| `{ name, task, agent? }` | Launch (default action). Fire-and-forget. |
| `{ action: "list" }` | Agent definitions found on disk |
| `{ action: "status" }` | Running children, state and elapsed |
| `{ action: "send", id, message }` | Deliver a follow-up prompt to a live child |
| `{ action: "interrupt", id }` | Escape the child's current turn; session stays alive |
| `{ action: "stop", id }` | Kill the child pane, return its last output |
| `{ action: "resume", sessionPath, message? }` | Restart a previous child session |

Launch parameters: `name`, `task`, `agent`, `tools`, `skills`,
`systemPrompt`, `cwd`, `fork`, `interactive`. No model override: the child
uses the agent definition's `model`/`thinking`, else the parent's.

Commands: `/subagent <agent> <task>`, `/iterate <task>` (forks this session into a pane).

## Child-side tools

Every child loads `child.ts` and `builtin:codemode` via `-e`, including resumes:

- `subagent_done({ message? })` — finish; `message` is the summary, else the
  last assistant text.
- `caller_ping` — ask the parent for help, exit; parent can `resume` the session.
- Ctrl+J toggles the child's identity/tools widget.

A `tools` allowlist (param or frontmatter) is passed as `--tools`, which replaces
the default selection; `subagent_done`, `caller_ping`, and pi's built-in
`codemode` are always added, so every child can run codemode scripts using its
allowed tools. The allowlist also restricts tools callable through codemode;
MCP tools are unavailable unless explicitly named. Without an allowlist,
children use `defaultTools` from settings. On session start (including reload
and resume), `child.ts` activates codemode without changing the other active
tools, even if project defaults omit it or disable the built-in extension.

## Bundled agents

| Agent | Model | Role |
| --- | --- | --- |
| `scout` | `openai-codex/gpt-6-luna:high` | Read-only evidence gathering |
| `delegate` | `openai-codex/gpt-6.1-sol:high` | General helper; no `tools` allowlist, so MCP tools (agent-browser, …) stay reachable; `ask`/`goal` denied |
| `researcher` | `openai-codex/gpt-6-luna:high` | External web research → sourced brief |
| `reviewer` | `openai-codex/gpt-6.1-sol:high` | Read-only code review → evidence-backed findings |

Precedence: `.pi/agents/` (project) > `~/.pi/agent/agents/` (global) > bundled.

Frontmatter: `name`, `description`, `model`, `thinking`, `tools`, `skills`,
`system-prompt` (`append`/`replace`), `session-mode`
(`standalone`/`lineage-only`/`fork`), `auto-exit`, `interactive`, `spawning`,
`deny-tools`, `cwd`, `disable-model-invocation`.

`deny-tools` (plus `tmux_subagent` when `spawning: false`) is passed as
`--exclude-tools` and `PI_DENY_TOOLS`, so the child cannot call those tools.
Use it instead of `tools` when a role must keep MCP tools: allowlists match
exact names only, so MCP tools are unreachable unless listed one by one. Independently, launches are capped at `PI_SUBAGENT_MAX_DEPTH`
(default 2).

## Env

| Var | Meaning |
| --- | --- |
| `PI_SUBAGENT_SHELL_READY_DELAY_MS` | Wait before sending the launch command (default 500) |
| `PI_SUBAGENT_MAX_DEPTH` | Max nesting depth (default 2) |
| `PI_CODING_AGENT_DIR` | Propagated to children; `cwd/.pi/agent` wins when present |

## Files

```
index.ts     parent extension: tool, widget, watcher, renderers
child.ts     child extension: subagent_done, caller_ping, activity recorder
tmux.ts      pane primitives + exit polling
activity.ts  child activity snapshot (write/read/validate)
status.ts    snapshot → status kind, transitions, status lines
session.ts   child session seeding, summary extraction
agents/      scout, delegate, researcher, reviewer
```

Checks from the extensions workspace: `pnpm --filter pi-tmux-subagents test` and `pnpm check`.
