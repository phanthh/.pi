# Project skill rules

Project-skill allowlists selected by working directory. Skills under global `~/.pi/agent/skills/` are always available; rules filter every other discovered skill by its frontmatter `name` (Pi has no skill `title` field).

Configure `~/.pi/agent/project-skill-rules.json`:

```json
{
  "rules": [
    { "path": ["~/dev/app-one", "~/dev/app-two"], "skills": ["code-review", "grill"] },
    { "path": "^~/dev/mml", "regex": true, "skills": [] },
    { "path": "*", "skills": ["*"] }
  ]
}
```

`path` accepts one string or an array of strings. Literal paths cover all descendant directories; longest match wins. Set `regex: true` to interpret every `path` value as a regular expression against the absolute working directory. A leading `~` (also after `^`) expands to the home directory. Literal matches take precedence over regex matches; the first matching regex wins. `path: "*"` is the fallback for literal rules.

Empty skill list disables all non-global skills; `"*"` allows all. No matching rule leaves skills unrestricted. Config is read on every prompt, so edits need no reload.

Extension removes disallowed non-global skills from model's system prompt and blocks explicit `/skill:name` expansion. Global skills remain available even when config is invalid and fail-closed. Pi extensions cannot filter core skill discovery, so disallowed skills may still appear in slash-command autocomplete. They cannot be invoked through Pi's skill mechanism.
