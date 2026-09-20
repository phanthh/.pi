/**
 * tmux surface primitives for subagent panes.
 *
 * A "surface" is a tmux pane id (`%12`). Layout comes from the shared
 * lib/tmux-layout convention: pi left, all worker panes (tool + subagent)
 * stacked in one right column, rebalanced on create/close.
 */
import { execFile, execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  closeWorkerPane,
  createWorkerPane,
  isPaneAlive as layoutIsPaneAlive,
} from "@pi-ext/tmux-layout";

const execFileAsync = promisify(execFile);

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
  return !!process.env.TMUX && hasTmux();
}

export function tmuxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function isFishShell(): boolean {
  return basename(process.env.SHELL ?? "") === "fish";
}

function tmux(args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8" });
}

export function isPaneAlive(surface: string): boolean {
  return layoutIsPaneAlive(surface);
}

export function createSurface(name: string): string {
  if (!isTmuxAvailable()) throw new Error(`tmux not available. ${tmuxSetupHint()}`);
  return createWorkerPane({ title: name, tag: { key: "@pi_subagent", value: name } });
}

export function sendCommand(surface: string, command: string): void {
  tmux(["send-keys", "-t", surface, "-l", command]);
  tmux(["send-keys", "-t", surface, "Enter"]);
}

export function sendEscape(surface: string): void {
  tmux(["send-keys", "-t", surface, "Escape"]);
}

/**
 * Paste text into a pane and submit it (used to talk to a live child pi session).
 * Buffer arrives over stdin so the tmux server never needs to see a file path.
 */
export function sendText(surface: string, text: string): void {
  execFileSync("tmux", ["load-buffer", "-b", "pi-subagent", "-"], { input: text, encoding: "utf8" });
  tmux(["paste-buffer", "-d", "-b", "pi-subagent", "-t", surface]);
  tmux(["send-keys", "-t", surface, "Enter"]);
}

/**
 * Send a long command by writing it to a script first — sending it verbatim
 * breaks on pane-width line wrapping.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(tmpdir(), "pi-subagent-scripts", `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`);
  mkdirSync(dirname(scriptPath), { recursive: true });

  const parts = ["#!/bin/bash"];
  if (options?.scriptPreamble) parts.push(options.scriptPreamble.trimEnd());
  parts.push(command);
  writeFileSync(scriptPath, parts.join("\n") + "\n", { mode: 0o755 });

  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

export function readScreen(surface: string, lines = 50): string {
  return tmux(["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`]);
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

export function closeSurface(surface: string): void {
  closeWorkerPane(surface);
}

export interface PollResult {
  reason: "done" | "ping" | "sentinel" | "error" | "closed";
  exitCode: number;
  ping?: { name: string; message: string };
  errorMessage?: string;
}

/** Decode the `.exit` sidecar written by subagent_done / caller_ping / the child error path. */
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

function readExitSidecar(sessionFile?: string): PollResult | null {
  if (!sessionFile) return null;
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

/**
 * Poll until the child exits: `.exit` sidecar first (clean exits), then the
 * shell sentinel echoed in the pane (crashes), then pane death (user killed it).
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: { interval: number; sessionFile?: string; onTick?: (elapsed: number) => void },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");

    const sidecar = readExitSidecar(options.sessionFile);
    if (sidecar) return sidecar;

    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) return { reason: "sentinel", exitCode: Number.parseInt(match[1], 10) };
    } catch {
      const late = readExitSidecar(options.sessionFile);
      if (late) return late;
      if (!isPaneAlive(surface)) return { reason: "closed", exitCode: 0 };
    }

    options.onTick?.(Math.floor((Date.now() - start) / 1000));

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
