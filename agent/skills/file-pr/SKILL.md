---
name: file-pr
description: File a concise pull request that leads with the problem. Use when the user asks to file, open, or create a PR.
---

# File PR

Read `pr-etiquette` first.

1. Check for an existing PR for this branch: `gh pr view --json url,state`.
   Open → update it instead of opening a second one. Merged/closed → open a
   new PR (new branch if the old one merged).
2. Review the diff against the base (`git fetch origin && git diff origin/<base>...HEAD`).
   It must match the goal and nothing else.
3. Title: follow the repo's convention (check `gh pr list --state merged -L 10`
   and `git log`). Say why it matters, not what was touched:
   - ❌ `perf(server): negotiate permessage-deflate on the websocket`
   - ✅ `perf(server): cut websocket frame size by 70%+ with gzipping`
4. Description: open with the problem in plain words (from the user's original
   request), then the solution in a sentence or two. No implementation
   inventory up front. Put proof, file lists, and other detail in collapsed
   `<details>` blocks. If the repo has a PR template, fill it in the same spirit.
   - ❌ "Removed implicit workspace carry-over from every new-thread entry
     point (cmd+n, sidebar buttons, command palette). Deleted
     buildContextualThreadOptions, …"
   - ✅ "The 'new worktree' default was ignored when starting new threads on
     existing worktrees. Now the user's preference always applies."
5. Open a real PR, not a draft, so review bots run (unless the user asked for a
   draft). Write the body to a file and use `--body-file`.
   GraphQL rate limit used up → REST:
   `gh api repos/<owner>/<repo>/pulls -f title=… -f head=… -f base=… -F body=@<file>`.
6. Report the PR URL. User also asked to watch/babysit → `babysit-pr`.

Stacked PRs → `gh-stack` skill instead.
