/**
 * Shared tmux layout: pi/user region left, one full-height column per depth.
 * Both tools use live pane tags and normalize the layout after create/close.
 */
import { execFileSync } from "node:child_process";
import { columnLayout, formatLayout, leaves, parseLayout, userRegion, type LayoutCell, type PaneCell } from "./layout.ts";

function tmux(args: string[], timeout = 5000): string {
  return execFileSync("tmux", args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function piPaneId(): string {
  const pane = process.env.TMUX_PANE;
  if (!pane) throw new Error("TMUX_PANE not set — not running inside tmux.");
  return pane;
}

/** Column this process spawns into: one right of its own depth. */
export function workerDepth(): number {
  const tagged = Number.parseInt(tmux(["display-message", "-p", "-t", piPaneId(), "#{@pi_depth}"]), 10);
  return (tagged > 0 ? tagged : Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0) + 1;
}

type WindowPane = PaneCell & { depth?: number };
interface WindowState {
  layout: LayoutCell;
  panes: WindowPane[];
  active?: string;
}

/** One server queue snapshots the tree, tags and focus consistently. */
function readWindow(target: string): WindowState {
  const [encoded, ...lines] = tmux([
    "display-message", "-p", "-t", target, "#{window_layout}", ";",
    "list-panes", "-t", target, "-F", "#{pane_id}\t#{@pi_depth}\t#{pane_active}",
  ]).split("\n");
  const rows = lines.map((line) => line.split("\t"));
  const layout = parseLayout(encoded);
  const depths = new Map(rows.map(([id, depth]) => {
    const value = Number.parseInt(depth, 10);
    return [id, value > 0 ? value : undefined];
  }));
  return {
    layout,
    panes: leaves(layout).map((pane) => ({ ...pane, depth: depths.get(pane.paneId) }))
      .sort((a, b) => a.top - b.top || a.left - b.left),
    active: rows.find(([, , active]) => active === "1")?.[0],
  };
}

/** Worker panes in this process's column, top → bottom. */
export function listWorkerPanes(): string[] {
  const depth = workerDepth();
  return readWindow(piPaneId()).panes.filter((p) => p.depth === depth).map((p) => p.paneId);
}

export function isPaneAlive(paneId: string): boolean {
  try {
    return tmux(["list-panes", "-a", "-F", "#{pane_id}"]).split("\n").includes(paneId);
  } catch {
    return false;
  }
}

function regionWidth(panes: WindowPane[]): number | undefined {
  const workers = panes.filter((p) => p.depth !== undefined);
  return workers.length ? Math.min(...workers.map((p) => p.left)) - 1 : undefined;
}

function rebalance(target: string, before: WindowState): void {
  const after = readWindow(target);
  const workers = after.panes.filter((p) => p.depth !== undefined);
  const depths = [...new Set(workers.map((p) => p.depth!))].sort((a, b) => a - b);
  const columns = depths.map((depth) => workers.filter((p) => p.depth === depth).map((p) => p.paneId));
  const region = userRegion(before.layout, new Set(before.panes.filter((p) => p.depth !== undefined).map((p) => p.paneId)));
  const width = regionWidth(before.panes) ?? regionWidth(after.panes) ?? after.layout.width;
  const canonical = columnLayout(after.layout, region, width, columns);
  tmux(["select-layout", "-t", target, formatLayout(canonical)]);

  // tmux ignores serialized pane IDs. Reconcile its leaf order with ours;
  // using tree order also avoids pane-border-status coordinate offsets.
  const actual = leaves(parseLayout(tmux(["display-message", "-p", "-t", target, "#{window_layout}"]))).map((p) => p.paneId);
  const desired = leaves(canonical).map((p) => p.paneId);
  try {
    for (const [i, pane] of desired.entries()) {
      const j = actual.indexOf(pane);
      if (j < 0) throw new Error("Tmux panes changed while applying layout; retry the pane operation.");
      if (i === j) continue;
      tmux(["swap-pane", "-d", "-s", pane, "-t", actual[i]]);
      [actual[i], actual[j]] = [actual[j], actual[i]];
    }
  } finally {
    if (after.active) tmux(["select-pane", "-t", after.active]);
  }
}

/** All pi processes in a window mutate one layout; do not observe half-tagged splits. */
function withWindowLock<T>(target: string, fn: () => T): T {
  const window = tmux(["display-message", "-p", "-t", target, "#{window_id}"]);
  const deadline = Date.now() + 5000;
  const delay = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    // Nonblocking server-side compare-and-set. Timed-out wait-for clients
    // remain queued in tmux, so wait-for cannot provide crash-safe locks.
    const acquired = tmux(["if-shell", "-F", "-t", window, "#{==:#{@pi_layout_owner},}",
      `set-option -w -t ${window} @pi_layout_owner ${process.pid} ; display-message -p acquired`,
      "display-message -p busy"]);
    if (acquired === "acquired") break;
    const owner = tmux(["display-message", "-p", "-t", window, "#{@pi_layout_owner}"]);
    if (owner && !/^\d+$/.test(owner)) throw new Error("Invalid tmux layout lock owner.");
    const pid = Number(owner);
    let alive = pid > 0;
    if (alive) {
      try { process.kill(pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
    }
    if (!alive && owner) {
      tmux(["if-shell", "-F", "-t", window, `#{==:#{@pi_layout_owner},${owner}}`,
        `set-option -w -u -t ${window} @pi_layout_owner`]);
    }
    if (Date.now() >= deadline) throw new Error("Tmux layout is busy; retry the pane operation.");
    Atomics.wait(delay, 0, 0, 25);
  }
  try {
    return fn();
  } finally {
    try {
      tmux(["set-option", "-w", "-u", "-t", window, "@pi_layout_owner"]);
    } catch {
      // Closing the final pane also destroys its window.
    }
  }
}

export interface CreateWorkerPaneOptions {
  title?: string;
  tag?: { key: string; value: string };
  cwd?: string;
}

/** Create in the next depth column, then normalize every column's geometry. */
export function createWorkerPane(options: CreateWorkerPaneOptions = {}): string {
  const self = piPaneId();
  return withWindowLock(self, () => {
    const before = readWindow(self);
    const depth = workerDepth();
    const col = before.panes.filter((p) => p.depth === depth);
    const args = col.length > 0
      ? ["split-window", "-d", "-v", "-t", col[col.length - 1].paneId]
      : ["split-window", "-d", "-h", "-f", "-t", self];
    if (options.cwd) args.push("-c", options.cwd);
    args.push("-P", "-F", "#{pane_id}");
    const pane = tmux(args);
    if (!pane.startsWith("%")) throw new Error(`Unexpected tmux split-window output: ${pane}`);
    try {
      tmux(["set-option", "-p", "-t", pane, "@pi_depth", String(depth)]);
      tmux(["set-option", "-p", "-t", pane, "@pi_parent", self]);
      if (options.title) tmux(["select-pane", "-t", pane, "-T", options.title]);
      if (options.tag) tmux(["set-option", "-p", "-t", pane, options.tag.key, options.tag.value]);
      rebalance(pane, before);
      return pane;
    } catch (error) {
      tmux(["kill-pane", "-t", pane]);
      throw error;
    }
  });
}

/** Close a worker and normalize the remaining columns, including their widths. */
export function closeWorkerPane(paneId: string): void {
  withWindowLock(paneId, () => {
    const before = readWindow(paneId);
    const neighbor = before.panes.find((p) => p.paneId !== paneId);
    tmux(["kill-pane", "-t", paneId]);
    if (neighbor && regionWidth(before.panes) !== undefined) rebalance(neighbor.paneId, before);
  });
}
