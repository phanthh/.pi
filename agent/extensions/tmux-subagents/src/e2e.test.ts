// End-to-end: real isolated tmux server, stub `pi` on PATH, no LLM.
// The stub picks its behavior from `STUB_MODE=<mode>` in its @task/@message file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const root = realpathSync(mkdtempSync(join(tmpdir(), "subagent-e2e-")));
const server = `pi-subagent-e2e-${process.pid}`;
const binDir = join(root, "bin");
const STUB = `#!/bin/bash
session=""; prompt=""
while [ $# -gt 0 ]; do
  case "$1" in --session) session="$2"; shift ;; @*) prompt="\${1#@}" ;; esac
  shift
done
mode=$(grep -o 'STUB_MODE=[a-z]*' "$prompt" 2>/dev/null | head -1 | cut -d= -f2)
say() { printf '{"type":"message","id":"%s","message":{"role":"assistant","content":[{"type":"text","text":"%s"}]}}\\n' "$RANDOM" "$1" >> "$session"; }
echo "stub pi mode=$mode spawns=$PI_SUBAGENT_SPAWNS interactive=$PI_SUBAGENT_INTERACTIVE"
case "$mode" in
  done) say "result from $PI_SUBAGENT_NAME"; echo '{"type":"done"}' > "$session.exit"; exit 0 ;;
  quit) say "quit text"; exit 0 ;;
  crash) exit 3 ;;
  gate) while [ ! -e "$session.go" ]; do sleep 0.1; done; say "after reload $PI_SUBAGENT_NAME"; echo '{"type":"done"}' > "$session.exit"; exit 0 ;;
  ping) echo '{"type":"ping","name":"'"$PI_SUBAGENT_NAME"'","message":"which db?"}' > "$session.ping"; exec sleep 600 ;;
  *) exec sleep 600 ;;
esac
`;

const savedEnv = { ...process.env };
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", server, "-f", "/dev/null", ...args], { encoding: "utf8" }).trim();
const fmt = (t: string, f: string) => tmux("display-message", "-p", "-t", t, f);
const sessions = () => tmux("list-sessions", "-F", "#{session_name}").split("\n");
const paneAlive = (p: string) => tmux("list-panes", "-a", "-F", "#{pane_id}").split("\n").includes(p);

let rootPane = "";
let ext: typeof import("./index.ts");
let tool: any;
const handlers = new Map<string, Function>();
const messages: Array<{ customType: string; content: string; details: any }> = [];
const sessionDir = join(root, "parent-sessions");
const ctx = {
  cwd: root,
  hasUI: false,
  sessionManager: {
    getSessionFile: () => join(sessionDir, "parent.jsonl"),
    getSessionId: () => "parent",
    getSessionDir: () => sessionDir,
  },
};

function fakePi(): ExtensionAPI {
  return {
    on: (event: string, h: Function) => handlers.set(event, h),
    registerTool: (t: any) => { tool = t; },
    registerMessageRenderer: () => {},
    sendMessage: (m: any) => messages.push(m),
  } as unknown as ExtensionAPI;
}

