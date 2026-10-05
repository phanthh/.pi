// Live check against an isolated tmux server: `pnpm --filter @pi-ext/tmux-layout test`.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { closeWorkerPane, createWorkerPane } from "./index.ts";

const server = `pi-layout-test-${process.pid}`;
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", server, "-f", "/dev/null", ...args], { encoding: "utf8" }).trim();
const root = tmux("new-session", "-d", "-s", "layout", "-x", "201", "-y", "50", "-P", "-F", "#{pane_id}");
const originalEnv = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, PI_SUBAGENT_DEPTH: process.env.PI_SUBAGENT_DEPTH };
process.env.TMUX = `${tmux("display-message", "-p", "-t", root, "#{socket_path}")},0,0`;

const as = (pane: string, depth?: number) => {
  process.env.TMUX_PANE = pane;
  if (depth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
  else process.env.PI_SUBAGENT_DEPTH = String(depth);
};
const geo = (pane: string) => {
  const [left, top, width, height, depth] = tmux(
    "display-message", "-p", "-t", pane, "#{pane_left} #{pane_top} #{pane_width} #{pane_height} #{@pi_depth}",
  ).split(" ");
  return { left: +left, top: +top, width: +width, height: +height, depth };
};

async function spawnWorker(): Promise<string> {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "-e",
    `import { createWorkerPane } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)}; console.log(createWorkerPane());`,
  ], { env: process.env });
  return stdout.trim();
}

