---
name: code-review
description: "Review the changes since a fixed point (commit, branch, tag, merge-base, or PR number/URL) along four axes: Risk (correctness, security, reliability, performance bugs the diff introduces), Standards (does the code follow this repo's documented coding standards and design smells?), Spec (does the code match what the originating issue/spec asked for?), and Lean (what can be deleted: over-engineering, reinvented stdlib, unneeded dependencies, speculative abstractions). Runs the reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, asks to \"review since X\", \"roast this PR\", \"is this safe to merge\", or \"what can we delete\" / \"is this over-engineered\"."
---

Four-axis review of diff between `HEAD` and user-supplied fixed point:

- **Risk**: what breaks in production? Correctness, security, reliability, performance.
- **Standards**: conforms to repo's documented coding standards + design smells?
- **Spec**: faithfully implements originating issue/spec?
- **Lean**: what can be deleted or shrunk? Over-engineering only. Diff's best outcome = getting shorter.

Axes run as **parallel sub-agents** (max 4, one per axis, no context pollution), then aggregate.

## Finding format (all axes)

Every finding = one line, pinpointed:

```
<file>:L<start>[-<end>]: [<flag>] <tag> <what>. <fix or quote>.
```

- `<file>` relative to repo root, always present — even single-file diffs.
- Line numbers = new-file side of diff. Finding about deleted code → `old L<n>`. Spec-side finding (missing requirement) → point at spec file+line.
- `[<flag>]` severity: `[P1]` = hard/critical — backed by documented standard or spec line (citable), `[P2]` = everything else (heuristics, judgement calls).
- `<tag>` axis-specific, defined per axis below.
- No prose paragraphs, no unanchored findings. Can't name file+line → not a finding.

Two rules binding on every axis:

- **No invented findings.** Unsure it's real → prefix `possible:` and state the uncertainty in the fix clause. Never manufacture a bug to fill a report. Empty axis is a valid result.
- **Diff-scoped.** Pre-existing problems in unchanged code are out of scope. Diff makes one worse or newly reachable → in scope, say which hunk does it.

## Process

### 1. Pin fixed point

User's ref = fixed point (SHA, branch, tag, `main`, `HEAD~5`, ...). None given → ask.

Diff command: `git diff <fixed-point>...HEAD` (three-dot → merge-base). Commits: `git log <fixed-point>..HEAD --oneline`.

Verify before spawning: `git rev-parse <fixed-point>` resolves, diff non-empty. Bad ref / empty diff fails here, not inside sub-agents.

**PR mode.** Input is a PR number or forge URL (`.../pull/5589` → `5589`) → fixed point = PR base, review target = PR head:

```bash
gh pr view <n> --json title,body,author,baseRefName,headRefName,files,additions,deletions,labels,state
gh pr diff <n>
gh pr view <n> --json comments,reviews --jq '{comments:[.comments[]|{author:.author.login,body:.body}],reviews:[.reviews[]|{author:.author.login,state:.state,body:.body}]}'
```

Fetch head so sub-agents read full files, not just hunks: `git fetch origin <headRefName>`, then `git show origin/<headRefName>:<path>`. PR body + existing review comments feed step 2 as spec candidates.

**Full-file context.** Every axis reads the whole current version of each changed file, not the hunks alone — bugs live in the surrounding code the diff now calls. >15 changed files → prioritise non-test source, then tests, then config/generated.

### 2. Find spec source

In order:

1. Issue refs in commit messages / branch name (`#123`, `Closes #45`, GitLab `!67`, ...).
2. Path user passed as argument.
3. Spec/plan file under `docs/`, `plans/`, `specs/` matching branch or feature.
4. Else ask user. No spec exists → Spec sub-agent skips, report "no spec available".

Spec tags (all `[P1]` — each cites a spec line):

- `missing:` requirement absent or partial. Location = spec file+line of the requirement.
- `creep:` diff behaviour spec never asked for. Location = diff file+line.
- `wrong:` requirement implemented but implementation looks incorrect. Location = diff file+line, quote spec line.

Examples:

✅ `specs/auth.md:L23: [P1] missing: "lock account after 5 failed attempts" — no lockout logic in diff.`

✅ `auth/login.py:L88-104: [P1] creep: password-strength meter. Spec never asks for it.`

✅ `auth/login.py:L52: [P1] wrong: spec says "case-insensitive email match" (specs/auth.md:L9), comparison is case-sensitive.`

### 3. Find standards sources + smell baseline

Standards sources: anything in repo documenting how code should be written (`CODING_STANDARDS.md`, `CONTRIBUTING.md`, ...).

