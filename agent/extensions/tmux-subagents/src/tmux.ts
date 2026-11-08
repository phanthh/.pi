/**
 * tmux + sidecar primitives for subagents. Windows/sessions themselves come
 * from @pi-ext/tmux-windows; here only pane I/O by pane id (works across
 * sessions) and the exit/status sidecar polling.
 */
import { execFileSync, execSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { getNewEntries, lastSessionActivity } from "./session.ts";
import { liveSessionPid } from "./room.ts";
import { isPaneAlive } from "@pi-ext/tmux-windows";

let tmuxOnPath: boolean | null = null;

function hasTmux(): boolean {
  if (tmuxOnPath !== null) return tmuxOnPath;
  try {
    execSync("command -v tmux", { stdio: "ignore" });
    tmuxOnPath = true;
  } catch {
    tmuxOnPath = false;
  }
  return tmuxOnPath;
}

export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && !!process.env.TMUX_PANE && hasTmux();
}

export function tmuxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function tmux(args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8" });
}

export function sendEscape(surface: string): void {
  tmux(["send-keys", "-t", surface, "Escape"]);
}

export interface PollResult {
  reason: "done" | "error" | "closed";
  exitCode: number;
  errorMessage?: string;
  summary?: string;
  handedOverWindows?: string[];
}

/** Decode the `.exit` sidecar written by subagent_done / the child error path. */
export function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return {
    reason: "done", exitCode: 0,
    ...(typeof data?.summary === "string" && data.summary.trim() ? { summary: data.summary } : {}),
    handedOverWindows: Array.isArray(data?.handedOverWindows)
      ? data.handedOverWindows.filter((name: unknown): name is string => typeof name === "string")
      : [],
  };
}

function readExitSidecar(sessionFile: string): PollResult | null {
  try {
    const exitFile = `${sessionFile}.exit`;
    if (!existsSync(exitFile)) return null;
    const data = JSON.parse(readFileSync(exitFile, "utf8"));
    return interpretExitSidecar(data); // Retain until next launch; reload/crash must not lose completion.
  } catch {
    return null;
  }
}

/** Exit code from launch script; -1 means unknown (script/pane killed externally). */
export function readStatusSidecar(sessionFile: string): number {
  const file = `${sessionFile}.status`;
  try {
    const raw = readFileSync(file, "utf8").trim();
    return /^\d+$/.test(raw) ? Number(raw) : -1;
  } catch {
    return -1;
  }
}

export function silentDeath(sessionFile: string): string {
  let stderr = "(no stderr captured)";
  let fd: number | undefined;
  try {
    fd = openSync(`${sessionFile}.stderr`, "r");
    const size = fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, 65536));
    readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
    stderr = tail.toString("utf8").trimEnd().split("\n").slice(-30).join("\n") || stderr;
  } catch {} finally { if (fd !== undefined) closeSync(fd); }
  let activity = "Last session entry: unavailable.";
  try { activity = lastSessionActivity(getNewEntries(sessionFile, 0)); } catch {}
  return `No .exit sidecar. ${activity}\n\nLast stderr lines (up to 30):\n${stderr}`;
}

/**
 * Poll until the child exits: `.exit` sidecar, else `.status` (pi returned) or
 * dead pane plus no live session process. Shell/stderr descendants cannot hide a crash.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile: string;
    onTick?: () => void;
  },
): Promise<PollResult> {
  for (;;) {
    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");

    const sidecar = readExitSidecar(options.sessionFile);
    if (sidecar) return sidecar;

    if ((existsSync(`${options.sessionFile}.status`) || !isPaneAlive(surface)) && !liveSessionPid(options.sessionFile)) {
      const late = readExitSidecar(options.sessionFile);
      if (late) return late;
      const exitCode = readStatusSidecar(options.sessionFile);
      return { reason: "closed", exitCode, summary: `Sub-agent ended without an exit sidecar (exit code ${exitCode}${exitCode === -1 ? "; unknown" : ""}).\n${silentDeath(options.sessionFile)}` };
    }

    options.onTick?.();

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
