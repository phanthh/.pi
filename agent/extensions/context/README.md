# context

Monolithic context management extension: context usage/injection visualization, deterministic compaction, recall, full observational memory (OM), idle-aware compaction, and optional agent-editable live context.

All implementation lives in this package. Compaction internals are under `src/compact/`; no separate compact package or extension is loaded.

## Architecture

```text
agent_start / turn_end
  └─ single background pipeline
       Observer  → om.observations.recorded
       Reflector → om.reflections.recorded
       Dropper   → om.observations.dropped tombstones

session_before_compact
  └─ deterministic compact summary
       └─ bounded active observations + reflections
```

OM behavior:

- **Observer:** oldest-first contiguous transcript chunks; strict cited-source validation; deterministic content IDs; timestamp from latest cited source; exact dedupe.
- **Reflector:** distills scarce durable facts from uncovered observations. Every support ID must be valid or proposal is rejected. Uncovered observations remain eligible on later passes; support becomes Dropper coverage evidence.
- **Dropper:** defaults to keep. Every active observation remains eligible on later passes. LLM proposes candidate IDs; deterministic fullness gate, hard drop limit, then coverage → relevance → age ranking chooses removals.
- **Ledger:** append-only custom entries, including empty successful stage progress. Drops are tombstones; original observations and transcript remain recallable.
- **Projection:** active observations ranked by relevance and recency; newest reflections retained first. Independent hard token budgets. Previous injected block is stripped before replacement.
- **Isolation:** workers use separate provider completions with fixed system prompts and hard estimated input budgets. Main session prompt/tools remain unchanged; memory enters only during compaction.
- **Lifecycle:** one pipeline runs at a time. Session switch, tree navigation, config reload, and shutdown abort work; selected-branch ledger state is restored and stale results are discarded. Stage model failures fall through configured candidates; a failed stage stops later stages for that run.

Each stage uses one strict-JSON completion, preserving stage semantics and validation while bounding requests and output.

## Config

Global `~/.pi/agent/om.json`, shallow-merged with trusted project `.pi/om.json`:

```json
{
  "liveContext": { "mode": "off" },
  "model": null,
  "observerModel": null,
  "reflectorModel": null,
  "dropperModel": null,
  "observerFallbackModels": [],
  "reflectorFallbackModels": [],
  "dropperFallbackModels": [],
  "sessionFallback": true,
  "observeAfterTokens": 15000,
  "reflectAfterTokens": 25000,
  "chunkMaxTokens": 40000,
  "observationsPoolMaxTokens": 20000,
  "reflectionsPoolMaxTokens": 8000,
  "reflectorInputMaxTokens": 80000,
  "dropperInputMaxTokens": 80000,
  "dropperPressureThreshold": 0.7,
  "dropperPoolFullnessThreshold": 0.1,
  "maxOutputTokens": 2000
}
```

Model resolution per stage:

```text
stage model → stage fallback models → shared model → session model (when enabled)
```

OM is always on while the `context` extension is loaded. Use cheap dedicated models and set `sessionFallback: false` for predictable cost. Unknown/invalid fields are ignored; numeric values are clamped. Legacy `memoryMaxTokens` remains accepted as an alias for `observationsPoolMaxTokens`; legacy `enabled` is ignored.

## Compaction token cap

Set `compaction.overrideMaxTokens` in Pi's merged `settings.json` to cap every model's effective context window for automatic compaction and `/context usage`:

```json
{
  "compaction": {
    "enabled": true,
    "overrideMaxTokens": 250000
  }
}
```

The effective window is `min(model.contextWindow, overrideMaxTokens)`, so the setting never claims capacity a smaller model does not have. The extension applies that window to Pi's native context accounting, auto-compaction, summary budgets, and footer. Compaction starts after usage exceeds the effective window minus `compaction.reserveTokens`. Footer context displays the cap first and provider-advertised window in parentheses, for example `50.0%/250k (1.0M) (auto)`. Omit the setting to use Pi's model-specific window unchanged.

## `/context`

- `/context` or `/context usage` — interactive context-window usage map plus Observer, Reflector, Dropper, observation-pool, and Reflector-load gauges; ledger totals and active errors appear in the same dashboard. Stage gauges share the pipeline's trigger gates: a stage that cannot run shows why (e.g. `no unreflected observations`, `pool < 10% full`) instead of a percentage. Refl Load ≥100% also triggers the Dropper (pressure).
- `/context injections` — inspect initial system prompt, tools, context files, skills, and extension additions.
- `/context settings` — common OM thresholds and budgets; writes global `om.json`.
- `/context reload` — reload global + trusted project OM config.
- `/context config` — create context-view color overrides at `~/.pi/agent/extensions/context-view.json`.

Usage/injection views count only skill records present in the rendered prompt, even when later extension hooks filter the startup skill list. They passively capture initial context and add no model-context instructions. Before the first real turn, opening a view may run one silent empty-message probe. Pi exposes no extension contribution API for built-in `/settings`, so OM uses `/context settings`.

