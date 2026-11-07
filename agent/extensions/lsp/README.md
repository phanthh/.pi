# LSP

Session-scoped language-server clients for TypeScript/JavaScript, Python, Go, and Rust.
Servers start on the first `lsp` call for each `(server, root)` pair.

## Explicit project roots

Every operation requires `root`, an absolute or cwd-relative project directory. Choose the
directory with `pyproject.toml`, `tsconfig.json`, `go.mod`, or `Cargo.toml`. For a git worktree,
pass that worktree's project directory. There is no automatic root detection.

```json
{
  "operation": "diagnostics",
  "filePath": "/var/tmp/worktree/evals/example.py",
  "root": "/var/tmp/worktree/backend"
}
```

Files outside `root` are allowed. They use the selected root's server, configuration, and Python
interpreter. A server can still limit workspace-wide references, imports, or rename edits for
outside-root files; the client does not fabricate results. Paths in results remain relative to
pi's cwd, including `../` paths. `filePath` and `renameFile.newPath` are cwd-relative, not root-relative.
Rename edits apply to all paths returned by the server, including paths outside the root.

## Disk changes

Each running client recursively watches its root with one `fs.watch` per directory. Asynchronous
traversal yields every 100 entries and skips heavy trees before allocating watchers. New directories
are attached; removed directories are detached. Symlink directories are not traversed. Each client
is limited to 5,000 watchers. Events are batched with a bounded delay of about 200 ms, then sent as
`workspace/didChangeWatchedFiles`. Dynamic registrations filter events by glob and event kind,
including relative glob patterns. Directory and dot-path events are conservatively over-notified
because directory changes affect descendants and Node glob matching excludes dot segments.
Without a registration, all non-ignored events are sent.

Open documents are read from disk and synchronized with `didChange`. Content, dependency, or
configuration changes invalidate cached diagnostics. Open outside-root files get parent-directory
watchers so atomic file replacement remains visible. Explicitly opened files inside ignored trees
also receive a parent-directory watcher.

Events from `node_modules`, `.git`, `dist`, `build`, `__pycache__`, `.next`, `.turbo`, `target`,
`.mypy_cache`, `.pytest_cache`, and `.venv`/`venv` internals are ignored, unless the affected file
is explicitly open. Creation or deletion of the venv directory itself is not ignored.
An `ENOSPC`, `EACCES`, watcher-cap limit, or other watcher failure produces one warning in the next
result for that client; pi continues, and explicit calls still synchronize the requested file.
Watchers close when their client exits, restarts, or the session shuts down.

Verified runtime: Node v24.22.2 (`node:path.matchesGlob` for filters). Native recursive watching
works on Linux, but this client uses explicit traversal so allocation errors for newly created
directories are caught locally instead of escaping Node's internal recursive-watch callback.

## Python environments

Pyright resolves `<root>/.venv/bin/python`, then `<root>/venv/bin/python`, then a computed Poetry
environment. It does not search child projects: for `backend/.venv`, pass `backend` as `root`.
An explicit `initialization.python.pythonPath` takes precedence. If no environment exists,
results include a warning. Each call re-resolves the interpreter; a changed path, such as after
`uv sync`, clears the failed-start cache and restarts the client. Previously open documents are
reopened. Replacing an interpreter at the same path does not trigger a restart.

## Configuration

Merge `~/.pi/agent/lsp.json` with `<root>/.pi/lsp.json` (project wins):

```json
{
  "pyright": {
    "initialization": {
      "python": { "pythonPath": "/path/to/venv/bin/python" }
    }
  },
  "custom": {
    "command": ["custom-language-server", "--stdio"],
    "extensions": [".custom"]
  }
}
```

Server entries support `command`, `extensions`, `disabled`, `env`, `initialization`, and `hint`.
Legacy `roots` marker lists no longer select a root. A missing diagnostics report is reported as
unknown, not as proof of a clean file.
