# Anthropic auth

Internal Pi extension overriding the built-in `anthropic` provider with Claude Pro/Max OAuth, current Claude model definitions, request conversion, quota-aware fallback routing, prompt-cache controls, and streaming support.

## Login

Reload Pi, then run:

```text
/login anthropic
```

## State

Config defaults to `~/.pi/agent/anthropic-auth.json`. Override it with `PI_ANTHROPIC_AUTH_FILE`; `PI_AGENT_DIR` changes the default agent directory.

Runtime state uses `anthropic-auth-state.json`; sticky routing uses `anthropic-auth-routing-state.json`. Existing state from the packaged extension remains compatible.

## Commands

```text
/claude-cache [on|off|mode explicit|mode automatic|mode hybrid]
/claude-cachekeep [always|HH-HH|off]
/claude-prime
/claude-dump [on|off]
/claude-fast [on|off]
/claude-routing [main-first|fallback-first|sticky-balanced|reset]
/claude-account [reset-backoff|...]
/claude-logging [level]
/claude-quota
```

## Development

```bash
pnpm check
pnpm test:anthropic-auth
```

Source loads directly from `src/index.ts`; no build step.
