/**
 * Shared tmux worker-pane layout for pi extensions (tmux tool + tmux-subagents).
 *
 * Convention: pi (orchestrator) stays on the left. All worker panes — tool
 * panes and subagent panes alike — live in a single column on the right,
 * stacked vertically and rebalanced to equal heights on create/close.
 *
 * Stateless: layout decisions come from querying the live window, so both
 * extensions share one view of the world.
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

interface WindowPane {
  paneId: string;
  top: number;
  left: number;
}

/** All panes in pi's window, sorted top-to-bottom then left-to-right. */
function listWindowPanes(): WindowPane[] {
  const out = tmux([
    "list-panes",
    "-t",
    piPaneId(),
    "-F",
    "#{pane_id}\t#{pane_top}\t#{pane_left}",
  ]);
  const panes: WindowPane[] = [];
  for (const line of out.trim().split("\n")) {
    if (!line.trim()) continue;
    const [paneId, top, left] = line.split("\t");
    panes.push({ paneId, top: Number(top) || 0, left: Number(left) || 0 });
  }
  panes.sort((a, b) => a.top - b.top || a.left - b.left);
  return panes;
}

/** Worker panes = everything except pi's own pane. */
export function listWorkerPanes(): string[] {
  const self = piPaneId();
  return listWindowPanes()
    .filter((p) => p.paneId !== self)
    .map((p) => p.paneId);
}

export function isPaneAlive(paneId: string): boolean {
  try {
    return tmux(["list-panes", "-a", "-F", "#{pane_id}"]).split("\n").includes(paneId);
  } catch {
    return false;
  }
}

/** Equalize worker-column heights. No-op with fewer than 2 workers. */
export function rebalanceWorkers(): void {
  try {
    const workers = listWorkerPanes();
    if (workers.length < 2) return;
    const pct = Math.floor(100 / workers.length);
    for (const pane of workers.slice(0, -1)) {
      tmux(["resize-pane", "-t", pane, "-y", `${pct}%`]);
    }
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
 * Create a worker pane following the convention: first worker splits right
 * from pi, later workers stack below the bottom-most worker. Column is
 * rebalanced afterwards.
 */
export function createWorkerPane(options: CreateWorkerPaneOptions = {}): string {
  const workers = listWorkerPanes();
  const stackBelow = workers.length > 0 ? workers[workers.length - 1] : null;
  const target = stackBelow ?? piPaneId();

  const args = ["split-window", "-d", stackBelow ? "-v" : "-h", "-t", target];
  if (options.cwd) args.push("-c", options.cwd);
  args.push("-P", "-F", "#{pane_id}");

  const pane = tmux(args).trim();
  if (!pane.startsWith("%")) throw new Error(`Unexpected tmux split-window output: ${pane}`);

  try {
    if (options.title) tmux(["select-pane", "-t", pane, "-T", options.title]);
    if (options.tag) tmux(["set-option", "-p", "-t", pane, options.tag.key, options.tag.value]);
  } catch {
    // Cosmetic only.
  }

  rebalanceWorkers();
  return pane;
}

/** Kill a worker pane and rebalance the column. */
export function closeWorkerPane(paneId: string): void {
  tmux(["kill-pane", "-t", paneId]);
  rebalanceWorkers();
}
