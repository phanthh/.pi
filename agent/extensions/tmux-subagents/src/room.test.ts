import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  drainInbox, formatRoster, HOST, postMessage, pruneRooms, resolveTargets, sendRoom, writeMember, type Member, type RoomMessage,
} from "./room.ts";

const member = (name: string, status: Member["status"], startedAt: number): Member => ({
  name, id: name, status, sessionFile: `/s/${name}`, surface: "%1", interactive: false, task: `task of ${name}`, startedAt,
});
const err = (r: ReturnType<typeof resolveTargets>) => ("error" in r ? r.error : assert.fail("expected error"));

test("room: two-scope addressing, ordered once-only delivery, roster, prune", () => {
  const root = mkdtempSync(join(tmpdir(), "room-"));
  try {
    // "lead" sits in `up` (its parent's room) and hosts `own`.
    const up = join(root, "up");
    const own = join(root, "own");
    writeMember(up, member("lead", "running", 1));
    writeMember(up, member("sib", "running", 2));
    writeMember(up, member("gone", "done", 3));
    writeMember(up, member("twin", "running", 4));
    writeMember(own, member("kid a", "running", 5));
    writeMember(own, member("twin", "running", 6));
    const lead = { self: "lead", up, own };

    assert.deepEqual(resolveTargets(lead, HOST), { targets: [{ room: up, to: HOST, from: "lead" }] });
    assert.deepEqual(resolveTargets(lead, "sib"), { targets: [{ room: up, to: "sib", from: "lead" }] });
    assert.deepEqual(resolveTargets(lead, "kid a"), { targets: [{ room: own, to: "kid a", from: HOST }] });
    const all = resolveTargets(lead, "all");
    assert.deepEqual("targets" in all && all.targets.map((t) => `${t.room === up ? "up" : "own"}:${t.to}`),
      ["up:parent", "up:sib", "up:twin", "own:kid a", "own:twin"]);
    assert.match(err(resolveTargets(lead, "twin")), /both your child and your sibling/);
    assert.match(err(resolveTargets(lead, "lead")), /yourself/);
    assert.match(err(resolveTargets(lead, "gone")), /is done/);
    assert.match(err(resolveTargets(lead, "nobody")), /Reachable: parent, sib, twin, kid a, twin/);
    // Root: no parent.
    assert.match(err(resolveTargets({ self: HOST, own }, HOST)), /no parent/);

    sendRoom(lead, "kid a", "second");
    postMessage(own, { from: HOST, to: "kid a", body: "first", ts: 1 });
    const got: RoomMessage[] = [];
    assert.equal(drainInbox(own, "kid a", (m) => got.push(m)), 2);
    assert.deepEqual(got.map((m) => [m.from, m.body]), [[HOST, "first"], [HOST, "second"]]);
    assert.equal(drainInbox(own, "kid a", () => assert.fail("redelivered")), 0);

    const roster = formatRoster(lead);
    assert.match(roster, /parent's room[\s\S]*lead \(you\)[\s\S]*gone — done[\s\S]*Your children:\n• kid a/);
    assert.match(formatRoster({ self: HOST }), /nobody to message/);

    const old = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    for (const p of [up, join(up, "members")]) utimesSync(p, old, old);
    pruneRooms(root);
    assert.ok(!existsSync(up));
    assert.ok(existsSync(own));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
