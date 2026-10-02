import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childExtension from "./child.ts";
import { buildChildToolAllowlist } from "./index.ts";

test("every bundled role and explicit override retains codemode and child controls", () => {
  const agentsDir = new URL("../agents/", import.meta.url);
  const roleTools = readdirSync(agentsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(new URL(name, agentsDir), "utf8").match(/^tools: (.+)$/m)?.[1]);
  for (const tools of [...roleTools, "read", "read, codemode, read"]) {
    assert.ok(tools);
    const actual = buildChildToolAllowlist(tools)!.split(",");
    const expected = new Set([...tools.split(",").map((name) => name.trim()), "caller_ping", "subagent_done", "codemode"]);
    assert.deepEqual(new Set(actual), expected);
    assert.equal(actual.length, expected.size);
  }
  assert.equal(buildChildToolAllowlist(), null);
  assert.equal(buildChildToolAllowlist(" , "), null);
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
