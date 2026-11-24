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
Only the PR owner (the agent running `full-land`, `full-pr`, or `takeover` for
it) runs `pr-wait`: one watcher per PR. Helper subagents (reviewers, scouts)
never start it. On a stack, watch each PR you own, not just the bottom PR's CI.

Start it with the `tmux` tool and end your turn:

```
tmux run  pane: pr-wait-<n>
          command: ~/.pi/agent/skills/babysit-pr/scripts/pr-wait <n> [--repo owner/name] [--until ready]
```

The tmux tool wakes you only when the process exits, then gives a snapshot
path. Read the snapshot. Every `#<n> …` line is an event.

| `--until` | Exits 0 | Exits 1 (act) |
|---|---|---|
| `ready` (default) | gating checks green, other checks finished, no unresolved threads or pending bot review, approval granted or not required, not a draft, merge state known and not BLOCKED/BEHIND/DIRTY/DRAFT, quiet `--settle` s (default 300) | new actionable discussion, gating check failure, DIRTY, BEHIND, unresolved threads, changes requested, or merge state still UNKNOWN after the quiet period |
| `green` | current-head gating checks green | gating check failure, DIRTY |
| `merged` | PR merged | PR closed, dequeued, unmergeable queue entry, or required merge-group check failed |
| `any-change` | first new event (including base overlap) | PR closed, API error |

Gating checks = required checks of the base branch, else every check. Use the
latest run per workflow; a missing required job is pending, not inherited.
Cancelled runs do not raise failures. A pending non-gating check blocks
`ready`, not `green`.

New human comments, review verdicts, inline threads and substantive bot
reviews or comments count as events, including bot placeholders edited into
findings. Progress, linkbacks and no-findings boilerplate do not wake the
watcher. A bot review request or visible progress can block `ready`; a later
submitted review on the same head clears the matching placeholder. Bot work
with no visible signal relies on `--settle`; raise it for slow bots. Exit 0
also on merge; exit 1 on close or unrecoverable API error; exit 2 on bad input
or a second watcher.

Start after each push, after handling an exit 1, and after a resume. Handle
what arrived while stopped before restarting. Discussion starts at watcher
start. On a head change, use the preceding poll or known force-push time as
the cutoff so discussion between polls is not lost. Existing unresolved
threads and review decisions still gate readiness.
- A wake is news, not a merge decision. Check the merge gate yourself.
- When an event needs no action, restart the watcher and end your turn with no
  message. Never say "still waiting".
- Stopping (ready, blocked, handing off) → `tmux stop` the window first.

## Rate limits

`pr-wait` uses GraphQL for state, checks, required-check rules, reviews and
queue state. REST is only for informational base file overlap. Default poll
interval is 120 seconds; keep it for parallel watchers. Rate-limited requests
back off until GitHub's retry/reset time. For a separate workflow run, use
`gh run watch <id> --interval 30 --exit-status`, never the 3-second default.

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

- Base movement or file overlap is informational. Once filed, rebase only
  for GitHub's DIRTY or BEHIND (strict checks), or to repair a merge-queue
  drop/failure. Push with `--force-with-lease`, then recheck the new head.
- An overlapping PR makes this one obsolete → stop watching, report, ask before
  closing.
- Merge only when the user asked for it (e.g. `full-land`). Re-check the live
  head and merge gate right before merging or enqueuing.

Standalone PR with required merge queue → enqueue the approved head directly.
`gh pr merge` can attempt auto-merge and fail with `Auto merge is not allowed`.
Set `n`, `id` (PR node ID) and `sha` (verified head SHA) first:

```bash
gh api graphql -f query='mutation($id:ID!,$sha:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$sha}){mergeQueueEntry{position state}}}' -f id="$id" -f sha="$sha" &&
  ~/.pi/agent/skills/babysit-pr/scripts/pr-wait "$n" --until merged
```

Run in tmux. Get `id` and confirm `sha` with
`gh pr view <n> --json id,headRefOid`. Outside the PR checkout, add `--repo`
to the watcher. Queue position shows progress, not readiness or success.

PR in a GitHub stack → `enqueuePullRequest` fails with
`must be enqueued using the asynchronous merge REST API`. `gh stack merge <pr>`
also merges every unmerged layer below `<pr>`: each one needs the user's merge
authorization and a passing gate. Then use `gh stack merge <pr> --yes`, then run
`~/.pi/agent/skills/babysit-pr/scripts/pr-wait <n> --until merged`.
