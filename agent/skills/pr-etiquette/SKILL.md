---
name: pr-etiquette
description: Rules for any text posted on GitHub (PR titles/descriptions, PR comments, review replies, thread resolutions) and for driving an open PR to approval. MUST read before writing or posting anything on a PR.
---

# PR etiquette

## Writing

- Write in ASD-STE100 Simplified Technical English. No caveman speech.
- Be upfront, specific, concise. Lead with the conclusion.
- Respect the reader's time: put appendices and extra detail in collapsed
  `<details><summary>…</summary>…</details>` blocks.
- Cite the code, behavior, check, or reproduction. Separate verified facts
  from judgment.
- No filler, canned thanks, or status narration ("still waiting", "on it").
- Frontend change → put screenshots in the PR description (`gh … --attach`).
- Before posting, check the full text, quotes, and attachments for secrets and
  private details.

## Comments posted on the user's behalf

Prefix every agent-authored comment (top-level, inline review comment, reply
to bots or humans, reason before resolving or dismissing) with:

```md
> [!NOTE]
> 🤖 **<model> responding on behalf of <user>**

Actual comment starts here.
```

- `<model>`: public model name from `$PI_MODEL`. Unknown → `pi`. Never guess.
- `<user>`: `gh api user --jq .login`.
- Attribution inside the note, reply outside it. No heading, rule, signature,
  or second attribution.
- Do not add it to PR descriptions, commit messages, or text the user asked to
  post verbatim.
- Write the body to a file and post with `--body-file`, so quoting and blank
  lines render as written. Verify GitHub returned the comment URL.
- Never post a comment that does not serve the user's request.

## No loose ends

Once a PR is open (not draft), drive it to approval:

- Reply to every review comment. Resolve a thread only after the reply posted
  and the point is addressed or declined with a reason.
- Changes requested → fix, push, post one short update comment, re-request
  review (`gh pr edit <n> --add-reviewer <login>`).
- Keep CI green. The only remaining blockers may be human reviewers.
- Watching CI and review bots: `babysit-pr` skill.

Resolve a thread (GraphQL; get thread ids from `reviewThreads { nodes { id isResolved } }`):

```bash
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<thread-id>
```
