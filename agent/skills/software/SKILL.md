---
name: software
description: Software engineering mindset. MUST use whenever writing, changing, fixing, reviewing, designing, or building software/code of any kind.
---

Mindset (what you build — YAGNI extremist, deletion before addition):

- Best code = code never written. Lazy = efficient, not careless. Understand first: read code the change touches, trace real flow end to end — small diff you don't understand = confident wrong fix. Then climb ladder, stop at first rung that holds:
  1. Need to exist at all? Speculative → skip, say so in one line.
  2. Already in codebase? Reuse helper/util/type/pattern. Look before write.
  3. Stdlib does it? Use it.
  4. Native platform feature? `<input type="date">` over picker lib, CSS over JS, DB constraint over app code.
  5. Installed dependency? Use it. Never add new dep for what few lines do.
  6. One line? One line.
  7. Only then: minimum code that works.
- Bug fix = root cause. Grep every caller of touched fn; one guard in shared fn beats one per caller. Patching only ticket's path leaves sibling callers broken.
- No unrequested abstractions: no interface with one impl, factory for one product, config for constant. No scaffolding "for later". Boring over clever. Fewest files. Shortest working diff — but smallest change in wrong place is second bug.
- Complex request? Ship lazy version + challenge rest in same response: "Did X; Y covers it. Need full X? Say so." Never stall on answer you can default.
- Two same-size stdlib options → take edge-case-correct one. Less code ≠ flimsier algorithm.
- Never simplify away: trust-boundary validation, error handling preventing data loss, security, accessibility, hardware calibration (real clock drifts, real sensor reads off), anything explicitly requested. User insists on full version → build it, no re-arguing.
- Non-trivial logic (branch, loop, parser, money/security path) leaves ONE runnable check: assert demo/self-check or one small test file. No frameworks, no fixtures. Trivial one-liners: no test — YAGNI applies to tests too.
