/**
 * tmux + sidecar primitives for subagents. Windows/sessions themselves come
 * from @pi-ext/tmux-windows; here only pane I/O by pane id (works across
 * sessions) and the exit/ping/status sidecar polling.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
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

/**
 * Paste text into a pane and submit it (used to talk to a live child pi session).
 * Buffer arrives over stdin so the tmux server never needs to see a file path.
 * -p wraps the paste in bracketed-paste markers (pi enables mode 2004), so
 * embedded newlines stay in the editor instead of acting as Enter and
 * submitting only the first line.
 */
export function sendText(surface: string, text: string): void {
  execFileSync("tmux", ["load-buffer", "-b", "pi-subagent", "-"], { input: text, encoding: "utf8" });
  tmux(["paste-buffer", "-p", "-d", "-b", "pi-subagent", "-t", surface]);
  tmux(["send-keys", "-t", surface, "Enter"]);
}

export interface PollResult {
  reason: "done" | "ping" | "error" | "closed";
  exitCode: number;
  ping?: { name: string; message: string };
  errorMessage?: string;
}

/** Decode the `.exit` sidecar written by subagent_done / the child error path. */
export function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "ping") {
    return { reason: "ping", exitCode: 0, ping: { name: data.name, message: data.message } };
  }
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

function readExitSidecar(sessionFile: string): PollResult | null {
  try {
    const exitFile = `${sessionFile}.exit`;
    if (!existsSync(exitFile)) return null;
    const data = JSON.parse(readFileSync(exitFile, "utf8"));
    rmSync(exitFile, { force: true });
    return interpretExitSidecar(data);
  } catch {
    return null;
  }
}

/** Non-terminal `.ping` sidecar from caller_ping; consumed once. */
function readPingSidecar(sessionFile: string): { name: string; message: string } | null {
  try {
    const pingFile = `${sessionFile}.ping`;
    if (!existsSync(pingFile)) return null;
    const data = JSON.parse(readFileSync(pingFile, "utf8"));
    rmSync(pingFile, { force: true });
    return { name: String(data?.name ?? "subagent"), message: String(data?.message ?? "") };
  } catch {
    return null;
  }
}

/** Exit code the launch script wrote after pi returned; 0 when absent (killed from outside). */
export function readStatusSidecar(sessionFile: string): number {
  const file = `${sessionFile}.status`;
  try {
    const raw = readFileSync(file, "utf8").trim();
    rmSync(file, { force: true });
    return /^\d+$/.test(raw) ? Number(raw) : 0;
  } catch {
    return 0;
  }
}

/**
 * Poll until the child exits: `.exit` sidecar (clean exits), else pane gone,
 * with the script's `.status` exit code telling a crash from a plain quit.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile: string;
    onTick?: () => void;
    onPing?: (ping: { name: string; message: string }) => void;
  },
): Promise<PollResult> {
  for (;;) {
    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");

    const ping = readPingSidecar(options.sessionFile);
    if (ping) options.onPing?.(ping);

    const sidecar = readExitSidecar(options.sessionFile);
    if (sidecar) return sidecar;

    if (!isPaneAlive(surface)) {
      const late = readExitSidecar(options.sessionFile);
      if (late) return late;
      return { reason: "closed", exitCode: readStatusSidecar(options.sessionFile) };
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
