/**
 * Rooms: a durable mailbox + roster shared by a host (root pi or a lead child)
 * and its direct children. Plain files, so messages and results survive a
 * parent restart and need no live process to relay them.
 *
 *   ~/.pi/agent/rooms/<host session id>/
 *     members/<name>.json        written only by the host
 *     inbox/<name>/<ts>-<r>.json any member writes; the owner deletes after delivery
 *
 * Every write is tmp file + rename, so readers never see partial JSON.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Inbox name of the room's host. */
export const HOST = "parent";
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export interface Member {
  name: string;
  id: string;
  agent?: string;
  status: "running" | "done" | "failed" | "stopped";
  sessionFile: string;
  /** Pane of the child's pi; lead children also own `sessionId`. */
  surface: string;
  sessionId?: string;
  tmuxSession?: string;
  activityFile?: string;
  interactive: boolean;
  task: string;
  startedAt: number;
  endedAt?: number;
  /** Final message, truncated. */
  result?: string;
}

export interface RoomMessage {
  from: string;
  to: string;
  body: string;
  ts: number;
  broadcast?: boolean;
  /** caller_ping: the sender is blocked until it gets a reply. */
  ping?: boolean;
}

export function roomsRoot(): string {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "rooms");
}

export function roomDir(hostSessionId: string, root = roomsRoot()): string {
  return join(root, hostSessionId);
}

const fileName = (name: string) => encodeURIComponent(name);

function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function jsonFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

export function writeMember(room: string, member: Member): void {
  const dir = join(room, "members");
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, `${fileName(member.name)}.json`), member);
}

export function updateMember(room: string, name: string, patch: Partial<Member>): void {
  const current = readMember(room, name);
  if (current) writeMember(room, { ...current, ...patch });
}

export function readMember(room: string, name: string): Member | undefined {
  return readJson<Member>(join(room, "members", `${fileName(name)}.json`));
}