try {
  // User's own split in the pi region: must never be stacked onto or resized.
  const userPane = tmux("split-window", "-d", "-v", "-t", root, "-P", "-F", "#{pane_id}");
  const userHeight = geo(userPane).height;
  const userSide = tmux("split-window", "-d", "-h", "-l", "33%", "-t", root, "-P", "-F", "#{pane_id}");

  as(root);
  const reviewer = createWorkerPane({ title: "reviewer" });
  const worker = createWorkerPane({ title: "worker" });
  assert.equal(geo(reviewer).depth, "1");
  assert.equal(geo(worker).left, geo(reviewer).left, "depth-1 panes share a column");
  assert.ok(geo(worker).top > geo(reviewer).top, "stacked below");
  assert.ok(geo(reviewer).left > geo(root).left, "right of pi");
  assert.equal(geo(userPane).height, userHeight, "untagged pane untouched");
  const piWidth = geo(root).width;
  const userSideWidth = geo(userSide).width;

  as(reviewer, 1);
  const scout1 = createWorkerPane({ title: "scout1" });
  const scout2 = createWorkerPane({ title: "scout2" });
  assert.equal(geo(scout1).depth, "2");
  assert.ok(geo(scout1).left > geo(reviewer).left, "grandchild right of spawner");
  assert.equal(geo(scout2).left, geo(scout1).left);
  assert.equal(geo(scout1).top, 0, "depth column is full height");
  assert.equal(geo(root).width, piWidth, "pi keeps its width when a column is added");
  assert.equal(geo(userSide).width, userSideWidth, "user horizontal split keeps its width");
  assert.ok(Math.abs(geo(reviewer).width - geo(scout1).width) <= 1, "worker columns share width");

  // Root spawns again after the depth-2 column exists: lands in column 1, not next to scouts.
  as(root);
  const late = createWorkerPane({ title: "late" });
  assert.equal(geo(late).left, geo(reviewer).left);
  assert.equal(geo(late).width, geo(reviewer).width);

  closeWorkerPane(scout1);
  assert.equal(geo(scout2).top, 0, "column rebalanced after close");

  // A detached shell can outlive its parent: recreating depth 1 must put it
  // before the surviving depth-2 column, not on the window's right edge.
  closeWorkerPane(reviewer);
  closeWorkerPane(worker);
  closeWorkerPane(late);
  as(root);
  const replacement = createWorkerPane({ title: "replacement" });
  assert.ok(geo(replacement).left < geo(scout2).left, "recreated shallow column precedes deeper columns");

  // Pane tags remain authoritative even when a resumed process lacks depth env.
  as(replacement);
  const resumedChild = createWorkerPane({ title: "resumed child" });
  assert.equal(geo(resumedChild).depth, "2", "pane depth survives missing process env");
  assert.equal(geo(resumedChild).left, geo(scout2).left, "both tools use the same depth column");

  // Width balancing must not depend on the nesting left by split-window.
  as(scout2, 2);
  const deepest = createWorkerPane({ title: "depth3" });
  assert.ok(geo(deepest).left > geo(scout2).left);
  assert.ok(Math.max(...[replacement, scout2, deepest].map((p) => geo(p).width)) -
    Math.min(...[replacement, scout2, deepest].map((p) => geo(p).width)) <= 1, "three columns share width");
  as(root);
  const siblings = [replacement, ...Array.from({ length: 4 }, () => createWorkerPane())];
  assert.ok(Math.max(...siblings.map((p) => geo(p).height)) -
    Math.min(...siblings.map((p) => geo(p).height)) <= 1, "five siblings share height");
  assert.equal(geo(userPane).height, userHeight, "user split height is preserved");

  closeWorkerPane(deepest);
  assert.ok(Math.abs(geo(replacement).width - geo(scout2).width) <= 1, "remaining columns rebalance on close");
  assert.equal(geo(root).width, piWidth, "pi width survives column removal/recreation");
  assert.equal(geo(userSide).width, userSideWidth, "user horizontal split survives column removal/recreation");
  assert.equal(tmux("display-message", "-p", "-t", root, "#{pane_active}"), "1", "root remains active after identity swaps");

  for (const pane of [...siblings, scout2, resumedChild]) closeWorkerPane(pane);
  assert.equal(geo(root).width + geo(userSide).width + 1, 201, "final worker close restores full user region");
  assert.equal(geo(userPane).height, userHeight);

  // Different pi processes must not see a split before its depth tag is set.
  as(root);
  const concurrent = await Promise.all(Array.from({ length: 5 }, spawnWorker));
  assert.equal(new Set(concurrent.map((p) => geo(p).left)).size, 1, "concurrent spawns share one depth column");
  assert.ok(Math.max(...concurrent.map((p) => geo(p).height)) -
    Math.min(...concurrent.map((p) => geo(p).height)) <= 1, "concurrent siblings share height");
  for (const pane of concurrent) closeWorkerPane(pane);

  // Border-status changes pane offsets relative to layout-cell offsets.
  tmux("set-option", "-w", "-t", root, "pane-border-status", "top");
  as(root);
  const borderedParent = createWorkerPane();
  as(borderedParent, 1);
  const borderedChild = createWorkerPane();
  closeWorkerPane(borderedParent);
  as(root);
  const borderedReplacement = createWorkerPane();
  assert.ok(geo(borderedReplacement).left < geo(borderedChild).left, "depth order survives pane border status");
  closeWorkerPane(borderedChild);
  closeWorkerPane(borderedReplacement);

  tmux("set-option", "-w", "-t", root, "pane-border-status", "off");
  as(root);
  const focused = createWorkerPane();
  tmux("split-window", "-d", "-h", "-t", focused);
  tmux("select-pane", "-t", focused);
  as(focused, 1);
  const focusedChild = createWorkerPane();
  assert.equal(tmux("display-message", "-p", "-t", focused, "#{pane_active}"), "1", "active worker stays active when it is a swap destination");
  closeWorkerPane(focusedChild);
  closeWorkerPane(focused);

  const narrowRoot = tmux("new-session", "-d", "-s", "narrow", "-x", "201", "-y", "50", "-P", "-F", "#{pane_id}");
  const wideUser = tmux("split-window", "-d", "-h", "-l", "199", "-t", narrowRoot, "-P", "-F", "#{pane_id}");
  as(narrowRoot);
  const narrowWorker = createWorkerPane();
  assert.equal(geo(narrowRoot).width, 1, "one-cell user split retains its minimum width");
  assert.equal(geo(wideUser).width, 98, "remaining user space is allocated without rejecting a valid layout");
  closeWorkerPane(narrowWorker);

  // A dead owner must not freeze surviving pi processes indefinitely.
  const window = tmux("display-message", "-p", "-t", narrowRoot, "#{window_id}");
  const deadPid = execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).trim();
  tmux("set-option", "-w", "-t", window, "@pi_layout_owner", deadPid);
  const recovered = await Promise.all(Array.from({ length: 3 }, spawnWorker));
  assert.equal(new Set(recovered.map((p) => geo(p).left)).size, 1, "concurrent dead-owner recovery preserves one column");
  for (const pane of recovered) closeWorkerPane(pane);
  assert.equal(tmux("display-message", "-p", "-t", window, "#{@pi_layout_owner}"), "", "recovered lock is released");
  console.log("tmux-layout ok");
} finally {
  tmux("kill-server");
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
