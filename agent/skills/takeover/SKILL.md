---
name: takeover
description: Take over and finish existing work - someone else's PR, a branch, or another agent's pi session. Use when the user asks to take over, pick up, or continue a PR, branch, or agent session.
---

# Takeover

Own the original goal and finish it. Keep the original contributors' credit.
Do not defend an implementation just because someone already built it.

## 1. Load the handoff

Read the source in full, including review findings and the user's later
corrections:

- PR: `gh pr view <n> --json title,body,author,commits,headRefName,headRefOid,baseRefName,reviews,comments`,
  review threads, full diff.
- Branch: `git log`/`git diff` against its merge base.
- pi session: the `.jsonl` under `~/.pi/agent/sessions/` (user names it or
  gives a path). Large → `scout` subagent to extract goal, decisions, open
  items, and the user's corrections into `/tmp/takeover-<name>.md`.

Resolve the handoff to the actual code at the current head. Account for
uncommitted work in its worktree (`git status`). Treat the handoff as context,
not proof: claims of "done" or "tested" need your own check.

Write the goal, what is done, and what is open to
`/tmp/takeover-<name>.md`. Delete it after the report.

## 2. Set up the continuation

- Default: new branch from the original commits (`git switch -c <new> <orig-head>`),
  your fixes as separate commits on top. Use a worktree in `/var/tmp` when the
  current tree is dirty or busy.
- In-place push to the original branch or a stacked continuation (`gh-stack`)
  only when the user asked for it.
- Never overwrite unrelated work. Never change, merge, or close the original PR
  without permission.

## 3. Bring it current, then finish

- Run `modernize` against the intended base. CLOSE or REWORK verdict → report
  and ask before going on.
- Rework only what the original goal needs. No unrelated features. Simplify
  without dropping intended behavior or surfaces.
- Re-check the source PR or branch before filing: it may have moved while you
  worked. Fold in new commits.

## 4. Prove it

Verify the original failure and realistic workflows yourself, by repository
rules (long runs via `tmux` tool; UI via `agent-browser`). Mocked green tests
do not prove UX. State what remains unverified.

## 5. Credit

- Keep Git authorship of imported commits and existing `Co-authored-by`
  trailers. Do not squash others' commits into yours.
- PR description: credit the original authors and link the original PR.
- Squash-merge repo → put `Co-authored-by: Name <email>` for each human
  contributor in the PR body/merge commit. Take identities from
  `git log --format='%an <%ae>'` of their commits; never guess emails.

## 6. Ship

Finish includes a PR → `file-pr` to file or update, then `babysit-pr`; do not
stop at creation. Any GitHub text → `pr-etiquette`. Merge or close the original
PR only with permission.

## Report

What you inherited, what you changed, how you verified it, how credit was
kept, and any open decision (e.g. close the original PR?).
