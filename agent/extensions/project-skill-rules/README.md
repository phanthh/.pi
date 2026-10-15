# Project skill rules

Explicit skill allowlists selected by working directory. A matching rule allows only the listed skills (by frontmatter `name`; Pi has no skill `title` field), including global `~/.pi/agent/skills/` ones. There is no blocklist and no implicit exemption.

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

Extension removes disallowed skills from model's system prompt, hides them from slash-command autocomplete, and blocks explicit `/skill:name` expansion. Invalid config fails closed: all skills blocked. Autocomplete re-reads config for each suggestion request. Core discovery still includes all skills; filtering applies to their presentation and invocation.