## Recall

`recall` and `/recall` search active-lineage transcript history by default; use `scope:all` for other branches. Results automatically include observations and reflections sourced from displayed transcript entries, including dropped-observation markers. A 12-character bracketed or bare memory ID resolves an observation/reflection directly and returns its supporting source entries.

## Idle-aware compaction

A user message sent after the provider prompt cache expired (5 min since last assistant response or `cache_warm` refresh) pays a full cache miss anyway, so the `input` hook compacts first (deterministic marker compaction, default smart keep), then the message is sent on the smaller context. Eligibility uses projected messages, including accepted live edits. With an active live checkpoint, idle compaction summarizes the entire projected window and retains no raw tail; this prevents removed text from reappearing when the checkpoint resets.

```text
input (user, agent idle, ≥5m since cache touch)
  └─ enough live context? (non-system tokens > compaction.keepRecentTokens, pi's own gate)
       ├─ no  → send unchanged
       └─ yes → ctx.compact(marker) → await → send
```

Extension-sent messages and steering/follow-ups during a run are skipped. Compaction failure or Esc still sends the message.

## Agent-editable live context

Disabled by default. Enable the current branch with `/context live on`; use `/context live off` to stop mirroring, `/context live status` to report status, and `/context live revisions` to inspect branch-local diffs. The branch-local override persists through resume and is inherited by forks/clones. Disabling does not undo accepted edits. Navigate with `/tree` to inspect history before an edit.

The existing `/context settings` screen offers global modes `off`, `main` (exclude subagents), and `all`. The same setting can be written to global or trusted-project `om.json`:

```json
{ "liveContext": { "mode": "main" } }
```

`/context reload` refreshes both OM and live-context configuration. The existing `/context` usage dashboard shows live-context state, path, edit count, and last result/error. `/context live revisions` writes a readable history of accepted before/after changes to `revisions.md` for inspection; no separate viewer modal.

```text
<actual-session-file>.jsonl.context/
├── live.md       editable projection of the active branch
├── writer.lock   one extension runtime owns the mirror
├── revisions.md  generated diff history (/context live revisions)
└── rejected.md   most recent rejected or interrupted draft, if any
```

The sidecar follows the actual session file, including custom session directories; it does not depend on a mutable display name. Files are local, private (`0600`, directory `0700`), and may contain sensitive transcript text. Accepted edits are append-only branch-local `context.live.checkpoint` custom entries in JSONL; the sidecar is not needed to replay them. `/context live revisions` writes branch-local diffs to `revisions.md` in the sidecar. Removing a JSONL session does not automatically remove its sidecar; remove that directory too when cleaning up sessions. If Pi exits without releasing its lock, verify its process has exited before removing `writer.lock`.

```text
before request → projected active history → live.md
agent          → ordinary file tools reshape mirrored blocks
turn_end       → validate entire draft after all tools finish
                 ├─ accept → branch-local checkpoint + receipt
                 └─ reject → no edits, retain draft, report reason
next request   → extension projects checkpoint + new raw suffix
```

The agent receives the mirror path, last status, and a pointer to [`live_context/SKILL.md`](../../skills/live_context/SKILL.md) in a `<live_context>` block, shown under **System Prompt → Live Context** in the main `/context` view and counted once in the system-prompt token estimate, and bounded pressure reminders (70%/85% of effective input budget, re-armed below 60%). No separate summarizer or extra model turn is started. Native compaction, including OM enrichment, remains the fallback when effective history exceeds budget or provider overflow occurs; it resets the overlay. A routed physical model's window/reserve and the existing context-window cap are honored; token checks are estimates, not exact provider-tokenizer guarantees.

### Editing instructions

Read [`~/.pi/agent/skills/live_context/SKILL.md`](../../skills/live_context/SKILL.md) before interacting with the mirror. It contains the complete format, authority, lifecycle, inspection, editing, and surgical-compaction instructions. Document headers and pressure reminders reference the same skill. Its declared skill name is `live-context` (Pi skill names use hyphens, not underscores).

Stale baselines, invalid structure, duplicate IDs, and over-budget drafts reject the whole edit. Interrupted turns never import unfinished writes. Tree navigation, session replacement, and reload discard pending drafts and rebuild from canonical branch state. A second writer is warned and cannot share the mirror.

Deletion is **context-window optimization**, not secure erasure or semantic forgetting. Recall and OM still read archived history; saved observations/reflections may reappear during enriched compaction. Raw history, exports, and native usage accounting remain intact. Checkpoint projection is request-local. While it fits the effective budget, threshold compaction is cancelled because Pi's native compactor reads raw history. Idle compaction uses the projected window and resets the checkpoint without retaining raw history; manual compaction, overflow recovery, or an over-budget checkpoint may still use native compaction and restore retained raw history. Do not rely on live editing for secure removal.

## Checks

```sh
pnpm --filter pi-context selftest
pnpm check
```