// Real tmux + the extension's 1s sidecar poller: fake timers cannot drive them,
// so wait on the observable condition with a short re-check.
async function waitFor<T>(fn: () => T | undefined | false, what: string, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const call = (params: Record<string, unknown>) => tool.execute("t", params, new AbortController().signal, undefined, ctx);
const text = (r: any) => r.content[0].text as string;
const nextMessage = (pred: (m: (typeof messages)[number]) => boolean, what: string) =>
  waitFor(() => messages.find(pred), what);
const resultFor = (name: string) => nextMessage((m) => m.customType === "subagent_result" && m.details.name === name, `result ${name}`);

before(async () => {
  mkdirSync(binDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(binDir, "pi"), STUB);
  chmodSync(join(binDir, "pi"), 0o755);
  writeFileSync(join(sessionDir, "parent.jsonl"), "");
  // Server env feeds pane env: stub first on PATH, plain sh without rc files.
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  process.env.SHELL = "/bin/sh";
  delete process.env.ENV;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  for (const k of Object.keys(process.env)) if (k.startsWith("PI_SUBAGENT_") || k === "PI_DENY_TOOLS") delete process.env[k];
  rootPane = tmux("new-session", "-d", "-s", "root", "-P", "-F", "#{pane_id}", "sleep 600");
  process.env.TMUX = `${fmt(rootPane, "#{socket_path}")},0,0`;
  process.env.TMUX_PANE = rootPane;

  ext = await import("./index.ts");
  ext.default(fakePi());
  handlers.get("session_start")!({}, ctx);
});

after(() => {
  handlers.get("session_shutdown")?.({ reason: "quit" });
  try { tmux("kill-server"); } catch {}
  process.env = savedEnv;
  rmSync(root, { recursive: true, force: true });
});

test("follower done: window in own session, tagged, result steered, window gone", async () => {
  const r = await call({ name: "Scout A", agent: "scout", task: "STUB_MODE=hang" });
  const pane = await waitFor(() => tmux("list-panes", "-s", "-t", "root", "-F", "#{pane_id} #{@pi_subagent}").split("\n").find((l) => l.endsWith("Scout A"))?.split(" ")[0], "window");
  assert.equal(fmt(pane, "#{session_name}"), "root");
  assert.equal(fmt(pane, "#{@pi_owner}"), rootPane);
  assert.equal(fmt(pane, "#{window_name}"), "Scout A");
  assert.equal(fmt(rootPane, "#{window_active}"), "1", "focus stays on lead");
  await call({ action: "stop", id: r.details.id });
  assert.ok(!paneAlive(pane));

  await call({ name: "Scout B", agent: "scout", task: "STUB_MODE=done" });
  const m = await resultFor("Scout B");
  assert.match(m.content, /completed[\s\S]*result from Scout B/);
  assert.equal(tmux("list-panes", "-s", "-t", "root", "-F", "#{@pi_subagent}").includes("Scout B"), false);
});

test("lead done: new session named after spawner, owner + detach option, gone after", async () => {
  const r = await call({ name: "Fix Auth", agent: "delegate", task: "STUB_MODE=hang" });
  assert.equal(r.details.tmuxSession, "root-fix-auth");
  assert.equal(fmt("=root-fix-auth:", "#{@pi_session_owner}"), rootPane);
  assert.equal(fmt("=root-fix-auth:", "#{detach-on-destroy}"), "previous");
  // Collision → suffix.
  const r2 = await call({ name: "Fix Auth", agent: "delegate", task: "STUB_MODE=done" });
  assert.match(r2.details.tmuxSession, /^root-fix-auth-[0-9a-f]{4}$/);
  const m = await nextMessage((x) => x.customType === "subagent_result" && x.details.sessionFile === r2.details.sessionFile, "lead result");
  assert.match(m.content, /completed/);
  await waitFor(() => !sessions().includes(r2.details.tmuxSession), "lead session killed by its script");
  const stopped = await call({ action: "stop", id: r.details.id });
  assert.match(text(stopped), /Stopped "Fix Auth"/);
  await waitFor(() => !sessions().includes("root-fix-auth"), "stop kills lead session");
});

test("crash reports exit code; plain quit reports closed with last text", async () => {
  await call({ name: "Crash", agent: "scout", task: "STUB_MODE=crash" });
  assert.match((await resultFor("Crash")).content, /failed \(exit code 3\)/);
  await call({ name: "Quit", agent: "scout", task: "STUB_MODE=quit" });
  const m = await resultFor("Quit");
  assert.match(m.content, /completed[\s\S]*quit text/);
});

test("ping steers needs-help; send types into the child", async () => {
  const r = await call({ name: "Pinger", agent: "delegate", task: "STUB_MODE=ping" });
  const ping = await nextMessage((m) => m.customType === "subagent_ping" && m.details.id === r.details.id, "ping");
  assert.match(ping.content, /needs help[\s\S]*which db\?/);
  await call({ action: "send", id: r.details.id, message: "use postgres" });
  const pane = fmt(`=${r.details.tmuxSession}:`, "#{pane_id}");
  await waitFor(() => tmux("capture-pane", "-p", "-t", pane).includes("use postgres"), "sent text visible");
  await call({ action: "stop", id: r.details.id });
});

test("spawns list refuses before creating anything", async () => {
  process.env.PI_SUBAGENT_SPAWNS = "scout,researcher";
  try {
    const before = sessions().length;
    const r = await call({ name: "Nope", agent: "delegate", task: "STUB_MODE=done" });
    assert.equal(r.isError, true);
    assert.match(text(r), /may launch only: scout, researcher/);
    assert.equal(sessions().length, before);
  } finally {
    delete process.env.PI_SUBAGENT_SPAWNS;
  }
});

test("resume: v2 lead spec → new session; missing spec refused", async () => {
  const first = await call({ name: "Again", agent: "delegate", task: "STUB_MODE=done" });
  await resultFor("Again");
  const resumed = await call({ action: "resume", sessionPath: first.details.sessionFile, message: "STUB_MODE=done" });
  assert.match(resumed.details.tmuxSession, /^root-again/);
  await waitFor(() => messages.filter((m) => m.customType === "subagent_result" && m.details.name === "Again").length === 2, "resumed result");
  const bare = join(root, "bare.jsonl");
  writeFileSync(bare, "");
  const refused = await call({ action: "resume", sessionPath: bare });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /No usable launch spec/);
});

