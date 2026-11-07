# Web Search

Queries SearXNG JSON and DuckDuckGo HTML **in parallel** on every first-page search. Returns merged titles, URLs, snippets, source labels (`SearXNG`, `DuckDuckGo`, or both), and SearXNG engine metadata. DuckDuckGo uses the same `wreq-js` browser TLS approach as `web-fetch`, with `linkedom` for HTML parsing; article extraction is not needed.

Results are interleaved by source. Duplicates do not consume a source's turn. URL comparison ignores HTTP/HTTPS, `www.`, trailing slashes, fragments, and `utm_*` parameters; remaining query parameters are sorted. Original URLs remain in output. Sources are combined before `max_results` is applied.

If one backend fails, times out, or returns a bot challenge, results from the other remain successful with a short backend/reason note. SearXNG `unresponsive_engines` are also shown in output and UI. Empty SearXNG results with engine failures and no answers count as a failed backend. The tool reports an error only when every attempted backend fails; legitimate empty results and answer-only responses remain successful.

## Configuration

Base URL precedence:

1. `~/.pi/agent/web-search.json`: `{ "searxngBaseUrl": "http://localhost:8888" }`
2. `SEARXNG_URL`
3. `http://localhost:8888`

Supports `max_results` (1–50), `categories`, `time_range`, and `page`. Each backend request times out after 15 seconds and respects cancellation (queue waiting is separate).

- `categories` applies **only to SearXNG**. DuckDuckGo always searches the general web.
- `time_range`: SearXNG receives `day`/`month`/`year`; DuckDuckGo receives `df=d`/`m`/`y`.
- `page > 1` queries **SearXNG only**, with an explicit note. DuckDuckGo is skipped rather than replaying first-page results or guessing its continuation form parameters. A failed SearXNG request on these pages is an error.

### Rate limiting

Upstream engines (notably Google CSE) suspend SearXNG for 180 s after a burst, so parallel calls and parallel subagents used to exhaust them. Each SearXNG request reserves a global start slot in `$TMPDIR/pi-web-search.next` (guarded by the `pi-web-search.lock` directory lock). DuckDuckGo has independent `pi-web-search-ddg.next` / `pi-web-search-ddg.lock` files. Request starts are spaced by `minIntervalMs` **per backend** across all pi processes on the host, including the main session and every subagent. Calls reserve slots in lock-acquisition order; cancellation while queued aborts without sending a request.

- `~/.pi/agent/web-search.json`: `{ "minIntervalMs": 1500 }` (default 1500; `0` disables throttling)
- `PI_WEB_SEARCH_MIN_INTERVAL_MS` env overrides the config value. Filter and pagination support depends on the selected upstream engines.

The local Docker deployment uses `~/docker-compose.yml` and `~/.searxng/settings.yml`, mounted read-only over the original container-owned settings. The active config inherits current SearXNG engine definitions rather than freezing an old full engine list. Blocked engines are disabled; Google CSE, Bing, Seznam, Mwmbl, and `duckduckgo web` provide general web results. Plain `duckduckgo` stays disabled because it hits a CAPTCHA on this host. The original settings remain in `~/.searxng/core-config/`.

## Checks

From `~/.pi/agent/extensions`:

```sh
pnpm check
```

Manual live smoke (not a test suite): a temporary Node script queried `https://html.duckduckgo.com/html/?q=Python%20official%20documentation` with browser TLS and parsed 10 results (HTTP 200). A merged search returned six results with combined source labels and the SearXNG `google cse: too many requests` warning. DuckDuckGo can still block requests; challenge/unknown HTML is reported as a backend failure rather than a successful empty search.

To diagnose an empty search, inspect backend notes, SearXNG `unresponsive_engines` in `/search?q=Python&format=json`, and `docker compose logs searxng`. A healthy container does not guarantee that upstream search engines are accessible.

After editing this extension, run `/reload` in existing Pi sessions.
