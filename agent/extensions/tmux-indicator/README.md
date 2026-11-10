# tmux-indicator

Colors the tmux tab (`window-status-style`) of the window that pi runs in, by agent state.
No-op outside tmux (`$TMUX` / `$TMUX_PANE` unset).

| State | When | Default |
|---|---|---|
| `waiting` | blocking UI prompt open (`ask`, confirm, select, ...) | `bg=#bb9af7` |
| `error` | last run ended with `stopReason: "error"`; held until next run | `bg=#f7768e` |
| `running` | agent run, auto-retry backoff, compaction, or idle with live `tmux` tool runs / `tmux_subagent` children | `bg=#e0af68` |
| `idle` | session start, run settled, run aborted (Esc) | `bg=#9ece6a` |

All defaults use `fg=#1a1b26`.

## Behavior

- Each pi sets its state on its own pane: `@pi_indicator` (`<state>` or `<state> dim`).
- After each change, pi reads `@pi_indicator` from all panes of its window and sets the window
  `window-status-style`. Order: `waiting` > `error` > `running` > `idle`. Tie: lowest pane index.
- Subagent children that are not leads (`PI_SUBAGENT_ID` set, `PI_SUBAGENT_LEAD` not set) add the
  `dim` attribute. The top-level pi (depth 0) and lead children do not.
- Background work: `tmux` and `tmux-subagents` register live counts in a shared registry
  (`@pi-ext/tmux-windows/activity`). pi polls it every 1s. Idle with count > 0 → `running`.
  `error` and `waiting` are not overridden.
- `window-status-current-style` is not changed. The focused tab keeps its normal style.
- Quit: pi unsets its pane option and recomputes the window. No pi panes left: window option unset
  (global style applies). `/reload`, new, resume, fork: state is applied again on `session_start`.

## Config

Optional `~/.pi/agent/tmux-indicator.json`. Partial overrides merge with defaults:

```json
{ "running": { "bg": "#ff9e64" }, "idle": { "bg": "default", "fg": "#9ece6a" } }
```
