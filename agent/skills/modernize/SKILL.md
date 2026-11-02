---
name: modernize
description: Bring an old PR up to date and decide whether it should still exist (MODERNIZE / REWORK / CLOSE). Use when asked to rebase an old PR or to "modernize" one.
---

# Modernize

Modernize the idea, not just the branch. A clean rebase does not prove the PR
still belongs in the product.

## Guardrails

- Fetch latest origin for the PR branch, the base, and any related branch first.
- Existing worktree changes are the user's. Dirty or busy worktree → own
  worktree in `/var/tmp`; remove it when done.
- Modernizing permits rebasing and updating the PR branch. It does not permit
  merging, closing, changing the base, or expanding scope.
- Never force-push unqualified. Use `--force-with-lease=<branch>:<head sha seen before rebase>`.
- No PR comment unless the user asked. Any GitHub text → `pr-etiquette`.

## 1. Establish intent

Record URL, state, base, head repo/branch, head SHA, author, checks, review
state. Read title, body, linked issues, commits, review threads, full diff.
State the smallest coherent goal the PR tried to reach before judging the code.

Record the merge base, so the original PR and later base changes can be
compared separately. Use the PR's real base branch.

## 2. Check what changed around it

Inspect base commits since divergence. Search merged and open PRs when titles,
code paths, or behavior suggest a replacement. Large history → fan out
`scout` subagents per area. Ask beyond overlapping lines:

- Same user-facing problem already solved?
- APIs, types, schemas, deps, or architecture boundaries changed?
- Both sides now own the same behavior or invariant?
- Changed code deleted, moved, or deliberately simplified?
- Would landing restore old behavior or create two ways to do one thing?
- Benefit still worth the maintenance cost?

"No conflicts" ≠ current.

## 3. Disposition before pushing

- **MODERNIZE**: goal useful, shape still right. Rebase, resolve, test, push.
- **REWORK**: goal useful, a mechanical rebase keeps the wrong implementation.
  Describe the smallest credible rewrite; stop before pushing unless the user
  asked for the rework.
- **CLOSE**: superseded, obsolete, wrong direction, or not worth its cost. Cite
  evidence and stop. Do not rebase it. Do not close without explicit permission.

Be willing to say CLOSE. Age is not evidence; sunk effort is not a reason.

## 4. Rebase without losing intent (MODERNIZE)

1. Branch or worktree at the recorded PR head.
2. Rebase onto the freshly fetched base.
3. Resolve each conflict by the PR's intent and the base's newer invariants. A
   conflict that shows a product/architecture disagreement → reconsider the
   disposition, do not guess.
4. `git range-diff <old-base>..<old-head> <new-base>..HEAD` and read the final
   diff. No intended behavior lost, no landed behavior reintroduced.
5. Run focused checks for the touched area (long ones via `tmux` tool).
   Separate real failures from pre-existing or infra ones.
6. Push with the lease from the guardrails. Lease fails → fetch and reassess.

Do not merge.

## Report

Lead with `MODERNIZE`, `REWORK`, or `CLOSE` and the reason. Then: meaningful
base changes; conceptual conflicts (or none found); rebase/push result; checks
and results; remaining decision or work, with the PR link. Separate observed
facts from judgment. Say what could not be verified.
