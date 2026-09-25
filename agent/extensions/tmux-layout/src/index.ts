/**
 * Shared tmux worker-pane layout for pi extensions (tmux tool + tmux-subagents).
 *
 * Convention: one full-height column per spawn depth, left → right.
 *
 *   | pi (+ your own panes) | depth 1 | depth 2 |
 *
 * Root pi (PI_SUBAGENT_DEPTH unset) puts its panes (subagents + tmux tool
 * panes) in the depth-1 column; a depth-1 subagent puts its panes in the
 * depth-2 column, and so on. So a spawned pane is always right of its spawner.
 * Each column stacks vertically and is rebalanced to equal heights; worker
 * columns share the space right of the pi region equally.
 *
 * Only panes tagged `@pi_depth` count as workers — untagged panes (pi itself,
 * editors you split yourself) are never stacked onto or resized.
 *
 * Stateless: every decision comes from querying the live window, so all pi
 * processes in the window share one view of the world.
 */
import { execFileSync } from "node:child_process";

function tmux(args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8" });
}

export function piPaneId(): string {
  const pane = process.env.TMUX_PANE;
  if (!pane) throw new Error("TMUX_PANE not set — not running inside tmux.");
  return pane;
}

/** Column this process spawns into: one right of its own depth. */
export function workerDepth(): number {
  return (Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0) + 1;
}

interface WindowPane {
  paneId: string;
  top: number;
  left: number;
  width: number;
  /** `@pi_depth` tag; undefined for untagged (non-worker) panes. */
  depth?: number;
}

function listWindowPanes(target: string): WindowPane[] {
  const out = tmux([
    "list-panes",
    "-t",
    target,
    "-F",
    "#{pane_id}\t#{pane_top}\t#{pane_left}\t#{pane_width}\t#{@pi_depth}",
  ]);
  const panes: WindowPane[] = [];
  for (const line of out.trim().split("\n")) {
    if (!line.trim()) continue;
    const [paneId, top, left, width, depth] = line.split("\t");
    const d = Number.parseInt(depth, 10);
    panes.push({
      paneId,
      top: Number(top) || 0,
      left: Number(left) || 0,
      width: Number(width) || 0,
      depth: Number.isFinite(d) && d > 0 ? d : undefined,
    });
  }
  return panes.sort((a, b) => a.top - b.top || a.left - b.left);
}

function column(panes: WindowPane[], depth: number): WindowPane[] {
  return panes.filter((p) => p.depth === depth);
}

/** Worker columns (top pane of each), ordered left → right. */
function columnHeads(panes: WindowPane[]): WindowPane[] {
  const heads = new Map<number, WindowPane>();
  for (const p of panes) if (p.depth !== undefined && !heads.has(p.depth)) heads.set(p.depth, p);
  return [...heads.values()].sort((a, b) => a.left - b.left);
}

/** Worker panes in this process's column, top → bottom. */
export function listWorkerPanes(): string[] {
  return column(listWindowPanes(piPaneId()), workerDepth()).map((p) => p.paneId);
}

export function isPaneAlive(paneId: string): boolean {
  try {
    return tmux(["list-panes", "-a", "-F", "#{pane_id}"]).split("\n").includes(paneId);
  } catch {
    return false;
  }
}

/** Equalize heights within one column. Columns are full-height, so % of window works. */
function rebalanceColumn(target: string, depth: number): void {
  try {
    const col = column(listWindowPanes(target), depth);
    if (col.length < 2) return;
    const pct = Math.floor(100 / col.length);
    for (const p of col.slice(0, -1)) tmux(["resize-pane", "-t", p.paneId, "-y", `${pct}%`]);
  } catch {
    // Cosmetic only.
  }
}

/**
 * `split -h -f` shrinks every column (pi included) to make room. Restore the
 * pi region to `piRegionWidth`, then share the rest equally among worker
 * columns. resize-pane moves a cell's right border, so go left → right.
 */
function rebalanceColumnWidths(target: string, piRegionWidth: number): void {
  try {
    const panes = listWindowPanes(target);
    const heads = columnHeads(panes);
    if (heads.length < 2) return;
    const edge = heads[0].left - 1;
    const piNeighbor = panes.find((p) => p.depth === undefined && p.left + p.width === edge);
    if (piNeighbor) {
      tmux(["resize-pane", "-t", piNeighbor.paneId, "-x", String(piNeighbor.width + piRegionWidth - edge)]);
    }
    const windowWidth = Number(tmux(["display-message", "-p", "-t", target, "#{window_width}"]).trim());
    const each = Math.floor((windowWidth - piRegionWidth - 1 - (heads.length - 1)) / heads.length);
    if (each < 1) return;
    for (const head of heads.slice(0, -1)) tmux(["resize-pane", "-t", head.paneId, "-x", String(each)]);
  } catch {
    // Cosmetic only.
  }
}

export interface CreateWorkerPaneOptions {
  /** Pane title (shown in tmux borders). */
  title?: string;
  /** tmux pane user option tag, e.g. { key: "@pi_name", value: "server" }. */
  tag?: { key: string; value: string };
  cwd?: string;
}

/**
 * Create a worker pane in this process's depth column: stack below the
 * column's bottom pane, or open the column as a new full-height pane on the
 * window's right edge.
 */
export function createWorkerPane(options: CreateWorkerPaneOptions = {}): string {
  const self = piPaneId();
  const depth = workerDepth();
  const panes = listWindowPanes(self);
  const col = column(panes, depth);
  const heads = columnHeads(panes);
  const piRegionWidth = heads.length > 0 ? heads[0].left - 1 : null;

  const args = col.length > 0
    ? ["split-window", "-d", "-v", "-t", col[col.length - 1].paneId]
    : ["split-window", "-d", "-h", "-f", "-t", self];
  if (options.cwd) args.push("-c", options.cwd);
  args.push("-P", "-F", "#{pane_id}");

  const pane = tmux(args).trim();
  if (!pane.startsWith("%")) throw new Error(`Unexpected tmux split-window output: ${pane}`);

  tmux(["set-option", "-p", "-t", pane, "@pi_depth", String(depth)]);
  try {
    tmux(["set-option", "-p", "-t", pane, "@pi_parent", self]);
    if (options.title) tmux(["select-pane", "-t", pane, "-T", options.title]);
    if (options.tag) tmux(["set-option", "-p", "-t", pane, options.tag.key, options.tag.value]);
  } catch {
    // Cosmetic only.
  }

  if (col.length === 0 && piRegionWidth !== null) rebalanceColumnWidths(pane, piRegionWidth);
  rebalanceColumn(pane, depth);
  return pane;
}

/** Kill a worker pane and rebalance the column it was in. */
export function closeWorkerPane(paneId: string): void {
  const panes = listWindowPanes(paneId);
  const depth = panes.find((p) => p.paneId === paneId)?.depth;
  const neighbor = depth === undefined ? undefined : column(panes, depth).find((p) => p.paneId !== paneId);
  tmux(["kill-pane", "-t", paneId]);
  if (neighbor && depth !== undefined) rebalanceColumn(neighbor.paneId, depth);
}
