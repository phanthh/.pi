// Live check against an isolated tmux server: `pnpm --filter @pi-ext/tmux-windows test`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeWindow, createSession, createWindow, isPaneAlive, killSession, ownedSessions, ownedWindows, ownSession, viaUserShell,
} from "./index.ts";

const server = `pi-windows-test-${process.pid}`;
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", server, "-f", "/dev/null", ...args], { encoding: "utf8" }).trim();
const originalEnv = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, SHELL: process.env.SHELL };
const fmt = (target: string, f: string) => tmux("display-message", "-p", "-t", target, f);

try {
  const root = tmux("new-session", "-d", "-s", "main", "-P", "-F", "#{pane_id}");
  const other = tmux("new-session", "-d", "-s", "other", "-P", "-F", "#{pane_id}");
  process.env.TMUX = `${fmt(root, "#{socket_path}")},0,0`;
  process.env.TMUX_PANE = root;
  tmux("set-option", "-g", "renumber-windows", "on");
  const mainSession = fmt(root, "#{session_id}");
  assert.equal(ownSession(), mainSession);
  const activeBefore = fmt(root, "#{active_window_index}");

  // 7. createWindow: own session, detached, tagged, cwd honored.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-win-")));
  const w1 = createWindow({ name: "Scout: A", tag: { key: "@pi_subagent", value: "A" }, cwd });
  assert.equal(fmt(w1, "#{session_id}"), mainSession, "lands in own session");
  assert.notEqual(fmt(w1, "#{session_id}"), fmt(other, "#{session_id}"));
  assert.equal(fmt(root, "#{active_window_index}"), activeBefore, "focus not stolen");
  assert.equal(fmt(w1, "#{@pi_owner}"), root);
  assert.equal(fmt(w1, "#{@pi_subagent}"), "A");
  assert.equal(fmt(w1, "#{automatic-rename}"), "0");
  assert.equal(fmt(w1, "#{remain-on-exit}"), "off");
  assert.equal(fmt(w1, "#{window_name}"), "Scout: A");
  assert.equal(fmt(w1, "#{pane_current_path}"), cwd);

  // 9. ownership filter: untagged, other-owner and other-tag windows excluded.
  tmux("new-window", "-d", "-t", "main:");
  const foreign = tmux("new-window", "-d", "-t", "main:", "-P", "-F", "#{pane_id}");
  tmux("set-option", "-w", "-t", foreign, "@pi_owner", "%999");
  tmux("set-option", "-w", "-t", foreign, "@pi_subagent", "X");
  const run = createWindow({ name: "build", tag: { key: "@pi_name", value: "build" } });
  assert.deepEqual(ownedWindows("@pi_subagent").map((w) => w.paneId), [w1]);
  assert.deepEqual(ownedWindows("@pi_name").map((w) => [w.paneId, w.tag]), [[run, "build"]]);

  // 8. createSession: detached, owner + detach option, sanitized, collision suffix.
  const s1 = createSession({ name: "main-fix.auth:x", command: "sleep 60" });
  assert.equal(s1.name, "main-fix_auth_x");
  assert.equal(fmt(s1.paneId, "#{session_id}"), s1.sessionId);
  assert.equal(fmt(s1.sessionId, "#{@pi_session_owner}"), root);
  assert.equal(fmt(s1.sessionId, "#{detach-on-destroy}"), "previous");
  assert.equal(fmt(s1.paneId, "#{@pi_owner}"), "", "session tag does not leak into window owner lookup");
  const s2 = createSession({ name: "main-fix.auth:x" });
  assert.match(s2.name, /^main-fix_auth_x-[0-9a-f]{4}$/);
  assert.deepEqual(ownedSessions().sort(), [s1.sessionId, s2.sessionId].sort());
  process.env.TMUX_PANE = other;
  assert.deepEqual(ownedSessions(), [], "other pane owns nothing");
  assert.deepEqual(ownedWindows("@pi_subagent"), [], "other session sees no windows");
  process.env.TMUX_PANE = root;

  // 10. idempotent close; ids survive renumbering.
  tmux("kill-window", "-t", "main:1");
  assert.ok(isPaneAlive(run), "pane id survives renumber");
  closeWindow(w1);
  closeWindow(w1);
  assert.ok(!isPaneAlive(w1));
  killSession(s2.sessionId);
  killSession(s2.sessionId);
  assert.deepEqual(ownedSessions(), [s1.sessionId]);

  // Owner pane gone (its window killed, pi shutting down on SIGHUP): still finds its windows.
  const owner = tmux("new-window", "-d", "-t", "other:", "-P", "-F", "#{pane_id}");
  process.env.TMUX_PANE = owner;
  const orphan = createWindow({ name: "kid", tag: { key: "@pi_subagent", value: "kid" } });
  tmux("kill-pane", "-t", owner);
  assert.deepEqual(ownedWindows("@pi_subagent").map((w) => w.paneId), [orphan]);
  process.env.TMUX_PANE = root;

  // viaUserShell must survive a non-POSIX default-shell (fish) and still use the user's shell.
  const marker = join(cwd, "via-shell");
  process.env.SHELL = "/bin/sh";
  const fish = execFileSync("sh", ["-c", "command -v fish || true"], { encoding: "utf8" }).trim();
  if (fish) tmux("set-option", "-g", "default-shell", fish);
  createWindow({ name: "sh", tag: { key: "@pi_name", value: "sh" }, command: viaUserShell(`echo ok > '${marker}'`) });
  for (let i = 0; i < 50 && !existsSync(marker); i++) execFileSync("sleep", ["0.1"]);
  assert.ok(existsSync(marker), `viaUserShell ran (default-shell ${fish || "default"})`);

  // Commands that exit at once must not outrun tagging (create+tag is one sequence).
  for (let i = 0; i < 20; i++) createWindow({ name: "fast", tag: { key: "@pi_name", value: "fast" }, command: "true" });
  for (let i = 0; i < 20; i++) createSession({ name: "fast", command: "true" });
  console.log("tmux-windows ok");
} finally {
  try { tmux("kill-server"); } catch { /* already gone */ }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
