# Web Search

Searches SearXNG using its JSON API. Returns deduplicated titles, URLs, snippets, and engine metadata. Upstream engine failures appear in tool output and the UI; no results with engine failures is an error, not a successful empty search. Legitimate empty results and answer-only responses remain successful.

## Configuration

Base URL precedence:

1. `~/.pi/agent/web-search.json`: `{ "searxngBaseUrl": "http://localhost:8888" }`
2. `SEARXNG_URL`
3. `http://localhost:8888`

Supports `max_results` (1–50), `categories`, `time_range`, and `page`. Requests time out after 15 seconds and respect cancellation.

### Rate limiting

Upstream engines (notably Google CSE) suspend SearXNG for 180 s after a burst, so parallel calls and parallel subagents used to exhaust them. Every request now reserves a global start slot in `$TMPDIR/pi-web-search.next` (guarded by the `pi-web-search.lock` directory lock). Request starts are therefore spaced by `minIntervalMs` across **all** pi processes on the host, including the main session and every subagent. Queued calls wait in FIFO order, and cancellation while queued aborts without sending a request.

- `~/.pi/agent/web-search.json`: `{ "minIntervalMs": 1500 }` (default 1500; `0` disables throttling)
- `PI_WEB_SEARCH_MIN_INTERVAL_MS` env overrides the config value (used by the selftest) Filter and pagination support depends on the selected upstream engines.

The local Docker deployment uses `~/docker-compose.yml` and `~/.searxng/settings.yml`, mounted read-only over the original container-owned settings. The active config inherits current SearXNG engine definitions rather than freezing an old full engine list. Blocked engines are disabled; Google CSE, Bing, Seznam, Mwmbl, and `duckduckgo web` provide general web results. Plain `duckduckgo` stays disabled because it hits a CAPTCHA on this host. The original settings remain in `~/.searxng/core-config/`.

## Checks

From `~/.pi/agent/extensions`:

```sh
pnpm --filter pi-web-search test
pnpm --filter pi-web-search test:live
pnpm check
```

The live check requires the local SearXNG service and verifies official Python, Docker, and TypeScript domains. To diagnose an empty search, inspect `unresponsive_engines` in `/search?q=Python&format=json` and `docker compose logs searxng`. A healthy container does not guarantee that upstream search engines are accessible.

After editing this extension, run `/reload` in existing Pi sessions.
