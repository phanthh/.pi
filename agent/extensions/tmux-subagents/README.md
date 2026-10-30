# tmux-subagents

Async subagents in tmux, exposed through one tool: `tmux_subagent`.

Hot-loaded from `~/.pi/agent/extensions/tmux-subagents/src/index.ts`; `/reload` picks up edits.

## Model

The tmux **session** is the unit of ownership:

```
tmux server
├── session "0"                      ← lead (manual pi, no PI_SUBAGENT_ID)
│   ├── win: pi                      ← yours, untouched
│   ├── win "Scout: Auth"   @pi_owner=%lead @pi_subagent   (follower)
│   ├── win "Review"        @pi_owner=%lead @pi_subagent   (follower)
│   ├── win "Scout: DB"     @pi_owner=%rev  @pi_subagent   (reviewer's child → same session)
│   └── win "build"         @pi_owner=%lead @pi_name       (`tmux` tool run)
└── session "0-fix-auth"    @pi_session_owner=%lead        ← `lead: true` child = new lead
    ├── win: pi (child lead)         ← exits → its script kills the whole session
    └── win "Scout: X"      @pi_owner=%child-lead
```

- Every child opens as a detached window (`-d`, focus never moves) in the
  spawner's own session. A child whose definition has `lead: true` gets a new
  detached session `<spawner session>-<slug>` (`-<id4>` when taken) instead; it
  owns that session, and its own runs and children land there.
- Ownership lives in tmux user options (`@pi-ext/tmux-windows`), so cleanup
  never depends on memory. Each pi sees and controls only what it created.
- Lead sessions get `detach-on-destroy previous`: a client viewing one moves to
  the previous session when it dies. Use `prefix s` / `prefix w` to look in.

## Flow

```
tmux_subagent({ name, task, agent })  → returns immediately ("started")
launch script runs pi in the window   → widget above the editor shows live state
child finishes                        → result is steered back, triggering a turn
script: pi …; echo $? > <session>.status [; tmux kill-session (lead)]
watcher (1s): .ping → "needs help" steer; .exit → done/error;
              pane gone → .status (0 = closed, ≠0 = crash code)
```

Widget:

```
╭─ Subagents ──────────────────────────────────── 2 running ─╮
│ 00:23  Scout: Auth (scout)                active · bash 7m │
│ 00:45  Fix auth (delegate) @0-fix-auth          waiting 2m │
╰────────────────────────────────────────────────────────────╯
```

States: `starting`, `active`, `waiting`, `stalled`, from an activity snapshot
the child writes (`activity.ts`). Stall/recovery transitions steer a note to the
parent, except for `interactive` children.

Ending:

- Non-interactive children auto-exit after a completed turn, unless their own
  subagents/tmux runs are pending or a `caller_ping` awaits a reply.
- `interactive: true` children never auto-exit. They end via `subagent_done`,
  the spawner's `stop`, or the user quitting pi in that window/session. If one
  sits `waiting` ≥ 2 min with nothing pending and no unanswered ping, the
  spawner gets one note per idle episode.

Cascade on the spawner's `session_shutdown` (found by tags, so children
orphaned by an earlier `/reload` are included):

| reason | subagent windows | child lead sessions |
| --- | --- | --- |
| quit (incl. SIGHUP from a killed lead session) | kill | kill |
| new / resume / fork | kill | kill |
| reload | keep | keep |

Killing a lead session SIGHUPs its pi → graceful quit → it cascades its own
children. `/reload` hands live children to the new module (globalThis), which
re-watches them: results, pings, `status`, `send` and `stop` keep working.

## Actions

| Call | Effect |
| --- | --- |
| `{ name, task, agent }` | Launch (default action). Fire-and-forget. |
| `{ action: "list" }` | Agent definitions this role may launch |
| `{ action: "status" }` | Running children, state, elapsed, lead session |
| `{ action: "send", id, message }` | Deliver a follow-up prompt to a live child |
| `{ action: "interrupt", id }` | Escape the child's current turn; session stays alive |
| `{ action: "stop", id }` | Kill the child (lead: its whole session), return its last output |
| `{ action: "resume", sessionPath, name?, message? }` | Restart a child session with its original role |

