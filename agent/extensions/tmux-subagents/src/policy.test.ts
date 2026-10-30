import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  allowedSpawns,
  type LaunchSpec,
  launchSpecFile,
  readLaunchSpec,
  resolveDenyTools,
  spawnRefusal,
  writeLaunchSpec,
} from "./policy.ts";

test("denies accumulate: role denies ∪ inherited, plus tmux_subagent when spawning is off", () => {
  assert.deepEqual(new Set(resolveDenyTools({ denyTools: "ask, goal" }, ["edit"])), new Set(["edit", "ask", "goal"]));
  assert.deepEqual(resolveDenyTools({ spawning: false }, []), ["tmux_subagent"]);
  assert.deepEqual(resolveDenyTools(null, ["ask"]), ["ask"]);
  assert.deepEqual(resolveDenyTools(null, []), []);
});

test("spawns list gates launch and resume generically", () => {
  assert.equal(allowedSpawns(undefined), null);
  assert.equal(spawnRefusal("anything", null), null);
  assert.equal(spawnRefusal(undefined, null), null);
  const allowed = allowedSpawns("a, b")!;
  assert.equal(spawnRefusal("a", allowed), null);
  assert.match(spawnRefusal("c", allowed)!, /may launch only: a, b/);
  assert.match(spawnRefusal(undefined, allowed)!, /without a known agent/);
  assert.match(spawnRefusal("a", allowedSpawns(""))!, /may launch only: nothing/);
});

test("launch spec round-trips; corrupt or foreign files read as null", () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-test-"));
  try {
    const session = join(dir, "s.jsonl");
    assert.equal(readLaunchSpec(session), null);
    const spec: LaunchSpec = {
      version: 2,
      name: "Rev",
      agent: "role-x",
      model: "p/m:high",
      systemPrompt: { mode: "replace", text: "be strict\nline 2" },
      tools: "read,bash,caller_ping,subagent_done,codemode",
      denyTools: ["ask"],
      spawns: ["role-y"],
      lead: true,
      interactive: false,
      cwd: "/x",
    };
    writeLaunchSpec(session, spec);
    assert.deepEqual(readLaunchSpec(session), spec);
    writeFileSync(launchSpecFile(session), "{nope");
    assert.equal(readLaunchSpec(session), null);
    for (const stale of [
      { version: 1, name: "old", denyTools: [], autoExit: true },
      { version: 2, name: "partial", agent: "x", denyTools: [] },
    ]) {
      writeFileSync(launchSpecFile(session), JSON.stringify(stale));
      assert.equal(readLaunchSpec(session), null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
