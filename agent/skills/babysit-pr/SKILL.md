---
name: babysit-pr
description: Watch a pull request through CI, human review, and review bots; fix real findings. Use when the user asks to monitor, watch, or babysit a PR, or after filing a PR the user wants driven to green/approval.
---

# Babysit PR

Read `pr-etiquette` before posting anything.

## Waiting: `pr-wait` in a tmux window

Never write your own watcher, polling loop, or `sleep` loop. Never run
`gh pr checks --watch` and `pr-wait` on the same PR. One watcher per PR. All
watchers on a GitHub account share one rate limit.

First handle what already exists (failed checks, open threads, comments).
`pr-wait` records existing state as a baseline and reports only new events.

Then start it with the `tmux` tool and end your turn:

```
tmux run  pane: pr-wait-<n>
          command: <abs path to this skill>/scripts/pr-wait <n> [--repo owner/name] [--until ready]
```

The tmux tool wakes you only when the process exits, then gives a snapshot
path. Read the snapshot. Every `#<n> …` line is an event.

| `--until` | Exits 0 | Exits 1 (act) |
|---|---|---|
| `ready` (default) | gating checks green, all other checks finished, 0 unresolved threads, no CHANGES_REQUESTED, not BEHIND/DIRTY, quiet `--settle` s (default 300) on this head | any new comment/review/thread, gating check failed, DIRTY, BEHIND, base commits touching PR files; at green: unresolved threads or changes requested (each unchanged blocker once, then keeps waiting) |
| `green` | gating checks green | check failed, DIRTY |
| `any-change` | first event of any kind | — |

Gating checks = required checks of the base branch, else every check.
Review bots are not named: any bot or human comment is an event, and the quiet
period stands in for "bots finished". Raise `--settle` for slow bots. A
non-gating check stuck in pending blocks `ready`: fix it or use `--until green`.
Exit 0 also on merge; exit 1 on close; exit 2 on bad input or a second watcher.

Restart `pr-wait` after each push, after handling an exit 1, and after a
resume. Its state file keeps events that arrived while it was down. If it says
another pid watches the PR, do not start a second one.

- Only the agent that owns the PR watches it. Subagents never start `pr-wait`.
- A wake is news, not a merge decision. Check the merge gate yourself.
- When an event needs no action, restart the watcher and end your turn with no
  message. Never say "still waiting".
- Stopping (ready, blocked, handing off) → `tmux stop` the window first.

## Rate limits

`gh pr create/view/checks` and `pr-wait` use GraphQL. Exhausted
(`gh api rate_limit --jq .resources.graphql`) → use REST:
`gh api repos/<o>/<r>/pulls/<n>`, `gh api repos/<o>/<r>/commits/<sha>/check-runs`.
Wait for `reset` with one background command before watching again.

## Findings

- Act only on checks and comments newer than the latest push.
- Verify every finding (bot or human) against the source before changing code.
- CI failure: repository failure → fix. Infrastructure flake → rerun once
  (`gh run rerun <id> --failed`), note it.
- False positive or not worth it → reply with a written reason, then resolve.
- Fight scope creep. Review loops grow PRs one cheap fix at a time. Fix real
  bugs in the intended case. Decline the rest with a reason and list as
  follow-ups: unneeded tests, guards for edge cases that do not matter, extra
  compat, small perf costs. Prefer the fix that deletes or narrows code.
- Run the relevant local checks before each push.

## Base branch and merging

- `pr-wait` reports base commits that touch this PR's files and BEHIND/DIRTY.
  Rebase when needed; push with `--force-with-lease`.
- An overlapping PR makes this one obsolete → stop watching, report, ask before
  closing.
- Merge only when the user asked for it (e.g. `full-land`). Otherwise report
  the PR is ready.
- Right before a merge: `git fetch`, re-check the PR. Never merge when BEHIND,
  DIRTY, or when base commits that landed after the last green run touch this
  PR's files: rebase, push, wait for green again.
