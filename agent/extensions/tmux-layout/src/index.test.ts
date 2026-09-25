// Live check against a scratch detached tmux session: `pnpm --filter @pi-ext/tmux-layout test`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeWorkerPane, createWorkerPane } from "./index.ts";

const tmux = (...args: string[]) => execFileSync("tmux", args, { encoding: "utf8" }).trim();
const session = `pi-layout-test-${process.pid}`;
const root = tmux("new-session", "-d", "-s", session, "-x", "201", "-y", "50", "-P", "-F", "#{pane_id}");

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

try {
  // User's own split in the pi region: must never be stacked onto or resized.
  const userPane = tmux("split-window", "-d", "-v", "-t", root, "-P", "-F", "#{pane_id}");
  const userHeight = geo(userPane).height;

  as(root);
  const reviewer = createWorkerPane({ title: "reviewer" });
  const worker = createWorkerPane({ title: "worker" });
  assert.equal(geo(reviewer).depth, "1");
  assert.equal(geo(worker).left, geo(reviewer).left, "depth-1 panes share a column");
  assert.ok(geo(worker).top > geo(reviewer).top, "stacked below");
  assert.ok(geo(reviewer).left > geo(root).left, "right of pi");
  assert.equal(geo(userPane).height, userHeight, "untagged pane untouched");
  const piWidth = geo(root).width;

  as(reviewer, 1);
  const scout1 = createWorkerPane({ title: "scout1" });
  const scout2 = createWorkerPane({ title: "scout2" });
  assert.equal(geo(scout1).depth, "2");
  assert.ok(geo(scout1).left > geo(reviewer).left, "grandchild right of spawner");
  assert.equal(geo(scout2).left, geo(scout1).left);
  assert.equal(geo(scout1).top, 0, "depth column is full height");
  assert.equal(geo(root).width, piWidth, "pi keeps its width when a column is added");
  assert.ok(Math.abs(geo(reviewer).width - geo(scout1).width) <= 1, "worker columns share width");

  // Root spawns again after the depth-2 column exists: lands in column 1, not next to scouts.
  as(root);
  const late = createWorkerPane({ title: "late" });
  assert.equal(geo(late).left, geo(reviewer).left);
  assert.equal(geo(late).width, geo(reviewer).width);

  closeWorkerPane(scout1);
  assert.equal(geo(scout2).top, 0, "column rebalanced after close");
  console.log("tmux-layout ok");
} finally {
  tmux("kill-session", "-t", session);
}
