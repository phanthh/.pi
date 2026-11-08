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
  never depends on memory. Each pi sees and controls only its owned windows,
  including runs explicitly handed over by a child.
- Lead sessions get `detach-on-destroy previous`: a client viewing one moves to
  the previous session when it dies. Use `prefix s` / `prefix w` to look in.

## Flow

```
tmux_subagent({ name, task, agent })  → credential preflight, then returns "started"
launch script runs pi in the window   → widget above the editor shows live state
child finishes                        → result is steered back, triggering a turn
script: pi … 2> bounded stderr writer; echo $? > <session>.status
        [; tmux kill-session (lead)]
watcher (1s): .exit → done/error (provider refusal may resume once on fallback);
              pane + process gone without .exit → exit code + stderr + last work
```

Widget (box from `@pi-ext/tmux-windows/widget`, also used by the `tmux` tool's window list):

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

- Non-interactive children auto-exit after the run settles (including pi's
  automatic retries), unless their own
  subagents/tmux runs or queued messages are pending or a `caller_ping` awaits a reply.
- Provider-error turns also exit interactive children when these blockers clear,
  allowing the parent to report the error or resume on a configured fallback.
- Before launch/resume, pi's model registry/auth APIs resolve provider credentials
  and refresh expired OAuth when supported. Missing/unusable credentials return
  an error, not a launch acknowledgement. No model request is made. A local child
  agent directory uses its own auth/models storage. This cannot detect remotely
  revoked credentials or prove an unexpired token will be accepted.
- Child stderr is retained as `<session>.stderr` (last 64 KiB). A process/pane
  disappearing without `.exit` reports its exit code (`-1` = unknown), up to 30
  stderr lines, and last persisted work (pending tool call or assistant snippet).
  Crash-truncated JSONL entries do not prevent diagnostic extraction.
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
re-watches them: results, room inboxes, `status` and `stop` keep working.

## Rooms

Every pi process hosts a room for its direct children (root, leads, and
non-lead spawners such as `reviewer`). `room` is the only agent-to-agent
channel: there is no `send` action and no ping sidecar. Files, so nothing needs
a live relay:

```
~/.pi/agent/rooms/<host session id>/
  members/<name>.json         host-only writer: status running|done|failed|stopped|lost,
                              pane/session, final result (≤4000 chars)
  inbox/<name>/<ts>-<r>.json  any member writes; owner deletes when Pi consumes it
  activity/<name>.json        recipient writes busy flag + active tools/start times
```

- Every process has a `room` tool: `members`, or `send` to `to`. A process sees
  two scopes: its parent's room (`PI_ROOM`: `parent` + siblings) and its own
  (its children). `all` = everyone reachable. A name that is both a child and a
  sibling is refused as ambiguous. Inboxes are polled every 1s and steered in
  (`room_message`, triggers a turn). No blocking wait: replies just arrive.
  `send` reports `delivered` for idle recipients, otherwise `queued: <name> busy
  in <tool> for <duration>` (or agent-turn/activity-unknown detail). Tools are never
  interrupted. `members` includes unread count and oldest-unread age for every
  member, including the parent. Queued steering stays unread on disk until its
  custom message is persisted in the session. Reconciliation runs before provider
  requests, on settle, and on startup; each process queues a given inbox file once.
  On settle, unread mail discarded by clearing pi's steering queue is eligible
  for delivery again. A crash before persistence can replay a message.
- Host's `parent` inbox steers into the host. `caller_ping` is a flagged room
  message to `parent` (`subagent_ping` steer); the host answers with
  `room({ action: "send", to: <child name>, message })`.
- Names are addresses: launch/resume refuse a name a running child already has.
- `status` also lists the last 10 finished members with their results.
- Host restart/adoption: live `running` members are re-watched; known `.exit`
  completions still deliver. Members with no live pane/process and no `.exit`
  become `lost`. One aggregated steer lists them, diagnostics, `pi --session`
  resume commands, and `tmux_subagent` resume hints; later restarts do not repeat
  already-lost members.
- `resume` refuses a session some live process has open (`--session <path>`
  in `/proc/*/cmdline`).
- Rooms untouched for 7 days are pruned when a host starts.

## Actions

| Call | Effect |
| --- | --- |
| `{ name, task, agent }` | Launch (default action). Fire-and-forget. |
| `{ action: "list" }` | Agent definitions this role may launch |
| `{ action: "status" }` | Running children, state, elapsed, lead session; recently finished room members |
| `{ action: "interrupt", id }` | Escape the child's current turn; session stays alive |
| `{ action: "stop", id }` | Kill the child (lead: its whole session), return its last output |
| `{ action: "resume", sessionPath, name?, message? }` | Restart a child session with its original role |

Params: `action, name, task, agent, cwd, id, message, sessionPath`. No model or
tools override: the definition decides (model, else the parent's).

## Child-side tools

Every child loads `child.ts` and `builtin:codemode` via `-e`, including resumes:

- `subagent_done({ message?, keepWindows? })` — finish; `message` is the summary,
  else the last assistant text. Running subagents always block. Pending tmux
  runs also block unless `keepWindows: true` transfers them to the parent.
  Handed-over windows keep running, move into the parent's tmux session when
  necessary (before the child lead session is destroyed), and switch
  `@pi_owner` to the parent's pane. Name collisions get `-2`, `-3`, … suffixes;
  run creation and handover serialize name allocation with the system `flock`
  command (5s lock deadline; timeout refuses the transfer). Locks release on
  process death. Zero-byte lock files in the OS temp dir are kept so waiters
  always share the same inode.
  The result lists the final names; the parent can use `tmux` read/send/stop.
  Parent adopts before releasing its child-completion blocker (preventing
  nested auto-exit); its widget and 2s sweep also recover runs from `@pi_run` metadata
  (command, start time, snapshot/status/script paths, wait-for channel).
  Completion snapshots steer to the parent, not the child. Child quit leaves
  transferred windows alone. If transfer fails, finishing is refused; retry
  with `keepWindows: true` or wait for remaining runs to complete.
- `caller_ping({ message })` — ask the parent for help via the room. The child
  stays alive; the parent's `room` reply arrives as its next message.
- `room` comes from `index.ts` (every process); see Rooms.
- Ctrl+Alt+J toggles the child's identity/tools widget.

A `tools` allowlist is passed as `--tools`; `subagent_done`, `caller_ping`, `room` and
`codemode` are always added. Without one, children use `defaultTools`.

Every task prompt starts with `Current date: YYYY-MM-DD (Weekday)`.

## Agent definitions

Only bundled `agents/*.md` are read. Frontmatter is the only policy source;
code holds no agent names.

| Key | Meaning |
| --- | --- |
| `name`, `description` | identity |
| `model`, `thinking` | fixed model for the role |
| `fallbackModel` | optional provider/model for one automatic refusal recovery |
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
- Each launch writes `<session>.launch.json` (v2: agent, model, fallbackModel,
  fallbackUsed/fallbackFrom, prompt, tools, denies, spawns, lead, interactive, cwd).
  Resume rebuilds from it and merges the resumer's denies; sessions without a
  v2 file are refused.

### Provider refusal fallback

Only `reviewer` and `delegate` define `fallbackModel: anthropic/claude-opus-5-5`.
`scout` and `researcher` have none. Parent matches **provider error text only**
against this tight list (`src/refusal.ts`):

- `/flagged for possible cybersecurity risk/i`
- `/\bcontent.?filter\b/i`
- `/\bsafety.?(system|policy)\b/i`
- `/\binvalid_prompt\b/i`

Auth, quota/rate-limit, billing, network, timeout and HTTP 401/403/429/5xx errors
are excluded. Matching errors resume the **same session**, role and room name
on the fallback with `continue`, through the manual resume path. The one-switch
budget is persisted before attempting recovery and survives reload/restart/manual
resume. Parent waits for the old process to exit before restarting; only the
final attempt delivers a completion, which records the model switch. A missing
fallback, failed fallback/preflight, or second refusal reports the provider error
and last partial assistant text instead of discarding partial work.

## Env

| Var | Meaning |
| --- | --- |
| `PI_SUBAGENT_ID`, `_NAME`, `_AGENT`, `_SESSION`, `_ACTIVITY_FILE` | set for every child |
| `PI_SUBAGENT_PARENT_PANE` | spawner's tmux pane; target for `keepWindows` handover |
| `PI_SUBAGENT_INTERACTIVE=1` | interactive child (no auto-exit) |
| `PI_SUBAGENT_LEAD=1` | lead child (own tmux session) |
| `PI_ROOM` | room dir the child is a member of |
| `PI_SUBAGENT_SPAWNS`, `PI_DENY_TOOLS` | policy, see above |
| `PI_CODING_AGENT_DIR` | propagated; `cwd/.pi/agent` wins when present |

## Files

```
src/index.ts     parent extension: tool, widget, watcher, cascade, renderers
src/child.ts     child extension: subagent_done, caller_ping, auto-exit, activity recorder
src/tmux.ts      pane I/O + sidecar polling (.exit/.status)
src/activity.ts  child activity snapshot (write/read/validate)
src/status.ts    snapshot → status kind, transitions, idle note rule
src/session.ts   summary extraction + last persisted work diagnostics
src/auth.ts      credential-only launch/resume preflight
src/refusal.ts   tight refusal/error classifier
src/policy.ts    deny inheritance, spawns gate, launch spec sidecar
src/room.ts      rooms: roster, inbox, addressing, prune, live-session check
agents/          bundled definitions
```

Check from the extensions workspace: `pnpm check`.
