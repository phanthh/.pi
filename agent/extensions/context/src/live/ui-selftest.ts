/** Run: node --experimental-strip-types src/live/ui-selftest.ts */
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { applyConfig, DEFAULT_CONFIG } from "../config.ts";
import type { OmRuntime } from "../om.ts";
import { getContextArgumentCompletions, parseContextCommand } from "../view/command.ts";
import { DEFAULT_CONFIG as VIEW_CONFIG } from "../view/config.ts";
import { registerContextView } from "../view/index.ts";
import { buildSnapshot } from "../view/model.ts";
import { UsageView, type UsageViewInput } from "../view/ui/usage-view.ts";
import { computeUsage } from "../view/usage.ts";
import type { LiveContextRuntime, LiveContextStatus } from "./index.ts";

assert.equal(DEFAULT_CONFIG.liveContext.mode, "off");
for (const mode of ["off", "main", "all"] as const) {
  const config = applyConfig(DEFAULT_CONFIG, { liveContext: { mode, ignored: true } });
  assert.equal(config.liveContext.mode, mode);
  assert.equal(config.observeAfterTokens, DEFAULT_CONFIG.observeAfterTokens);
  assert.equal(config.sessionFallback, DEFAULT_CONFIG.sessionFallback);
}
const mainConfig = applyConfig(DEFAULT_CONFIG, { liveContext: { mode: "main" } });
for (const value of [null, false, "all", [], { mode: "on" }, { mode: null }, {}]) {
  assert.equal(applyConfig(mainConfig, { liveContext: value }).liveContext.mode, "main");
}
const independent = applyConfig(DEFAULT_CONFIG, {});
independent.liveContext.mode = "all";
assert.equal(DEFAULT_CONFIG.liveContext.mode, "off", "config results do not mutate nested defaults");
assert.equal(applyConfig(mainConfig, { observeAfterTokens: 1 }).observeAfterTokens, 2_000);

assert.deepEqual(parseContextCommand("live"), { type: "live", action: "status" });
for (const action of ["on", "off", "status", "revisions"] as const) {
  assert.deepEqual(parseContextCommand(`  LIVE   ${action.toUpperCase()}  `), { type: "live", action });
}
for (const args of ["live apply", "live on extra", "live status on", "usage live", "settings on"]) {
  assert.equal(parseContextCommand(args).type, "invalid");
}
assert.deepEqual(parseContextCommand(""), { type: "view", view: "usage" });
assert.deepEqual(parseContextCommand("injections"), { type: "view", view: "injections" });
assert.deepEqual(parseContextCommand("settings"), { type: "om", action: "settings" });
assert.deepEqual(parseContextCommand("reload"), { type: "om", action: "reload" });
assert.deepEqual(parseContextCommand("config"), { type: "config" });
assert.deepEqual(getContextArgumentCompletions("live ")?.map((item) => item.value), ["live on", "live off", "live status", "live revisions"]);
assert.deepEqual(getContextArgumentCompletions(" LIVE   O")?.map((item) => item.value), ["live on", "live off"]);
assert.equal(getContextArgumentCompletions("live apply"), null);

const gauge = { current: 0, limit: 1 };
const input: UsageViewInput = {
  usage: computeUsage({ snapshot: buildSnapshot([], "real-turn", new Date(0)), messages: [] }),
  compactionCount: 2,
  memory: {
    activeObservations: 0, totalObservations: 0, reflections: 0, tombstones: 0,
    observer: gauge, reflector: gauge, dropper: gauge, observationPool: gauge, dropperPressure: gauge,
  },
  categoryColors: VIEW_CONFIG.categoryColors,
};
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const status: LiveContextStatus = {
  enabled: true, available: true, edits: 3,
  path: "/tmp/mirror\u001b]0;untrusted title\u0007.txt",
  lastResult: "Accepted\n3 edits\u001b[2J",
  error: "Rejected\rprotected text\u0000",
};
for (const width of [1, 20, 40, 80, 160]) {
  for (const rows of [1, 8, 16, 24, 40]) {
    const view = new UsageView(theme, { ...input, liveContext: status }, () => {}, () => rows);
    const lines = view.render(width);
    assert.ok(lines.length <= rows, `${width}x${rows} height fits`);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}x${rows} width fits`);
    assert.ok(lines.every((line) => !/[\u0000\r\n]/.test(line)), "dynamic text is sanitized inline");
    assert.ok(lines.filter((line) => /Live Context:|File:|Last result:|Error:/.test(line))
      .every((line) => !line.replaceAll("\u001b[0m", "").includes("\u001b")), "only trusted truncation resets remain");
    assert.ok(!lines.join("").includes("untrusted title"));
    if (width >= 40 && rows >= 16) assert.match(lines.join("\n"), /Live Context: on · 3 edits/);
    if (width >= 80 && rows >= 24) {
      assert.match(lines.join("\n"), /File: \/tmp\/mirror.txt/);
      assert.match(lines.join("\n"), /Last result: Accepted 3 edits/);
      assert.match(lines.join("\n"), /Error: Rejected protected text/);
    }
  }
}
const absent = new UsageView(theme, input, () => {}, () => 40).render(80).join("\n");
assert.doesNotMatch(absent, /Live Context/);
assert.match(absent, /Compactions: 2/);
const disabled = new UsageView(theme, {
  ...input, liveContext: { enabled: false, available: false, edits: 0 },
}, () => {}, () => 40).render(80).join("\n");
assert.match(disabled, /Live Context: off · 0 edits · unavailable/);

let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
const pi = {
  events: { on: () => {} },
  on: () => {},
  registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
} as unknown as ExtensionAPI;
const notifications: string[] = [];
const ctx = {
  mode: "tui", hasUI: true,
  ui: { notify: (message: string) => notifications.push(message) },
} as unknown as ExtensionCommandContext;
let enabled = false;
let statusCalls = 0;
let liveReloads = 0;
let omReloads = 0;
const changes: boolean[] = [];
const live: LiveContextRuntime = {
  instructions: () => undefined,
  revisions: () => "/tmp/revisions.md",
  status: (context) => {
    assert.equal(context, ctx);
    statusCalls++;
    return { enabled, available: true, edits: 0, lastResult: "ready\u001b[2J\nnow" };
  },
  reload: (context) => { assert.equal(context, ctx); liveReloads++; },
  setEnabled: (value, context) => { assert.equal(context, ctx); changes.push(value); enabled = value; },
};
const om = { reload: () => { omReloads++; return DEFAULT_CONFIG; } } as unknown as OmRuntime;
registerContextView(pi, om, live);
assert.ok(handler);
await handler("live on", ctx);
await handler("live status", ctx);
await handler("live off", ctx);
await handler("live", ctx);
await handler("live revisions", ctx);
assert.match(notifications.at(-1)!, /revisions\.md/);
assert.deepEqual(changes, [true, false], "controls delegate branch override to runtime, status does not mutate");
assert.equal(statusCalls, 4);
assert.match(notifications[0], /live on/);
assert.match(notifications[2], /live off/);
assert.ok(notifications.every((message) => !/[\u001b\r\n]/.test(message)));
await handler("reload", ctx);
assert.equal(omReloads, 1);
assert.equal(liveReloads, 1);
registerContextView(pi, om);
assert.ok(handler);
await handler("live on", ctx);
assert.match(notifications.at(-1)!, /runtime unavailable/);
assert.deepEqual(changes, [true, false]);
console.log("context live UI selftest: ok");