export function readMembers(room: string): Member[] {
  const dir = join(room, "members");
  return jsonFiles(dir)
    .map((f) => readJson<Member>(join(dir, f)))
    .filter((m): m is Member => !!m)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** Queue a message in `to`'s inbox. */
export function postMessage(room: string, message: RoomMessage): void {
  const dir = join(room, "inbox", fileName(message.to));
  mkdirSync(dir, { recursive: true });
  // Timestamp prefix keeps delivery order; random suffix avoids collisions.
  writeAtomic(join(dir, `${String(message.ts).padStart(15, "0")}-${randomBytes(3).toString("hex")}.json`), message);
}

/**
 * Hand every queued message for `name` to `deliver`, oldest first, deleting
 * each after delivery. A crash mid-drain re-delivers at most that one message.
 */
export function drainInbox(room: string, name: string, deliver: (message: RoomMessage) => void): number {
  const dir = join(room, "inbox", fileName(name));
  let count = 0;
  for (const file of jsonFiles(dir)) {
    const path = join(dir, file);
    const message = readJson<RoomMessage>(path);
    if (message) {
      deliver(message);
      count++;
    }
    rmSync(path, { force: true });
  }
  return count;
}

/**
 * A process sees up to two rooms: `up` (its parent's room, where it is `self`)
 * and `own` (the room it hosts, where it is `parent`).
 */
export interface Scopes {
  self: string;
  up?: string;
  own?: string;
}

export interface Target {
  room: string;
  to: string;
  /** Sender's name in that room. */
  from: string;
}

const running = (room: string | undefined, except?: string) =>
  room ? readMembers(room).filter((m) => m.status === "running" && m.name !== except).map((m) => m.name) : [];

/** Where `to` points: a running child or sibling, `parent`, or `all` reachable members. */
export function resolveTargets(s: Scopes, to: string): { targets: Target[] } | { error: string } {
  const children = running(s.own);
  const siblings = running(s.up, s.self);
  const inOwn = (to: string): Target => ({ room: s.own!, to, from: HOST });
  const inUp = (to: string): Target => ({ room: s.up!, to, from: s.self });
  const reachable = [...(s.up ? [HOST] : []), ...siblings, ...children];
  if (to === "all") {
    const targets = [...(s.up ? [inUp(HOST)] : []), ...siblings.map(inUp), ...children.map(inOwn)];
    return targets.length ? { targets } : { error: "Nobody to message: no parent and no running siblings or children." };
  }
  if (to === HOST) return s.up ? { targets: [inUp(HOST)] } : { error: "You have no parent: you are the root agent." };
  if (to === s.self) return { error: "Cannot message yourself." };
  const child = children.includes(to);
  const sibling = siblings.includes(to);
  if (child && sibling) return { error: `"${to}" is both your child and your sibling; rename one of them.` };
  if (child) return { targets: [inOwn(to)] };
  if (sibling) return { targets: [inUp(to)] };
  const known = (s.own && readMember(s.own, to)) || (s.up && readMember(s.up, to));
  if (known) return { error: `"${to}" is ${known.status}; it cannot receive messages.` };
  return { error: `Nobody named "${to}". Reachable: ${reachable.join(", ") || "(none)"}.` };
}

export function formatRoomMessage(m: RoomMessage): string {
  const reply = `room({ action: "send", to: "${m.from}", message: "..." })`;
  if (m.ping) {
    return `"${m.from}" needs help:\n\n${m.body}\n\nIt is blocked until you answer. Reply with ${reply}; it then continues its task.`;
  }
  const scope = m.broadcast ? "to everyone" : "to you";
  return `Message from "${m.from}" ${scope}:\n\n${m.body}\n\nReply only if useful: ${reply}.`;
}

/** Queue `body` for every target of `to`. Throws when `to` reaches nobody. */
export function sendRoom(s: Scopes, to: string, body: string, extra: Partial<RoomMessage> = {}): Target[] {
  const resolved = resolveTargets(s, to);
  if ("error" in resolved) throw new Error(resolved.error);
  const ts = Date.now();
  for (const t of resolved.targets) postMessage(t.room, { from: t.from, to: t.to, body, ts, broadcast: to === "all", ...extra });
  return resolved.targets;
}

export const ROOM_TOOL_DESCRIPTION =
  `The only way to message other agents. Reach your parent ("${HOST}"; subagents only), your running siblings, and ` +
  'your running subagents (children) by name, or "all" of them. action "members" lists them, plus finished ones, ' +
  "with task and status. " +
  'action "send" queues `message` for `to`; it arrives as a message in their session within ~1s and wakes them. ' +
  "Sending never waits for a reply: keep working, replies arrive as your next messages. Finished agents cannot " +
  "receive messages. If ending your turn ends your run, replies sent after that are lost: do not end a turn just " +
  "to wait for a reply. Use it to answer a child's question, give follow-up instructions, share findings, or coordinate; not for chatter.";

function memberLine(m: Member, self?: string): string {
  const tag = m.name === self ? " (you)" : "";
  return `• ${m.name}${tag}${m.agent ? ` [${m.agent}]` : ""} — ${m.status}: ${m.task.split("\n")[0].slice(0, 120)}`;
}

export function formatRoster(s: Scopes): string {
  const parts: string[] = [];
  if (s.up) parts.push(`Your parent's room (address the host as "${HOST}"):\n${readMembers(s.up).map((m) => memberLine(m, s.self)).join("\n")}`);
  if (s.own) {
    const children = readMembers(s.own);
    if (children.length) parts.push(`Your children:\n${children.map((m) => memberLine(m)).join("\n")}`);
  }
  return parts.join("\n\n") || "No parent and no children: nobody to message.";
}

/** Delete rooms nobody touched for a week. */
export function pruneRooms(root = roomsRoot(), now = Date.now()): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const dir = join(root, entry);
    const mtime = (p: string) => {
      try {
        return statSync(p).mtimeMs;
      } catch {
        return 0;
      }
    };
    const newest = Math.max(mtime(dir), mtime(join(dir, "members")), mtime(join(dir, "inbox")));
    if (newest && now - newest > MAX_AGE_MS) rmSync(dir, { recursive: true, force: true });
  }
}

/** A live process (other than `except`) running `pi --session <sessionFile>`. Linux /proc only. */
export function liveSessionPid(sessionFile: string, except = process.pid): number | undefined {
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {
    return undefined;
  }
  for (const pid of pids) {
    if (Number(pid) === except) continue;
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      const i = argv.indexOf("--session");
      if (i >= 0 && argv[i + 1] === sessionFile) return Number(pid);
    } catch {}
  }
  return undefined;
}
