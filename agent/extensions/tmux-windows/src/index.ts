/**
 * Shared tmux helpers: every pi process owns windows in its own session and,
 * for lead children, whole sessions. Ownership lives in tmux user options so
 * cleanup never depends on in-memory state:
 *   window  @pi_owner=<creator TMUX_PANE> + caller tag (@pi_subagent / @pi_name)
 *   session @pi_session_owner=<creator TMUX_PANE>
 * Session and window options use different keys: `#{@x}` lookups fall back
 * from window to session, which would make every window of a lead session
 * look owned by the lead's spawner.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmux(args: string[], timeout = 5000): string {
  return execFileSync("tmux", args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Serialize run-name allocation across pi processes. flock shares the inherited
 * open-file description, so the parent fd holds the lock after flock exits.
 * Closing it (including on process death) releases the lock; never unlink the
 * file while another process may be waiting on that inode.
 */
function withRunNameLock<T>(owner: string, action: () => T): T {
  const server = (process.env.TMUX ?? "").split(",").slice(0, 2).join(",");
  const key = createHash("sha256").update(`${server}:${owner}`).digest("hex").slice(0, 24);
  const fd = openSync(join(tmpdir(), `pi-tmux-names-${process.getuid?.() ?? "user"}-${key}.lock`), "a", 0o600);
  try {
    execFileSync("flock", ["-x", "-w", "5", "3"], { timeout: 6000, stdio: ["ignore", "pipe", "pipe", fd] });
    return action();
  } finally {
    closeSync(fd);
  }
}

export function selfPane(): string {
  const pane = process.env.TMUX_PANE;
  if (!pane) throw new Error("TMUX_PANE not set — not running inside tmux.");
  return pane;
}

/** `$N` id of the session holding this process's pane. */
export function ownSession(): string {
  // Missing pane expands to ""; an empty -t would silently pick another session.
  const id = tmux(["display-message", "-p", "-t", selfPane(), "#{session_id}"]);
  if (!id.startsWith("$")) throw new Error(`Own tmux pane ${selfPane()} not found`);
  return id;
}

export function sessionName(target: string): string {
  return tmux(["display-message", "-p", "-t", target, "#{session_name}"]);
}

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** User's login shell, resolved here: tmux's default-shell may be non-POSIX (fish). */
export function userShell(): string {
  return process.env.SHELL || "/bin/sh";
}

/**
 * Window command running `inner` in the user's interactive shell (rc env).
 * Only `exec` + single quotes reach tmux's default-shell, valid in sh/zsh/fish.
 */
export function viaUserShell(inner: string): string {
  return `exec ${quote(userShell())} -ic ${quote(inner)}`;
}

export interface CreateWindowOptions {
  name: string;
  tag: { key: string; value: string };
  cwd?: string;
  /** Initial shell-command (run by tmux's default-shell); default: interactive shell. */
  command?: string;
  /** Additional window metadata, committed before ownership is exposed. */
  options?: Record<string, string>;
}

/**
 * New detached window at the end of this process's session. Returns its pane id.
 * Create and tag run as one tmux command sequence (no event-loop turn in
 * between), so a command that exits at once cannot leave the window untagged
 * or make tagging fail. The explicit index makes the window addressable there.
 */
export function createWindow(options: CreateWindowOptions): string {
  if (options.tag.key !== "@pi_name") return createWindowUnlocked(options);
  return withRunNameLock(selfPane(), () => {
    if (ownedWindows("@pi_name", selfPane(), true).some((window) => window.tag === options.tag.value)) {
      throw new Error(`Window '${options.tag.value}' already exists. Use another name or restart it.`);
    }
    return createWindowUnlocked(options);
  });
}

function createWindowUnlocked(options: CreateWindowOptions): string {
  const session = ownSession();
  for (let attempt = 0; ; attempt++) {
    const indexes = tmux(["list-windows", "-t", session, "-F", "#{window_index}"]).split("\n").map(Number);
    const target = `${session}:${Math.max(-1, ...indexes) + 1}`;
    const args = ["new-window", "-d", "-t", target, "-n", options.name];
    if (options.cwd) args.push("-c", options.cwd);
    args.push("-P", "-F", "#{pane_id}");
    if (options.command) args.push(options.command);
    const set = (key: string, value: string) => [";", "set-option", "-w", "-t", target, key, value];
    try {
      const pane = tmux([
        ...args,
        ...Object.entries(options.options ?? {}).flatMap(([key, value]) => set(key, value)),
        ...set(options.tag.key, options.tag.value),
        ...set("@pi_owner", selfPane()),
        ...set("automatic-rename", "off"),
        // Owners detect completion by the pane disappearing.
        ...set("remain-on-exit", "off"),
      ]);
      if (!pane.startsWith("%")) throw new Error(`Unexpected tmux new-window output: ${pane}`);
      return pane;
    } catch (error) {
      // Another process took the index between list and create.
      if (attempt < 5 && /index \d+ in use/.test(String((error as { stderr?: string }).stderr))) continue;
      throw error;
    }
  }
}

export interface CreateSessionOptions {
  name: string;
  cwd?: string;
  command?: string;
}

/** tmux rejects `.` and `:` in session names. */
export function sanitizeSessionName(name: string): string {
  return name.replace(/[.:]/g, "_").trim() || "pi";
}