Params: `action, name, task, agent, cwd, id, message, sessionPath`. No model or
tools override: the definition decides (model, else the parent's).

## Child-side tools

Every child loads `child.ts` and `builtin:codemode` via `-e`, including resumes:

- `subagent_done({ message? })` — finish; `message` is the summary, else the
  last assistant text. Refused while own children/runs are pending.
- `caller_ping({ message })` — ask the parent for help. The child stays alive
  (`.ping` sidecar); the parent answers with `{ action: "send", id, message }`.
- Ctrl+Alt+J toggles the child's identity/tools widget.

A `tools` allowlist is passed as `--tools`; `subagent_done`, `caller_ping` and
`codemode` are always added. Without one, children use `defaultTools`.

Every task prompt starts with `Current date: YYYY-MM-DD (Weekday)`.

## Agent definitions

Only bundled `agents/*.md` are read. Frontmatter is the only policy source;
code holds no agent names.

| Key | Meaning |
| --- | --- |
| `name`, `description` | identity |
| `model`, `thinking` | fixed model for the role |
| `tools` | allowlist (`--tools`) |
| `deny-tools` | `--exclude-tools` + `PI_DENY_TOOLS` |
| `system-prompt` | `append` / `replace`: body goes to the system prompt, else into the task |
| `spawning: false` | deny `tmux_subagent` |
| `spawns: a, b` | may launch/resume only these (`PI_SUBAGENT_SPAWNS`); omitted = anything |
| `lead: true` | child gets its own tmux session |
| `interactive: true` | no auto-exit (see Ending) |

Bundled behavior that results:

| Agent | Model | lead / interactive | May launch |
| --- | --- | --- | --- |
| `delegate` | `gpt-6.1-sol:high` | yes / yes | anything (`ask`, `goal` denied, inherited) |
| `reviewer` | `gpt-6.1-sol:high` | no / no | `scout`, `researcher` |
| `researcher` | `gpt-6-luna:high` | no / no | nothing |
| `scout` | `gpt-6-luna:high` | no / no | nothing |

Policy (`policy.ts`), at any depth:

- Denies accumulate: child denies = role denies ∪ launcher's `PI_DENY_TOOLS`.
- Each launch writes `<session>.launch.json` (v2: agent, model, prompt, tools,
  denies, spawns, lead, interactive, cwd). Resume rebuilds from it and merges
  the resumer's denies; sessions without a v2 file are refused.

## Env

| Var | Meaning |
| --- | --- |
| `PI_SUBAGENT_ID`, `_NAME`, `_AGENT`, `_SESSION`, `_ACTIVITY_FILE` | set for every child |
| `PI_SUBAGENT_INTERACTIVE=1` | interactive child (no auto-exit) |
| `PI_SUBAGENT_SPAWNS`, `PI_DENY_TOOLS` | policy, see above |
| `PI_CODING_AGENT_DIR` | propagated; `cwd/.pi/agent` wins when present |

## Files

```
src/index.ts     parent extension: tool, widget, watcher, cascade, renderers
src/child.ts     child extension: subagent_done, caller_ping, auto-exit, activity recorder
src/tmux.ts      pane I/O + sidecar polling (.exit/.ping/.status)
src/activity.ts  child activity snapshot (write/read/validate)
src/status.ts    snapshot → status kind, transitions, idle note rule
src/session.ts   summary extraction
src/policy.ts    deny inheritance, spawns gate, launch spec sidecar
agents/          bundled definitions
```

Checks from the extensions workspace: `pnpm --filter pi-tmux-subagents test`
(unit + e2e on an isolated tmux server with a stub `pi`) and `pnpm check`.
