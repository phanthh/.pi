# Web Search

Searches SearXNG using its JSON API. Returns deduplicated titles, URLs, snippets, and engine metadata. Upstream engine failures appear in tool output and the UI; no results with engine failures is an error, not a successful empty search. Legitimate empty results and answer-only responses remain successful.

## Configuration

Base URL precedence:

1. `~/.pi/agent/web-search.json`: `{ "searxngBaseUrl": "http://localhost:8888" }`
2. `SEARXNG_URL`
3. `http://localhost:8888`

Supports `max_results` (1–50), `categories`, `time_range`, and `page`. Requests time out after 15 seconds and respect cancellation. Filter and pagination support depends on the selected upstream engines.

The local Docker deployment uses `~/docker-compose.yml` and `~/.searxng/settings.yml`, mounted read-only over the original container-owned settings. The active config inherits current SearXNG engine definitions rather than freezing an old full engine list. Blocked engines are disabled; Google CSE, Bing, Seznam, and Mwmbl provide general web results. The original settings remain in `~/.searxng/core-config/`.

## Checks

From `~/.pi/agent/extensions`:

```sh
pnpm --filter pi-web-search test
pnpm --filter pi-web-search test:live
pnpm check
```

The live check requires the local SearXNG service and verifies official Python, Docker, and TypeScript domains. To diagnose an empty search, inspect `unresponsive_engines` in `/search?q=Python&format=json` and `docker compose logs searxng`. A healthy container does not guarantee that upstream search engines are accessible.

After editing this extension, run `/reload` in existing Pi sessions.
