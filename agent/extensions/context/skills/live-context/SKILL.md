---
name: live-context
description: Inspect, edit, or compact active conversation through its live-context mirror. MUST read before interacting with the mirror, responding to live-context pressure, or planning context reduction.
---

# Live context

The `<live_context>` system-prompt block names the current mirror file and its last status. This skill is the source of truth for interacting with that file, including the instructions referenced by its document header.

## Scope and lifecycle

- You may edit that specific mirror with ordinary file tools (`edit`, `bash`, scripts, etc.) to alter the active conversation context, even when it is outside the working directory. This permission does not extend to other session files.
- Do not read or print the whole mirror: its conversation is already in context. Locate targets with short unique text or inspect current headers selectively. Scripts may read the file locally without emitting all its bodies.
- Edits apply immediately after the completed tool batch at `turn_end`, before the next model request. They do not change the already-running request. Text appended after export is retained automatically.
- Make one batched mirror write per turn. This is an atomicity rule, not a request for one global summary: use multiple disjoint replacements/removals in one `edit` call or one script write. Read-only inspection does not count.
- Valid edits must fit the effective input budget, including the receipt.
- Confirm acceptance through the next `[Live context: applied ...]` receipt or `Last status` in `<live_context>`. Rejection leaves context unchanged and saves the draft to `rejected.md`; use the reported reason, not an assumption that the write succeeded.
- Interrupted turns never apply edits. New requests, branch changes, reload, and session shutdown discard pending drafts and refresh from canonical state.

## Document format and authority

Every revision has a delimiter such as `<<<CTX:0123456789abcdef01234567:0>>>`. Use the exact delimiter and IDs from the current document, never examples or stale revisions.

```text
<delimiter> document {"sessionId":"...","leafId":"...","revision":"..."}
<skill reference line>
<delimiter> entry "<source-id>/0" role "assistant"
message body
<delimiter> end entry "<source-id>/0"
<delimiter> end document
```

- Keep the full document header (metadata and skill reference), document footer, and delimiter unchanged. Preserve existing IDs and matching end-entry IDs. Keep retained entry headers unchanged unless intentionally changing the role label. Do not put the delimiter inside a body.
- Edit bodies, reorder or remove complete entries, or add entries with unique IDs matching `new-[\w.-]+` (for example `new-findings`) and matching end-entry IDs. Role labels may change; they must be nonempty, single-line strings. IDs and roles in headers are JSON strings.
- Unchanged entries retain original structured data out of band, including images, signatures, and tool calls. Mirror bodies omit opaque signatures/auxiliary metadata and display binary data as placeholders. Do not reconstruct those objects from the displayed text.
- Changed or new entries become ordinary **user-role text** with a `[Context mirror role: "..."]` label. Changing a label cannot create authoritative system, assistant, or tool messages. Broken tool-call/result groups are flattened to user text rather than replayed as invalid tool traffic; preserve complete groups when their structured behavior matters.
- Every mirrored entry is editable, including the newest user request, summaries, shell output, and extension messages. There are no protected turns. Actual system messages remain outside the mirror and cannot be edited here.
- A headerless rewrite becomes one user note; an empty or whitespace-only rewrite removes all mirrored entries. A header/footer-only document also removes all mirrored entries. These are destructive alternatives, not the default compaction method.
- Invalid structure, stale baselines, duplicate IDs, or over-budget drafts reject the entire edit.

## Surgical compaction

Compact only when a meaningful batch will improve future work: high context pressure, large stale tool outputs, or superseded exploration. Do not compact after every turn.

