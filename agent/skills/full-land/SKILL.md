---
name: full-land
description: Land a change end-to-end, unattended - finish, prove, review loop, file PR, babysit, merge. Trigger only when the user says "full land" / "land it" / "land this" or otherwise clearly asks to land work to a merged PR.
---

# Full Land

"Landing" = whole path from change to merged PR. The user is not watching.
Updates go unread until long after you stop. You own the work from its current
state to a merged PR.

No clear "land" request → do not assume this autonomy.

## Grant

A "full land" request permits, for this task only:

- Merging the PR once the merge gate passes.
- `git push --force-with-lease` on this task's branch after a rebase.
- Every test method Proof needs without asking first (running the app or dev
  server, `agent-browser`, screenshots, simulators), even where project
  instructions say to ask first. Project rules on *how* to test (commands,
  fixtures) still apply.

It does not cover anything under "Asking the user" and does not bypass harness
approval prompts.

## Steps

1. **Finish the change.** Smallest change that reaches the goal. Fix the case
   that happened, not every case that could. On the default branch → create a
   branch first. Dirty tree with unrelated work → use a worktree in `/var/tmp`.
2. **Prove it.** See "Proof".
3. **Review loop** with the `reviewer` subagent. See "Review loop".
4. **File the PR** with `file-pr`. Rebase onto the latest default branch first.
   Add one short line on how you proved the change, plus the review outcome
   (rounds, verdict) in a collapsed `<details>` block.
5. **Babysit** with `babysit-pr`. Fix real findings and CI failures. Prove each
   fix before pushing it.
6. **Merge** when the merge gate passes.
7. **Report**: PR link, merge commit, proof, review ledger summary, and every
   decision you made for the user.

Stay active from 1 to 7. Ending a turn is safe only while something will wake
you: a running `reviewer` subagent or a `pr-wait` tmux window. Ending a turn
with nothing pending stops the work, because nobody will prompt you again.

Write state to `/tmp/full-land-<branch>/` (`NOTES.md`, `ledger.md`) so it
survives compaction. Delete the directory after the report.

## Proof

Evidence you observed yourself in this session: command output, a
reproduction, a screenshot. Most direct first:

- Reproduce the failure, apply the fix, watch the same reproduction pass.
- Run the checks CI runs (typecheck, lint, tests) for the touched area.
  Long ones via `tmux` tool. Prefer CI for heavy suites.
- One focused test that fails without the fix, when the behavior has none and
  the repo has a test setup.
- UI/runtime behavior: run the app and look (`agent-browser`). Mocked green
  tests do not prove UX. Attach screenshots to the PR.

No way to prove a change → no full confidence → ask the user.

## Review loop

Reviewer = `reviewer` subagent (read-only). One reviewer at a time. Do not edit
files in scope while a round runs.

**Budget:** 3 rounds. Up to 5 only for security, auth/permissions, data loss,
or state/concurrency while a P0/P1 stays open with evidence. Stop early when a
round returns only P3. Comment/doc/format-only fixes need no new round.

**Round 1 brief** (self-contained):

```
Review target: repo <abs path>, base <merge-base sha>.
Diff: git diff <base> [-- <paths>]; also read untracked files from git status --short.
Intent: <1-2 sentences>. Out of scope: <…>.
Checks run: <command → result; missing or pre-failing checks>.
Hold to the smallest change that meets the intent. Use stable ids F1, F2, …
```

**Each finding:** check it and its priority yourself. Other paths, rare cases,
small cost, extra compat → P3, whatever label it came with, unless it causes
security or data loss.

- Agree → smallest fix. Prefer delete or narrow over a new lock, cache, helper,
  or option.
- Disagree → reason with evidence (file:line, test, output).
- P3 / out of scope → decline in one line, list as follow-up.

Keep `ledger.md`: id, priority, outcome (`fixed` / `disagree: <evidence>` /
`declined: <reason>`). Re-run checks and `git diff --shortstat <base>` after
fixes. Review grew the diff → cut first. Never agree just to end the loop.

**Next round** only when budget remains and a P0–P2 is open, behavior code
changed, or the last verdict does not cover the current diff. Resume the same
reviewer (`tmux_subagent` action `resume` with its session path) and send: the
ledger, the change since last round, and "follow-up round: review open ids and
changed code only; mark each prior id `resolved` or `still open: <reason>`".
Resume impossible → fresh `reviewer` with round 1 brief + ledger.

**Stop:** verdict correct on the current diff, no P0–P2 open, no concern of your
own. Stuck (item disputed after two replies, or budget ends): P0/P1 → ask the
user; P2/P3 → decide, record both sides in the report. Budget end is not
approval. Timeout, error, or no reply is not approval.

## Merge gate

All true on the latest head:

- Proof covers every change in the diff.
- Gating checks green.
- Review bots finished (`pr-wait --until ready` exited 0); each finding fixed
  or dismissed with a written reason.
- No human review still requests changes.
- Branch up to date with the default branch; GitHub reports it mergeable.

Merge with the method the repo uses (`gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed`,
recent merged PRs). Merge queue or auto-merge → enqueue, then watch with
`pr-wait <n> --until any-change` until it reports merged; handle failures.
Never use `--admin` or any branch-protection bypass. Automated "needs human
review" notes may be ignored when confidence is high. A required human
approval may not: ask the user.

## Asking the user

Use the `ask` tool, never a question in a normal message. Put all context in it:
PR link, blocker, options with your recommendation first. Stop `pr-wait`
first.

Ask only when you cannot continue alone:

- You cannot prove the change.
- The merge gate cannot pass and you cannot fix it.
- The next step is outside the grant: deleting data, touching production,
  changing things outside the repo, closing a PR, force-pushing another branch.
- The goal is ambiguous in a way that changes the result.
- Another PR makes this one obsolete.

Decide everything else with sensible defaults; list the decisions in the
report. No answer → safe path: leave the PR open and unmerged, start the final
message with the question.
