---
name: improve-area
description: Survey a codebase area for evidence-backed improvements (deepen modules, dead code, duplicates, cruft), let the user pick, then apply the picked one behavior-preserving. Use when asked to improve, clean up, refactor, simplify, or pay down tech debt in a codebase or area.
---

# Improve area

Goal: area gets smaller, deeper, or truer. Behavior unchanged. Diff size and deleted
lines = evidence, not goals. "Nothing worth doing" = valid outcome.

## 1. Scope (read-only)

- User named area/pain → take it. Else mine hotspots:
  `git log --since=6.months --name-only --format= | sort | uniq -c | sort -rn | head -30`.
  Recent churn weighs most: improvement pays off where code keeps changing.
- One sentence: what gets better + non-goals. Feature/bug-fix work = out of scope.
- Read repo AGENTS.md, ADRs/glossary/docs for area. Do not re-litigate recorded decisions.
- Baseline: find typecheck/lint/test cmds for area, run (long → `tmux`). Red baseline →
  report, stop.

## 2. Scan (read-only)

Fan out `scout` subagents, one per lens below, same scope. Small area → do it yourself.
Each candidate returns: files/symbols, problem, evidence, proposed change.

- **Deepen**: shallow modules (interface ≈ implementation), concept spread across many tiny
  files, leaky seams, logic extracted only for tests. Deletion test: would deleting module
  concentrate complexity (good candidate) or just move it (skip)?
- **Dead code**: unused exports/files/deps/branches/flags. Tools (knip, ts-prune, vulture,
  `rg`) = clues, not proof. Treat as live until disproven: entry points, package
  `exports/main/bin`, framework conventions, dynamic imports, string-keyed lookups, reflection.
- **Duplicates**: same intent, different code. Hot spots: utils, validation, error formatting,
  path/string/date handling, response shaping. Merge only twins with same owner + contract.
- **Cruft**: AI slop, stale/in-progress comments, deprecated paths with no live user,
  defensive guards/catches not at a real input or failure boundary.

## 3. Rank

Read cited code yourself; never rank on scout summary alone. Keep candidate only if:

- ≥2 independent signals (tool + code read, search + test run, ...);
- callers, dynamic refs, external consumers checked (record zero-hit searches);
- change local, does not ripple across unrelated boundaries.

Tag each: strength `Strong | Worth exploring | Speculative`; risk `safe | careful | risky`
(risky = public API, schema, live infra, ambiguous dynamic use). Cap at 5. Drop speculative
items unless nothing else.

## 4. Gate (STOP)

Write `/tmp/improve-<area>-<timestamp>.md`: scope + baseline; per candidate files, problem,
change, evidence, strength, risk, before→after ASCII tree when structure changes; top
pick + why; low-confidence findings not acted on. Chat: path + terse table. Ask which to do.
No repo edits before pick.

## 5. Apply (picked candidate only)

- Dirty tree or parallel work → own worktree in `/var/tmp`.
- Weak test coverage on touched behavior → add characterization check first (see `software`).
- Mechanical, repeated edit → script/codemod (`ast-grep`, `sed`), not hand edits.
- Small steps; targeted checks after each. Break → fix or revert that step; can't prove safe →
  demote to report, don't push through.
- Never mix in features, fixes, or other candidates. Noticed → add to report.

## 6. Verify

- Completeness: `rg` retired names/paths → nothing, or a pointer to replacement. Update docs,
  comments, config, scripts, READMEs made false.
- Full baseline cmds again; compare with step 1.
- Non-trivial diff → `reviewer` subagent: behavior preserved? scope creep? leftovers?
- Report: what changed + why, checks run (and skipped), residual risk, next candidates.
  No commit/push/PR unless asked; then hand off to `full-pr`/`full-land`.
