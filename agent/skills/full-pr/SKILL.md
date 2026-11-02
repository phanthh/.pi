---
name: full-pr
description: Same as full-land but stop with the PR ready for the user to merge; never merge. Trigger when the user says "full pr".
---

# Full PR

Read `full-land` (`../full-land/SKILL.md`) and follow its steps, proof, review
loop, babysitting, and asking rules. A "full pr" request grants the same
testing permission. Its merge permission does not apply. The rules below
override it.

## No merging

Allowed on this task's branch: commit, push, rebase, fix conflicts,
`--force-with-lease`. Never merge, enable auto-merge, enter a merge queue, push
to the default branch, bypass branch protection, or delegate any of these.

Before work begins, and again before each push: disable auto-merge
(`gh pr merge <n> --disable-auto`) and remove the PR from any merge queue.
Report these changes. Cannot prevent automatic merging → report the blocker
before going on.

## Stop at the gate

Use full-land's merge gate as the readiness check. Replace its merge and report
steps with a handoff. Proof and review must cover the final diff; recheck
behavior changes and meaningful conflict fixes before handoff.

Fetch the base, then check the live PR: head, base, checks, reviews,
mergeability. Confirm it is open, not a draft, and not set to merge without the
user. Someone else merged it → report that.

- **Ready to merge:** gate passes. Leave the PR open and unmerged.
- **Waiting for required approval:** only human approval remains. Confirm that
  is the actual blocker.
- **Blocked:** what prevents readiness, what you tried, what is needed. Follow
  full-land's asking rules.

`tmux stop` the `pr-wait` window before the handoff or a question. Report: PR
link, final head, verdict, proof, review outcome, remaining risks, and whether
the PR is still open and unmerged.
