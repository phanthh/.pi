# Project skill rules

Global allowlists for Pi skills, selected by working directory. Rules apply equally to global and project skills because matching uses each skill's frontmatter `name` (Pi has no skill `title` field).

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

Empty skill list disables all skills; `"*"` allows all. No matching rule leaves skills unrestricted. Config is read on every prompt, so edits need no reload.

Extension removes disallowed skills from model's system prompt and blocks explicit `/skill:name` expansion. Pi extensions cannot filter core skill discovery, so disallowed skills may still appear in slash-command autocomplete. They cannot be invoked through Pi's skill mechanism.