/** New detached session owned by this process. Name gets `-<id4>` when taken. */
export function createSession(options: CreateSessionOptions): { sessionId: string; paneId: string; name: string } {
  let name = sanitizeSessionName(options.name);
  if (hasSession(name)) name = `${name}-${randomBytes(2).toString("hex")}`;
  const args = ["new-session", "-d", "-s", name];
  if (options.cwd) args.push("-c", options.cwd);
  args.push("-P", "-F", "#{session_id}\t#{pane_id}");
  if (options.command) args.push(options.command);
  // One command sequence: a command that exits at once cannot outrun tagging.
  const target = `=${name}:`;
  const [sessionId, paneId] = tmux([
    ...args,
    ";", "set-option", "-t", target, "@pi_session_owner", selfPane(),
    ";", "set-option", "-t", target, "detach-on-destroy", "previous",
  ]).split("\t");
  if (!sessionId?.startsWith("$") || !paneId?.startsWith("%")) throw new Error(`Unexpected tmux new-session output: ${sessionId}`);
  return { sessionId, paneId, name };
}

function hasSession(name: string): boolean {
  try {
    tmux(["has-session", "-t", `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

/** Idempotent: a window already gone is not an error. */
export function closeWindow(paneId: string): void {
  try { tmux(["kill-window", "-t", paneId]); } catch { /* gone */ }
}

/** Idempotent: a session already gone is not an error. */
export function killSession(sessionId: string): void {
  try { tmux(["kill-session", "-t", sessionId]); } catch { /* gone */ }
}

/**
 * False only when tmux confirms the pane is gone. A failed query (busy server,
 * spawnSync ETIMEDOUT) counts as alive: callers poll, and a false "gone" makes
 * them report a still-running window or child as closed.
 */
export function isPaneAlive(paneId: string): boolean {
  try {
    return tmux(["list-panes", "-a", "-F", "#{pane_id}"]).split("\n").includes(paneId);
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
    return !/no server running|error connecting/.test(stderr);
  }
}

export interface OwnedWindow {
  paneId: string;
  windowId: string;
  /** Value of the requested tag key. */
  tag: string;
  command: string;
}

/**
 * Windows created by this process and carrying `tagKey`. Server-wide, so it
 * still works after this process's own pane is gone (e.g. its window was
 * killed and pi is shutting down on SIGHUP).
 */
export function ownedWindows(tagKey: string, owner = selfPane(), strict = false): OwnedWindow[] {
  let out: string;
  try {
    out = tmux(["list-panes", "-a", "-F", `#{pane_id}\t#{window_id}\t#{@pi_owner}\t#{${tagKey}}\t#{pane_current_command}`]);
  } catch (error) {
    if (strict) throw error;
    return [];
  }
  return out.split("\n").filter(Boolean).map((line) => line.split("\t"))
    .filter(([, , paneOwner, tag]) => paneOwner === owner && tag)
    .map(([paneId, windowId, , tag, command]) => ({ paneId, windowId, tag, command }));
}

/** Read one window-local option (no session/global fallback). */
export function windowOption(paneId: string, key: string): string {
  return tmux(["show-options", "-wqv", "-t", paneId, key]);
}

export function setWindowOption(paneId: string, key: string, value: string): void {
  tmux(["set-option", "-w", "-t", paneId, key, value]);
}

/**
 * Move a run out of a child lead's doomed session, then publish its new owner.
 * Ownership changes last: the parent cannot adopt half-transferred metadata.
 * Returns the parent's usable tool name, suffixed on collision.
 */
export function handoverWindow(paneId: string, parentPane: string): string {
  return withRunNameLock(parentPane, () => handoverWindowUnlocked(paneId, parentPane));
}

function handoverWindowUnlocked(paneId: string, parentPane: string): string {
  if (windowOption(paneId, "@pi_owner") !== selfPane()) throw new Error(`Window ${paneId} is no longer yours`);
  const parentSession = tmux(["display-message", "-p", "-t", parentPane, "#{session_id}"]);
  if (!/^\$\d+$/.test(parentSession)) throw new Error(`Parent tmux pane ${parentPane} not found`);
  const base = windowOption(paneId, "@pi_name");
  if (!base) throw new Error(`Window ${paneId} has no run name`);
  const names = new Set(ownedWindows("@pi_name", parentPane, true).map((w) => w.tag));
  let name = base;
  for (let suffix = 2; names.has(name); suffix++) name = `${base}-${suffix}`;
  const currentSession = tmux(["display-message", "-p", "-t", paneId, "#{session_id}"]);
  if (currentSession !== parentSession) {
    for (let attempt = 0; ; attempt++) {
      const indexes = tmux(["list-windows", "-t", parentSession, "-F", "#{window_index}"]).split("\n").map(Number);
      try {
        tmux(["move-window", "-s", paneId, "-t", `${parentSession}:${Math.max(-1, ...indexes) + 1}`]);
        break;
      } catch (error) {
        const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
        if (attempt < 5 && /index \d+ in use/.test(stderr)) continue;
        throw error;
      }
    }
  }
  try {
    tmux([
      "rename-window", "-t", paneId, name,
      ";", "set-option", "-w", "-t", paneId, "@pi_name", name,
      ";", "set-option", "-w", "-t", paneId, "@pi_owner", parentPane,
    ]);
  } catch (error) {
    // A timed-out command may have committed. Never leave both owners watching.
    if (windowOption(paneId, "@pi_owner") !== parentPane) throw error;
    name = windowOption(paneId, "@pi_name");
  }
  return name;
}

/** Sessions (server-wide) created by this process. */
export function ownedSessions(): string[] {
  const self = selfPane();
  let out: string;
  try {
    out = tmux(["list-sessions", "-F", "#{session_id}\t#{@pi_session_owner}"]);
  } catch {
    return [];
  }
  return out.split("\n").filter(Boolean).map((line) => line.split("\t"))
    .filter(([, owner]) => owner === self).map(([id]) => id);
}