1. Preserve message order and conversational structure by default. Leave unrelated blocks and existing good summaries unchanged; shorten stale bodies in place and remove only clearly obsolete or redundant entries.
2. Preserve complete conversational units. A relevant user request normally retains its corresponding assistant reasoning/results or a faithful, specific local summary in the same position. Do not retain only user messages while deleting all assistant-side findings.
3. Interpret retention precisely: “keep/preserve these messages” means exact user **and** assistant messages unless narrowed; “preserve findings/analysis” allows a faithful semantic summary. Ask when boundaries or exactness are genuinely ambiguous.
4. Global consolidation requires an explicit user request for deep/aggressive compression. Pressure alone does not authorize flattening every episode.
5. A compaction must lower the complete Pi-estimated token count. The runtime enforces budget, not strict reduction; use the receipt's before/after estimates to verify reduction. Remove large tool output and superseded exploration before useful dialogue.
6. Preserve decisions, constraints, unresolved questions, paths, commands still needed, test results, provenance explaining conclusions, and the next action.

```text
before: user A → assistant investigation A → tool output → user B → assistant result B
after:  user A → concise assistant A                    → user B → concise assistant B
avoid:  user A → one global summary of everything       → user B
```

An edit changes the request prefix: provider cache tokens from the edit point onward must be recomputed. Batch useful reductions rather than making many small edits; compact stale early history before a long useful tail accumulates. Summaries should be detailed enough to avoid repeated investigation, not compressed into vague conclusions.

## Bounded inspection and one-write editing

First inspect only current document/entry boundaries. Match the delimiter from the first line; broad header searches can match examples inside old tool output.

```bash
LIVE_CTX="<mirror path from system prompt>" python3 - <<'PY'
import os, re
from pathlib import Path

s = Path(os.environ["LIVE_CTX"]).read_text()
first = s.splitlines()[0]
m = re.fullmatch(r'(<<<CTX:[a-f0-9]{24}:\d+>>>) document (.+)', first)
if not m:
    raise SystemExit("invalid live-context document header")
d = m.group(1)
print(first)
for line in s.splitlines()[1:]:
    if line.startswith(d + " entry ") or line.startswith(d + " end entry "):
        print(line)
PY
```

Then target exact current IDs without retyping old bodies. This script batches local replacements/removals and writes once; populate `replacements` and `removals` with IDs from the inspection. For exact short unique text, one `edit` call with disjoint replacements is also appropriate.

```bash
LIVE_CTX="<mirror path from system prompt>" python3 - <<'PY'
import json, os, re
from pathlib import Path

p = Path(os.environ["LIVE_CTX"])
s = p.read_text()
m = re.match(r'(<<<CTX:[a-f0-9]{24}:\d+>>>) document [^\n]+\n', s)
if not m:
    raise SystemExit("invalid live-context document header")
d = m.group(1)
replacements = {"<current entry ID>": "[summary: concrete findings, decisions, files, validation, next action]"}
removals = set()  # Exact IDs whose value is captured nearby.
if replacements.keys() & removals:
    raise SystemExit("overlapping targets")
for entry_id in replacements.keys() | removals:
    quoted = re.escape(json.dumps(entry_id, ensure_ascii=False))
    pattern = rf'(^{re.escape(d)} entry {quoted} role [^\n]+\n).*?(\n{re.escape(d)} end entry {quoted}\n)'
    def replace(match):
        if entry_id in removals:
            return ""
        body = replacements[entry_id]
        if d in body:
            raise SystemExit("delimiter inside replacement body")
        return match.group(1) + body + match.group(2)
    s, count = re.subn(pattern, replace, s, flags=re.M | re.S)
    if count != 1:
        raise SystemExit(f"expected one current entry: {entry_id}, found {count}")
p.write_text(s)
PY
```

Do not invent existing IDs or duplicate entries. Re-inspect after a refresh; never apply a script prepared for another revision.

## Durable continuity

Before removing a source that future work must revisit, preserve its exact text when required or retain a local summary with source provenance and a `recall` query/ID. Use the available `recall` tool for bounded archived-source lookup when needed.

A durable summary should let the next turn continue without the removed output:

```markdown
[summary]
Goal: ...
Constraints: ...
Findings/provenance: ...
Decisions: ...
Files and state: ...
Validation: command/result
Open questions: ...
Next action: ...
[/summary]
```

Live editing optimizes the context window; it is not secure erasure or semantic forgetting.
