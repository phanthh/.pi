import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildChildScript, cascadeShutdown, discoverAgentDefinitions, parseAgentDefinition } from "./index.ts";
import type { LaunchSpec } from "./policy.ts";
import { IDLE_STEER_AFTER_MS, idleSteerDue } from "./status.ts";

const srcDir = new URL("./", import.meta.url);
const agentsDir = new URL("../agents/", import.meta.url);

test("bundled frontmatter drives lead/interactive/spawns; removed keys are gone", () => {
  const defs = new Map(discoverAgentDefinitions().map((d) => [d.name, d]));
  for (const file of readdirSync(agentsDir)) {
    assert.doesNotMatch(readFileSync(new URL(file, agentsDir), "utf8"), /^(auto-exit|skills?|session-mode|cwd|disable-model-invocation):/m, file);
  }
  assert.ok(defs.get("delegate")?.lead && defs.get("delegate")?.interactive);
  assert.equal(defs.get("reviewer")?.spawns, "scout, researcher");
  for (const name of ["reviewer", "scout", "researcher"]) {
    assert.equal(defs.get(name)?.lead, false, name);
    assert.equal(defs.get(name)?.interactive, false, name);
  }
});

test("lead/interactive come from any def's frontmatter, not its name", () => {
  const def = parseAgentDefinition("---\nname: zz\nlead: true\ninteractive: true\nauto-exit: false\n---\nbody", "zz")!;
  assert.equal(def.lead, true);
  assert.equal(def.interactive, true);
  const plain = parseAgentDefinition("---\nname: delegate\n---\n", "delegate")!;
  assert.equal(plain.lead, false, "name alone grants nothing");
});

test("only bundled agents are discovered; project/global dirs ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-test-"));
  const cwd = process.cwd();
  try {
    mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
    writeFileSync(join(dir, ".pi", "agents", "decoy.md"), "---\nname: decoy\n---\n");
    process.chdir(dir);
    assert.ok(!discoverAgentDefinitions().some((d) => d.name === "decoy"));
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no bundled agent name is hard-coded in extension logic", () => {
  const names = readdirSync(agentsDir).map((f) => f.replace(/\.md$/, ""));
  for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const text = readFileSync(new URL(file, srcDir), "utf8");
    for (const name of names) assert.ok(!new RegExp(`\\b${name}\\b`).test(text), `${file} mentions ${name}`);
  }
});

test("child script: status file always, kill-session only for leads, interactive env", () => {
  const dir = mkdtempSync(join(tmpdir(), "script-test-"));
  try {
    const spec: LaunchSpec = { version: 2, name: "X", agent: "a", denyTools: [], lead: false, interactive: false, cwd: "/tmp" };
    const args = { sessionFile: join(dir, "s.jsonl"), id: "i", activityFile: "/a", artifactDir: dir, promptArgs: ["@t"] };
    const follower = buildChildScript({ spec, ...args });
    assert.match(follower, /echo \$\? > '.*s\.jsonl\.status'/);
    assert.doesNotMatch(follower, /kill-session|PI_SUBAGENT_INTERACTIVE|PI_SUBAGENT_DEPTH|PI_SUBAGENT_AUTO_EXIT/);
    const lead = buildChildScript({ spec: { ...spec, lead: true, interactive: true }, ...args });
    assert.match(lead, /PI_SUBAGENT_INTERACTIVE=1/);
    assert.match(lead.trimEnd().split("\n").at(-1)!, /^tmux kill-session -t "\$\(tmux display-message -p -t "\$TMUX_PANE" '#\{session_id\}'\)"$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reload never cascades", () => {
  const saved = process.env.TMUX;
  process.env.TMUX = "/nonexistent,0,0";
  try {
    cascadeShutdown("reload"); // would throw/exec if it touched tmux
  } finally {
    if (saved === undefined) delete process.env.TMUX;
    else process.env.TMUX = saved;
  }
});

test("idle note: interactive, waiting ≥2m, once per episode, nothing pending", () => {
  const now = 1_000_000;
  const since = now - IDLE_STEER_AFTER_MS;
  const base = { interactive: true, snapshot: { kind: "waiting" as const, waitingSinceMs: since }, pendingChildren: 0, awaitingReply: false, steeredFor: null, now };
  assert.equal(idleSteerDue(base), true);
  assert.equal(idleSteerDue({ ...base, steeredFor: since }), false, "once per episode");
  assert.equal(idleSteerDue({ ...base, steeredFor: since - 5 }), true, "new episode fires again");
  assert.equal(idleSteerDue({ ...base, now: now - 1 }), false, "under threshold");
  assert.equal(idleSteerDue({ ...base, pendingChildren: 1 }), false);
  assert.equal(idleSteerDue({ ...base, awaitingReply: true }), false);
  assert.equal(idleSteerDue({ ...base, interactive: false }), false);
  assert.equal(idleSteerDue({ ...base, snapshot: { kind: "active", waitingSinceMs: null } }), false);
});