On top, Standards axis always carries **smell baseline**: Fowler smells (_Refactoring_, ch.3), applies even when repo documents nothing. Two binding rules:

- **Repo overrides.** Documented repo standard wins; where it endorses what baseline flags, suppress smell.
- **Always judgement call.** Each smell = labelled heuristic ("possible Feature Envy"), never hard violation. Skip anything tooling already enforces.

Each smell: what it is → fix. Match against diff:

- **Mysterious Name**: name doesn't reveal what fn/var/type does or holds → rename; no honest name comes → design murky.
- **Duplicated Code**: same logic shape in multiple hunks/files → extract shared shape, call from both.
- **Feature Envy**: method reaches into another object's data more than its own → move method onto data it envies.
- **Data Clumps**: same few fields/params travel together → bundle into one type, pass that.
- **Primitive Obsession**: primitive/string stands in for domain concept → give concept its own small type.
- **Repeated Switches**: same `switch`/`if`-cascade on same type recurs → polymorphism, or one shared map.
- **Shotgun Surgery**: one logical change forces scattered edits across many files → gather into one module.
- **Divergent Change**: one module edited for several unrelated reasons → split, one reason per module.
- **Message Chains**: long `a.b().c().d()` navigation → hide walk behind one method on first object.
- **Middle Man**: class/fn mostly delegates onward → cut, call real target direct.
- **Refused Bequest**: implementer ignores/overrides most of what it inherits → drop inheritance, compose.

(Speculative Generality absent deliberately: Lean axis owns it as `yagni:`.)

Standards tags:

- `std:` documented-standard violation. Cite source: `(CONTRIBUTING.md: "rule text")`. Always `[P1]`.
- `smell:` baseline smell. Name it + the fix move. Always `[P2]`.

Repo docs also define **gates** — feature flags, kill-switches, required wrappers a new surface must go through. New surface bypassing one = `std:` `[P1]`, cite the doc line. Security consequence of the bypass belongs to Risk as `sec:`; both axes may report the same line.

Examples:

✅ `api/routes.py:L41: [P1] std: bare except swallows errors (CONTRIBUTING.md: "never catch bare Exception"). Catch specific error.`

✅ `models/user.py:L12-19: [P2] smell: Data Clumps — (street, city, zip) travel through 3 signatures. Bundle into Address type.`

### 4. Risk axis: what breaks in production

Risk sub-agent hunts defects the diff introduces — correctness, security, reliability, performance. Reads full changed files, not hunks: a correct hunk in a wrong caller is still a bug.

Severity here is consequence-based, not citation-based: `[P1]` = reachable on a normal path and costs correctness, data or security. `[P2]` = needs an unlikely precondition, or you can't prove reachability — then say so.

Tags:

- `bug:` wrong result on some input. Off-by-one, null/undefined access, missing `await`, inverted condition, wrong operator precedence, unhandled empty/zero/negative/huge/Unicode input, stale closure, missing hook dependency, unsafe cast hiding a real type mismatch.
- `race:` concurrency or ordering. Non-atomic read-modify-write, unguarded shared state, assumed completion order, missing idempotency on a retried path.
- `sec:` injection (SQL/shell/XSS), authz or auth bypass, secret in code or log, SSRF, unsafe deserialisation, missing CSRF, new user-initiated surface reachable without its required gate.
- `data:` integrity. Missing transaction across dependent writes, partial-failure state with no rollback, silent overwrite, destructive migration without a back-out.
- `resil:` survival under load or failure. No timeout on a network call, retry without backoff or without idempotency, unbounded fetch/memory/recursion, N+1 query, missing pagination, blocking call on a hot or async path.
- `blind:` failure nobody can diagnose. Swallowed exception, error branch with no log or no actionable message to the user.
- `test:` new behaviour with no test, or a test that asserts nothing, mocks the thing under test, or pins an implementation detail.

Examples:

❌ "Error handling in this module could be more robust."

✅ `sync/worker.py:L74: [P1] bug: await missing on flush_batch(); exception escapes as unhandled task, batch reported written.`

✅ `api/share.py:L31: [P1] sec: POST /share reachable with collaborator token; only owner check is on the GET (L18). Add the owner assert to the write path.`

✅ `billing/charge.py:L40-58: [P1] data: invoice insert and balance decrement in separate commits. Crash between = charged, not credited. One transaction.`

✅ `client/fetch.ts:L22: [P2] resil: no timeout on fetch to reporting API; hung upstream pins the request pool. AbortSignal.timeout(10_000).`

