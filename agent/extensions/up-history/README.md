# Up history

Seeds Pi's native Up/Down editor history with the latest 30 unique, non-empty saved user prompts for the current working directory. Newest prompt is recalled first; existing editor text is unchanged.

```text
session_start (TUI only)
  → wrap existing editor factory (or use CustomEditor)
  → asynchronously scan sessionManager.getSessionDir() JSONL files
  → filter session header cwd, extract user text, order and deduplicate
  → addToHistory oldest-first
session_shutdown / next session_start
  → invalidate pending load
```

Uses Pi's actual session directory, including custom/shared directories. Only sessions whose header cwd resolves to the current cwd are included. Text blocks are joined with newlines; images and empty prompts are ignored. All saved branches are eligible, not only the active conversation branch.

Prompts are ordered by finite numeric message timestamp, then entry timestamp, falling back to file mtime. Equal timestamps use file mtime, filename, and line order as deterministic newest-first tie-breakers. Every JSONL file is scanned: recent file modification does not imply recent prompts. Loading streams files, keeps at most 30 candidates, and yields periodically to keep the TUI responsive. Invalid headers, malformed entries/JSON lines, and unreadable files are skipped.

Wraps the editor factory already installed when this extension's `session_start` handler runs. Custom editors without `addToHistory` remain unchanged. If another extension replaces the factory before loading finishes, the pending result is discarded—even if the replacement wraps this factory. Install custom editors before this extension to ensure startup seeding. A later non-wrapping replacement also loses seeded history. No settings, keybindings, commands, popups, or separate history file are created. RPC, JSON, and print modes do not load or mutate editor history. Pending results are discarded after shutdown, session changes, or factory replacement.

## Checks

From `~/.pi/agent/extensions`:

```sh
pnpm --filter @pi-ext/up-history test
pnpm check
```

Tests use Node's `--experimental-strip-types`, built-in assertions, temporary session files, and Pi's real native editor. No test framework or new dependencies.

Behavior was informed by [pi-up-history](https://github.com/richardgill/pi-extensions/tree/main/extensions/pi-up-history). This is an independent implementation; the upstream checkout had no license, so no source or comments were copied.
