# context

Monolithic context management extension: context usage/injection visualization, deterministic compaction, recall, full observational memory (OM), topic cutovers, and idle-aware compaction.

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

Usage/injection views passively capture initial context and add no model-context instructions. Before the first real turn, opening a view may run one silent empty-message probe. Pi exposes no extension contribution API for built-in `/settings`, so OM uses `/context settings`.

## Recall

`recall` and `/recall` search active-lineage transcript history by default; use `scope:all` for other branches. Results automatically include observations and reflections sourced from displayed transcript entries, including dropped-observation markers. A 12-character bracketed or bare memory ID resolves an observation/reflection directly and returns its supporting source entries.

## `new_topic`

`new_topic` is always active. It ends current run; the `agent_end` hook compacts with `keep:1`, then invisibly resumes without duplicating latest user message. No internal slash command is exposed:

```text
new_topic → turn ends → compact keep:1 → invisible continue
```

Use only for sharp topic cutovers, never follow-ups or subtasks. `/recall` still reaches compacted history.

## Idle-aware compaction

A user message sent after the provider prompt cache expired (5 min since last assistant response or `cache_warm` refresh) pays a full cache miss anyway, so the `input` hook compacts first (deterministic marker compaction, default smart keep), then the message is sent on the smaller context:

```text
input (user, agent idle, ≥5m since cache touch)
  └─ enough live context? (non-system tokens > compaction.keepRecentTokens, pi's own gate)
       ├─ no  → send unchanged
       └─ yes → ctx.compact(marker) → await → send
```

Extension-sent messages and steering/follow-ups during a run are skipped. Compaction failure or Esc still sends the message.

## Checks

```sh
pnpm --filter pi-context selftest
pnpm check
```
