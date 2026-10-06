---
name: agent-browser
description: Browser automation and UI testing via agent-browser MCP tools in codemode scripts. MUST read before opening, testing, scraping, screenshotting, or interacting with any web page or web UI.
---

# agent-browser (MCP via codemode)

MCP server `agent-browser` (config: `~/.pi/agent/mcp.json`, profile `all`). Tools are not declared to you; call them from `codemode` scripts as `tools.mcp__agent_browser__agent_browser_<cmd>`.
CLI (`agent-browser ...`) drives the same daemon; use it for one-offs or flags without typed fields.
## Discover

- Workflow guide (version-matched): `agent-browser skills get core` (add `--full` for command reference).
- Tool lookup: `searchTools("click", { namespace: "agent-browser" })`, then `describeTool(name)` for the typed args.
- Every tool accepts `session`, `allowedDomains`, `timeoutMs`, `extraArgs` (raw CLI flags for anything untyped).

## Rules

- Always pass `session: "<task-name>"`, unique per subagent → isolated browser. Same name reachable via CLI `--session`.
- Keep the loop inside one script: open → snapshot → act on `@eN` refs → re-snapshot after page changes. Refs die on navigation.
- Snapshots get big (GitHub repo page ≈ 800 lines even with `interactive: true`). Narrow with `selector`, `compact`, `depth`, `delta`; filter text in-script; return only what's needed.
- Results are MCP `CallToolResult`: text in `res.content.find(c => c.type === "text").text`, check `res.isError`, full data in `res.structuredContent`.
- Close the session (`agent_browser_close`) when done.

## Example

```js
const ab = (cmd, args = {}) => tools[`mcp__agent_browser__agent_browser_${cmd}`]({ session: "demo", ...args });
const txt = (r) => r.content.find((c) => c.type === "text")?.text ?? "";

await ab("open", { url: "https://example.com" });
const snap = txt(await ab("snapshot", { interactive: true, compact: true }));
const ref = snap.match(/link "Learn more" \[ref=(e\d+)\]/)?.[1];
if (ref) await ab("click", { selector: `@${ref}` });
await ab("wait_for_load", { state: "load" });
const shot = await ab("screenshot");
image(shot.content.find((c) => c.type === "image"));
const url = txt(await ab("get_url"));
await ab("close");
return url;
```

## Extras
- Persist login: `restore: true` (keyed by session), or CLI `--profile`, `auth save/login`.
- Existing Chrome/Electron: `agent_browser_connect` / CLI `--cdp <port>`, `--auto-connect`.
