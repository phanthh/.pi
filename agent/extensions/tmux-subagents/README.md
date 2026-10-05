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
subagents or pending `autoExit` tmux panes (exiting would kill them). Their
results steer back, trigger a turn, and the child exits after that turn.
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

Launch parameters: `name`, `task`, `agent`, `model`, `tools`, `skills`,
`systemPrompt`, `cwd`, `fork`, `interactive`.

Commands: `/subagent <agent> <task>`, `/iterate <task>` (forks this session into a pane).

## Child-side tools

Every child loads `child.ts` and `builtin:codemode` via `-e`, including resumes:

- `subagent_done` — finish; last assistant message becomes the summary.
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
| `scout` | `anthropic/claude-opus-5:low` | Read-only evidence gathering |
| `worker` | `anthropic/claude-opus-5:medium` | Small approved implementation tasks |
| `delegate` | inherits the orchestrator's model and thinking level | General helper |
| `researcher` | `anthropic/claude-opus-5:medium` | External web research → sourced brief |

Precedence: `.pi/agents/` (project) > `~/.pi/agent/agents/` (global) > bundled.

Frontmatter: `name`, `description`, `model`, `thinking`, `tools`, `skills`,
`system-prompt` (`append`/`replace`), `session-mode`
(`standalone`/`lineage-only`/`fork`), `auto-exit`, `interactive`, `spawning`,
`deny-tools`, `cwd`, `disable-model-invocation`.

`spawning: false` sets `PI_DENY_TOOLS=tmux_subagent` in the child, so it cannot
delegate further. Independently, launches are capped at `PI_SUBAGENT_MAX_DEPTH`
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
agents/      scout, worker, delegate, researcher
```

Checks from the extensions workspace: `pnpm --filter pi-tmux-subagents test` and `pnpm check`.