test("shutdown cascade by tags: reload keeps, new kills children only, quit kills", async () => {
  const userWin = tmux("new-window", "-d", "-t", "root:", "-P", "-F", "#{pane_id}", "sleep 600");
  const foreign = tmux("new-window", "-d", "-t", "root:", "-P", "-F", "#{pane_id}", "sleep 600");
  tmux("set-option", "-w", "-t", foreign, "@pi_owner", "%9999");
  tmux("set-option", "-w", "-t", foreign, "@pi_subagent", "x");
  const runWin = tmux("new-window", "-d", "-t", "root:", "-P", "-F", "#{pane_id}", "sleep 600");
  tmux("set-option", "-w", "-t", runWin, "@pi_owner", rootPane);
  tmux("set-option", "-w", "-t", runWin, "@pi_name", "build");
  const orphan = tmux("new-window", "-d", "-t", "root:", "-P", "-F", "#{pane_id}", "sleep 600");
  tmux("set-option", "-w", "-t", orphan, "@pi_owner", rootPane);
  tmux("set-option", "-w", "-t", orphan, "@pi_subagent", "orphan");

  const spawn = async () => {
    const s = await call({ name: "Hang S", agent: "scout", task: "STUB_MODE=hang" });
    const d = await call({ name: "Hang D", agent: "delegate", task: "STUB_MODE=hang" });
    return { scoutPane: s.details as any, lead: d.details.tmuxSession as string };
  };
  const scoutPane = () => tmux("list-panes", "-s", "-t", "root", "-F", "#{pane_id} #{@pi_subagent}").split("\n").find((l) => l.endsWith("Hang S"))?.split(" ")[0];

  let { lead } = await spawn();
  const s1 = await waitFor(scoutPane, "scout window");
  handlers.get("session_shutdown")!({ reason: "reload" });
  assert.ok(paneAlive(s1) && sessions().includes(lead) && paneAlive(orphan), "reload keeps all");
  handlers.get("session_start")!({}, ctx);

  handlers.get("session_shutdown")!({ reason: "new" });
  assert.ok(!paneAlive(s1) && !sessions().includes(lead) && !paneAlive(orphan), "new kills subagents + orphans");
  assert.ok(paneAlive(runWin) && paneAlive(userWin) && paneAlive(foreign), "run/user/foreign windows survive");
  handlers.get("session_start")!({}, ctx);

  ({ lead } = await spawn());
  const s2 = await waitFor(scoutPane, "scout window 2");
  handlers.get("session_shutdown")!({ reason: "quit" });
  assert.ok(!paneAlive(s2) && !sessions().includes(lead));
  assert.ok(paneAlive(userWin) && paneAlive(foreign));
  handlers.get("session_start")!({}, ctx);
});

// Keep last: replaces the module instance like /reload does.
test("reload: new module adopts live children; results, status, stop keep working", async () => {
  const f = await call({ name: "Gate F", agent: "scout", task: "STUB_MODE=gate" });
  const l = await call({ name: "Gate L", agent: "delegate", task: "STUB_MODE=hang" });

  handlers.get("session_shutdown")!({ reason: "reload" });
  const fresh: typeof import("./index.ts") = await import(`./index.ts?reload=${Date.now()}`);
  fresh.default(fakePi());
  handlers.get("session_start")!({ reason: "reload" }, ctx);

  const status = text(await call({ action: "status" }));
  assert.match(status, /Gate F/);
  assert.match(status, /Gate L/);

  writeFileSync(`${f.details.sessionFile}.go`, "");
  const m = await resultFor("Gate F");
  assert.match(m.content, /completed[\s\S]*after reload Gate F/);
  assert.equal(messages.filter((x) => x.details?.name === "Gate F" && /cancelled/.test(x.content)).length, 0, "no cancel noise");

  const stopped = await call({ action: "stop", id: l.details.id });
  assert.ok(!stopped.isError, text(stopped));
  assert.ok(!sessions().includes(l.details.tmuxSession));
});