✅ `ui/Table.tsx:L61: [P2] possible: bug — rows memo omits "filter" from deps; stale rows after filter change unless parent remounts. Couldn't confirm parent behaviour.`

Guardrails:

- Style, naming, duplication, design smells → Standards. Excess complexity → Lean. Requirement mismatch → Spec.
- A defect that is also a documented-standard violation may appear on both axes. Don't suppress one to avoid overlap.
- Consistent-with-codebase is no defence: an unsafe pattern repeated everywhere is still `[P1]` when this diff adds another instance.
- Reports defects, never applies fixes.

### 5. Lean axis: delete-list format

Lean sub-agent hunts unnecessary complexity only. What to cut, what replaces it. All findings `[P2]` — net score carries the weight.

Tags:

- `delete:` dead code, unused flexibility, speculative feature. Replacement: nothing.
- `stdlib:` hand-rolled thing stdlib ships. Name the function.
- `native:` dep or code doing what platform already does. Name the feature.
- `yagni:` abstraction with one impl, config nobody sets, layer with one caller, hooks for needs spec doesn't have.
- `shrink:` same logic, fewer lines. Show shorter form.

Examples:

❌ "This EmailValidator class might be more complex than necessary, have you considered whether all these validation rules are needed at this stage?"

✅ `validators.py:L12-38: [P2] stdlib: 27-line validator class. "@" in email, 1 line, real validation is the confirmation mail.`

✅ `utils/date.ts:L4: [P2] native: moment.js imported for one format call. Intl.DateTimeFormat, 0 deps.`

✅ `repo.py:L88: [P2] yagni: AbstractRepository with one implementation. Inline it until a second one exists.`

✅ `client.py:L52-71: [P2] delete: retry wrapper around an idempotent local call. Nothing replaces it.`

✅ `parse.py:L30-44: [P2] shrink: manual loop builds dict. dict(zip(keys, values)), 1 line.`

End with `net: -<N> lines possible.` Nothing to cut → `Lean already. Ship.` and stop.

Guardrails:

- Correctness, security, reliability, performance out of scope — Risk axis owns them.
- Never flag: trust-boundary validation, error handling preventing data loss, security, accessibility. One smoke test / assert self-check = minimum, not bloat.
- Spec explicitly asked for it → not cuttable; lazier form exists → `shrink:` with that form, don't demand deletion.
- Lists cuts, never applies them.

### 6. Spawn sub-agents in parallel

Four sub-agents maximum, one per axis, all spawned in one batch. Never split an axis across several agents and never add a fifth — a new concern joins an existing axis.

Each prompt includes diff command + commit list + changed-file list + **Finding format section pasted in full** (sub-agents have no other access to it), plus:

**Risk**: full step-4 section pasted (tags, examples, severity rule, guardrails). Brief: "Report defects this diff introduces, one per line in the pinned format. Read the full current version of every changed file before judging. No findings → `No defects found.` Under 400 words."

**Standards**: standards-source files from step 3 + smell baseline + Standards tags/examples pasted in full. Brief: "Report every documented-standard violation (`std:`, cite file + rule) and every baseline smell (`smell:`, name + fix move), one finding per line in the pinned format. Documented standard overrides baseline. Skip anything tooling enforces. Under 400 words."

**Spec**: path or fetched contents of spec + Spec tags/examples pasted in full. Brief: "Report `missing:`/`creep:`/`wrong:` findings, one per line in the pinned format, each citing a spec line. Under 400 words." Spec missing → skip this sub-agent, note in final report.

**Lean**: full step-5 section pasted (tags, examples, scoring, guardrails). Brief: "Report only unnecessary complexity, one finding per line in the pinned format. End with net-lines score. Nothing to cut → `Lean already. Ship.`"

### 7. Aggregate

Reports under `## Risk`, `## Standards`, `## Spec`, `## Lean` — verbatim or lightly cleaned. Findings not in the pinned format → fix the line, don't drop it. No merging, no reranking across axes. Same line flagged by two axes stays in both.

End with one-line summary: findings per axis (`[P1]`/`[P2]` counts), worst issue per axis, Lean net-lines score. No single winner across axes — that's the reranking the separation prevents.

Why separate: each axis can fail alone. Risk pass + wrong thing built → Spec fail. Spec pass + conventions broken → Standards fail. Correct + conventional + 3× bigger than needed → Lean fail. Clean, lean, conventional, on-spec + one unawaited write → Risk fail, and that one is the outage. Separate reports stop one axis masking another.
