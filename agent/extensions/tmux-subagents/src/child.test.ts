import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childExtension, { pendingChildrenError } from "./child.ts";
import { buildChildToolAllowlist } from "./index.ts";
import { drainInbox, HOST, postMessage, type RoomMessage } from "./room.ts";
import { findLastAssistantMessage, type SessionEntry } from "./session.ts";

test("every bundled role and explicit override retains codemode and child controls", () => {
  const agentsDir = new URL("../agents/", import.meta.url);
  const roleTools = readdirSync(agentsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(new URL(name, agentsDir), "utf8").match(/^tools: (.+)$/m)?.[1])
    .filter((tools) => tools !== undefined);
  // No allowlist: delegate keeps MCP tools (exact-name allowlists would hide them).
  assert.doesNotMatch(readFileSync(new URL("delegate.md", agentsDir), "utf8"), /^tools:/m);
  for (const tools of [...roleTools, "read", "read, codemode, read"]) {
    assert.ok(tools);
    const actual = buildChildToolAllowlist(tools)!.split(",");
    const expected = new Set([...tools.split(",").map((name) => name.trim()), "caller_ping", "subagent_done", "room", "codemode"]);
    assert.deepEqual(new Set(actual), expected);
    assert.equal(actual.length, expected.size);
  }
  assert.equal(buildChildToolAllowlist(), null);
  assert.equal(buildChildToolAllowlist(" , "), null);
});

test("summary prefers subagent_done message, else last assistant text", () => {
  const assistant = (content: unknown[]): SessionEntry =>
    ({ type: "message", id: "x", message: { role: "assistant", content } }) as SessionEntry;
  const text = (t: string) => ({ type: "text", text: t });
  const done = (args: unknown) => ({ type: "toolCall", id: "c", name: "subagent_done", arguments: args });

  assert.equal(findLastAssistantMessage([assistant([text("early")]), assistant([done({ message: "audit" })])]), "audit");
  assert.equal(findLastAssistantMessage([assistant([text("preamble"), done({ message: "audit" })])]), "audit");
  assert.equal(findLastAssistantMessage([assistant([text("result")]), assistant([done({})])]), "result");
  assert.equal(findLastAssistantMessage([assistant([done({ message: " " })])]), null);
});

test("child startup restores codemode without widening other role permissions", () => {
  for (const initial of [[], ["read"], ["read", "codemode"]]) {
    let active = [...initial];
    let updates = 0;
    const handlers = new Map<string, Function>();
    const pi = {
      on: (event: string, handler: Function) => { handlers.set(event, handler); },
      registerTool: () => {},
      registerShortcut: () => {},
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => { active = names; updates++; },
      getAllTools: () => active.map((name) => ({ name })),
    } as unknown as ExtensionAPI;
    childExtension(pi);
    const start = handlers.get("session_start")!;
    for (const reason of ["startup", "reload"]) start({ reason }, { hasUI: false });
    assert.deepEqual(active, [...new Set([...initial, "codemode"])]);
    assert.equal(updates, initial.includes("codemode") ? 0 : 1);
  }
});

test("caller_ping keeps a non-interactive child alive until the parent's reply arrives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caller-ping-"));
  const sessionFile = join(dir, "child.jsonl");
  const room = join(dir, "room");
  const saved = {
    PI_SUBAGENT_SESSION: process.env.PI_SUBAGENT_SESSION,
    PI_SUBAGENT_INTERACTIVE: process.env.PI_SUBAGENT_INTERACTIVE,
    PI_ROOM: process.env.PI_ROOM,
    PI_SUBAGENT_NAME: process.env.PI_SUBAGENT_NAME,
  };
  process.env.PI_SUBAGENT_SESSION = sessionFile;
  process.env.PI_ROOM = room;
  process.env.PI_SUBAGENT_NAME = "kid";
  delete process.env.PI_SUBAGENT_INTERACTIVE;
  const delivered: any[] = [];
  try {
    const handlers = new Map<string, Function>();
    const tools = new Map<string, any>();
    const pi = {
      on: (event: string, handler: Function) => { handlers.set(event, handler); },
      registerTool: (tool: any) => { tools.set(tool.name, tool); },
      registerShortcut: () => {},
      sendMessage: (m: any) => delivered.push(m),
    } as unknown as ExtensionAPI;
    childExtension(pi);
    let shutdowns = 0;
    const ctx = { shutdown: () => { shutdowns++; } };
    const done = { messages: [{ role: "assistant", stopReason: "stop" }] };

    handlers.get("input")!({});
    handlers.get("agent_start")!({});
    const result = await tools.get("caller_ping").execute("c", { message: "which DB?" }, undefined, undefined, ctx);
    assert.equal(result.terminate, true);
    assert.equal(existsSync(`${sessionFile}.exit`), false);
    const pings: RoomMessage[] = [];
    drainInbox(room, HOST, (m) => pings.push(m));
    assert.deepEqual(pings.map((m) => [m.from, m.body, m.ping]), [["kid", "which DB?", true]]);
    handlers.get("agent_end")!(done, ctx);
    assert.equal(shutdowns, 0, "ping must not end the run");

    // Parent's reply through the room clears the wait (inbox polled every 1s).
    postMessage(room, { from: HOST, to: "kid", body: "postgres", ts: Date.now() });
    const end = Date.now() + 3000;
    while (!delivered.length && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    assert.match(delivered[0]?.content ?? "", /Message from "parent" to you:\n\npostgres/);
    handlers.get("agent_start")!({});
    handlers.get("agent_end")!(done, ctx);
    assert.equal(shutdowns, 1, "run ends normally after the reply turn");
  } finally {
    clearInterval((globalThis as any)[Symbol.for("pi-tmux-subagents/child-inbox-interval")]);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exiting tools are refused while children or tmux panes are pending", () => {
  assert.equal(pendingChildrenError("pinging", 0), null);
  assert.match(pendingChildrenError("pinging", 2)!.message, /^2 of your .* pinging now would exit/);
});

test("interactive child never auto-exits; idle snapshot carries pending children", () => {
  const dir = mkdtempSync(join(tmpdir(), "interactive-"));
  const keys = ["PI_SUBAGENT_INTERACTIVE", "PI_SUBAGENT_ID", "PI_SUBAGENT_ACTIVITY_FILE"] as const;
  const saved = keys.map((k) => process.env[k]);
  const activityFile = join(dir, "act.json");
  process.env.PI_SUBAGENT_INTERACTIVE = "1";
  process.env.PI_SUBAGENT_ID = "kid";
  process.env.PI_SUBAGENT_ACTIVITY_FILE = activityFile;
  const g = globalThis as any;
  const runningKey = Symbol.for("pi-tmux-subagents/running");
  const savedRunning = g[runningKey];
  try {
    const handlers = new Map<string, Function>();
    const pi = {
      on: (event: string, handler: Function) => { handlers.set(event, handler); },
      registerTool: () => {},
      registerShortcut: () => {},
    } as unknown as ExtensionAPI;
    childExtension(pi);
    let shutdowns = 0;
    const ctx = { shutdown: () => { shutdowns++; } };
    g[runningKey] = new Map([["x", {}], ["y", {}]]);
    handlers.get("agent_start")!({});
    handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    assert.equal(shutdowns, 0);
    const activity = JSON.parse(readFileSync(activityFile, "utf8"));
    assert.equal(activity.phase, "waiting");
    assert.equal(activity.pendingChildren, 2);
  } finally {
    g[runningKey] = savedRunning;
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
    rmSync(dir, { recursive: true, force: true });
  }
});
