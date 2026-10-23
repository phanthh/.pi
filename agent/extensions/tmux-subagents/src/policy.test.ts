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
  resolveToolAllowlist,
  spawnRefusal,
  writeLaunchSpec,
} from "./policy.ts";

test("denies accumulate: role denies ∪ inherited, plus tmux_subagent when spawning is off", () => {
  assert.deepEqual(new Set(resolveDenyTools({ denyTools: "ask, goal" }, ["edit"])), new Set(["edit", "ask", "goal"]));
  assert.deepEqual(resolveDenyTools({ spawning: false }, []), ["tmux_subagent"]);
  assert.deepEqual(resolveDenyTools(null, ["ask"]), ["ask"]);
  assert.deepEqual(resolveDenyTools(null, []), []);
});

test("tools override only narrows a role allowlist", () => {
  assert.equal(resolveToolAllowlist("read, bash, lsp", undefined), "read, bash, lsp");
  assert.equal(resolveToolAllowlist("read, bash, lsp", "read, edit"), "read");
  assert.equal(resolveToolAllowlist(undefined, "read, edit"), "read, edit");
  assert.throws(() => resolveToolAllowlist("read", "edit"), /role allowlist/);
});

test("spawns list gates launch and resume", () => {
  assert.equal(allowedSpawns(undefined), null);
  assert.equal(spawnRefusal("delegate", null), null);
  assert.equal(spawnRefusal(undefined, null), null);
  const allowed = allowedSpawns("scout, researcher")!;
  assert.equal(spawnRefusal("scout", allowed), null);
  assert.match(spawnRefusal("delegate", allowed)!, /may launch only: scout, researcher/);
  assert.match(spawnRefusal(undefined, allowed)!, /without a known agent/);
  assert.match(spawnRefusal("scout", allowedSpawns(""))!, /may launch only: nothing/);
});

test("launch spec round-trips; corrupt or foreign files read as null", () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-test-"));
  try {
    const session = join(dir, "s.jsonl");
    assert.equal(readLaunchSpec(session), null);
    const spec: LaunchSpec = {
      version: 1,
      name: "Rev",
      agent: "reviewer",
      model: "p/m:high",
      systemPrompt: { mode: "replace", text: "be strict\nline 2" },
      tools: "read,bash,caller_ping,subagent_done,codemode",
      denyTools: ["ask"],
      spawns: ["scout"],
      autoExit: true,
      cwd: "/x",
    };
    writeLaunchSpec(session, spec);
    assert.deepEqual(readLaunchSpec(session), spec);
    writeFileSync(launchSpecFile(session), "{nope");
    assert.equal(readLaunchSpec(session), null);
    writeFileSync(launchSpecFile(session), JSON.stringify({ version: 2, denyTools: [] }));
    assert.equal(readLaunchSpec(session), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
