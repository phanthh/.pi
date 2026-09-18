# reload

Registers `reload_pi` only when Pi's cwd is `~/.pi` or one of its descendants.

```ts
reload_pi({})
```

Tool reloads Pi extensions, skills, prompts, themes, and context files in current session as soon as the current response finishes. Pi rejects reloads while a tool response is still streaming, so the tool waits for idle before invoking reload. After the new runtime starts, a hidden continuation message immediately starts another agent turn so work resumes without waiting for user input. Reload can reset extension in-memory state, timers, and watchers.

Outside `~/.pi`, tool is not registered.

Tool-context reload compatibility is adapted from [`clankercode/pi-reload-self`](https://github.com/clankercode/pi-reload-self) (MIT).
