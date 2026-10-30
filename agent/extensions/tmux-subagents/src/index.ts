/**
 * tmux-subagents — async subagents in tmux, one unified `tmux_subagent` tool.
 *
 * Launches return immediately. A child opens as a detached window in the
 * spawner's tmux session; a child whose agent definition says `lead: true`
 * gets its own new tmux session instead, which it owns (its own windows and
 * further children land there) and which dies with it. Ownership is tagged in
 * tmux (see @pi-ext/tmux-windows), so cleanup finds children without memory.
 * The result is steered back into this session when the child finishes.
 * Liveness comes from the child-written activity snapshot.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import {
  closeWindow,
  createSession,
  createWindow,
  isPaneAlive,
  killSession,
  ownedSessions,
  ownedWindows,
  ownSession,
  sessionName,
  viaUserShell,
} from "@pi-ext/tmux-windows";
import {
  allowedSpawns,
  csv,
  type LaunchSpec,
  readLaunchSpec,
  resolveDenyTools,
  spawnRefusal,
  writeLaunchSpec,
} from "./policy.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";
import { findLastAssistantMessage, getNewEntries } from "./session.ts";
import {
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  idleSteerDue,
  observeStatus,
  STATUS_LINE_LIMIT,
  type StatusSnapshot,
  type SubagentStatusState,
} from "./status.ts";
import {
  isTmuxAvailable,
  pollForExit,
  sendEscape,
  sendText,
  shellEscape,
  tmuxSetupHint,
} from "./tmux.ts";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const CHILD_EXTENSION = join(EXT_DIR, "child.ts");

// Survive /reload: the re-imported module gets fresh state, but closures from the
// old module keep their timers and poll loops running. Kill them here.
const WIDGET_INTERVAL_KEY = Symbol.for("pi-tmux-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-tmux-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-tmux-subagents/poll-abort-controller");
const RUNNING_SUBAGENTS_KEY = Symbol.for("pi-tmux-subagents/running");
// Children alive at /reload: the old module parks them here, the new one re-watches them.
const RELOAD_HANDOFF_KEY = Symbol.for("pi-tmux-subagents/reload-handoff");

{
  const g = globalThis as any;
  clearInterval(g[WIDGET_INTERVAL_KEY]);
  clearInterval(g[STATUS_INTERVAL_KEY]);
  g[WIDGET_INTERVAL_KEY] = null;
  g[STATUS_INTERVAL_KEY] = null;
  (g[POLL_ABORT_KEY] as AbortController | undefined)?.abort();
  g[POLL_ABORT_KEY] = new AbortController();
}

function moduleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

// ── Agent definitions (bundled `agents/*.md` only) ──

export interface AgentDefinition {
  name: string;
  description?: string;
  model?: string;
  thinking?: string;
  tools?: string;
  denyTools?: string;
  spawning?: boolean;
  spawns?: string;
  /** Child gets its own tmux session and is a full lead there. */
  lead: boolean;
  /** No auto-exit after a turn; ends via subagent_done, stop, or the user. */
  interactive: boolean;
  systemPromptMode?: "append" | "replace";
  body?: string;
}

function agentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function bundledAgentsDir(): string {
  return join(EXT_DIR, "..", "agents");
}

function frontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseBool(value: string | undefined): boolean | undefined {
  return value != null ? value.toLowerCase() === "true" : undefined;
}

export function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fm = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const promptMode = frontmatterValue(fm, "system-prompt");

  return {
    name: frontmatterValue(fm, "name") ?? fallbackName,
    description: frontmatterValue(fm, "description"),
    model: frontmatterValue(fm, "model"),
    thinking: frontmatterValue(fm, "thinking"),
    tools: frontmatterValue(fm, "tools"),
    denyTools: frontmatterValue(fm, "deny-tools"),
    spawning: parseBool(frontmatterValue(fm, "spawning")),
    spawns: frontmatterValue(fm, "spawns"),
    lead: parseBool(frontmatterValue(fm, "lead")) === true,
    interactive: parseBool(frontmatterValue(fm, "interactive")) === true,
    systemPromptMode: promptMode === "replace" ? "replace" : promptMode === "append" ? "append" : undefined,
    body: body || undefined,
  };
}

export function discoverAgentDefinitions(dir = bundledAgentsDir()): AgentDefinition[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".md"))
    .map((file) => parseAgentDefinition(readFileSync(join(dir, file), "utf8"), file.replace(/\.md$/, "")))
    .filter((agent): agent is AgentDefinition => agent !== null);
}

function loadAgentDefinition(agentName: string): AgentDefinition | null {
  return discoverAgentDefinitions().find((agent) => agent.name === agentName) ?? null;
}

// Keep codemode available without widening the child's tool allowlist.
const CHILD_CONTROL_TOOLS = ["caller_ping", "subagent_done", "codemode"] as const;

/** Child `--tools` allowlist always keeps the control tools and codemode reachable. */
export function buildChildToolAllowlist(effectiveTools?: string): string | null {
  const requested = (effectiveTools ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (requested.length === 0) return null;
  const allow = new Set(requested);
  for (const tool of CHILD_CONTROL_TOOLS) allow.add(tool);
  return [...allow].join(",");
}

// ── Launch helpers ──

export interface LaunchParams {
  name: string;
  task: string;
  agent: string;
  cwd?: string;
}

/** A child cwd with its own `.pi/agent` picks up that config. */
function resolveSubagentPaths(cwd: string) {
  const localAgentDir = join(cwd, ".pi", "agent");
  const hasLocal = existsSync(localAgentDir);
  return {
    effectiveAgentDir: hasLocal ? localAgentDir : agentConfigDir(),
    agentDirEnv: hasLocal ? localAgentDir : process.env.PI_CODING_AGENT_DIR,
  };
}

function sessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const dir = join(agentDir, "sessions", safePath);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function slug(name: string, fallback = "subagent"): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || fallback
  );
}

function artifactDirFor(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// ── Running state ──

interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  errorMessage?: string;
}

interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  model?: string;
  /** Pane id of the child's pi. */
  surface: string;
  /** Lead children: their own tmux session. */
  sessionId?: string;
  tmuxSession?: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  abortController?: AbortController;
  stopRequested?: boolean;
  interactive: boolean;
  /** caller_ping delivered, `send` not yet. */
  awaitingReply: boolean;
  /** waitingSince of the idle episode already reported. */
  idleSteeredFor: number | null;
  statusState: SubagentStatusState;
}

const runningSubagents = new Map<string, RunningSubagent>();
// child.ts (loaded separately via -e) reads this to hold auto-exit while own children run.
(globalThis as any)[RUNNING_SUBAGENTS_KEY] = runningSubagents;

let latestCtx: ExtensionContext | null = null;
let widgetInterval: ReturnType<typeof setInterval> | null = null;
let statusInterval: ReturnType<typeof setInterval> | null = null;

// ── Widget ──

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }
  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  const contentWidth = Math.max(0, width - 2);
  const rightVis = visibleWidth(right);
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const truncLeft = truncateToWidth(left, Math.max(0, contentWidth - rightVis));
  const pad = Math.max(0, contentWidth - visibleWidth(truncLeft) - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;
  const inner = Math.max(0, width - 2);
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fill = "─".repeat(Math.max(0, inner - titlePart.length - infoPart.length));
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;
  return `${ACCENT}╰${"─".repeat(Math.max(0, width - 2))}╯${RST}`;
}

export function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const lines: string[] = [borderTop("Subagents", `${agents.length} running`, width)];
  for (const agent of agents) {
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const where = agent.tmuxSession ? ` @${agent.tmuxSession}` : "";
    const left = ` ${formatElapsedMMSS(agent.startTime)}  ${agent.name}${agentTag}${where} `;
    lines.push(borderLine(left, formatWidgetRightLabel(classifyStatus(agent.statusState, Date.now())), width));
  }
  lines.push(borderBottom(width));
  return lines;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    () => ({
      invalidate() {},
      render: (width: number) => renderSubagentWidgetLines([...runningSubagents.values()], width),
    }),
    { placement: "aboveEditor" },
  );
}

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget();
  widgetInterval = setInterval(updateWidget, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

// ── Activity observation ──

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  return activity.activeScope;
}

export function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  const read: ActivityReadResult = running.activityFile
    ? readSubagentActivityFile(running.activityFile, running.id)
    : { ok: false, reason: "missing" };

  if (read.ok) {
    running.activity = read.activity;
    running.statusState = observeStatus(
      running.statusState,
      {
        snapshot: "present",
        updatedAt: read.activity.updatedAt,
        sequence: read.activity.sequence,
        phase: read.activity.phase,
        active: read.activity.phase === "active",
        activeScope: read.activity.activeScope,
        activeSince: read.activity.activeSince,
        waitingSince: read.activity.waitingSince,
        latestEvent: read.activity.latestEvent,
        activityLabel: activityLabel(read.activity),
      },
      observedAt,
    );
    return;
  }

  running.statusState = observeStatus(
    running.statusState,
    { snapshot: read.reason, snapshotError: read.error },
    observedAt,
  );
}

export function formatIdleNote(running: Pick<RunningSubagent, "id" | "name" | "tmuxSession">): string {
  const where = running.tmuxSession ? ` in tmux session "${running.tmuxSession}"` : "";
  return `Sub-agent "${running.name}" [${running.id}] idle 2m${where} without calling subagent_done. ` +
    `Send it a message or stop it.`;
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let refreshWidget = false;

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
      if (nextState.currentKind !== running.statusState.currentKind) refreshWidget = true;
      running.statusState = nextState;
      // Interactive children stay silent on stall/recovery: the user may be driving them.
      if (transition && !running.interactive) {
        transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
      }
      if (idleSteerDue({
        interactive: running.interactive,
        snapshot,
        pendingChildren: running.activity?.pendingChildren ?? 0,
        awaitingReply: running.awaitingReply,
        steeredFor: running.idleSteeredFor,
        now,
      })) {
        running.idleSteeredFor = snapshot.waitingSinceMs;
        pi.sendMessage(
          {
            customType: "subagent_status",
            content: formatIdleNote(running),
            display: true,
            details: { lines: [formatIdleNote(running)], overflow: 0 },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      }
    }

    if (refreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, STATUS_LINE_LIMIT);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, STATUS_LINE_LIMIT),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

// ── Launch / watch ──

interface LaunchContext {
  sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string };
  cwd: string;
  /** Parent model/thinking, used when the agent definition pins no model. */
  inheritedModel?: string;
  inheritedThinking?: string;
}

/**
 * Bash script that runs (or resumes) a child pi from a launch spec, shared by
 * launch and resume. It records pi's exit code for the parent watcher; a lead
 * child's script then kills the child's whole tmux session.
 */
export function buildChildScript(o: {
  spec: LaunchSpec;
  sessionFile: string;
  id: string;
  activityFile: string;
  artifactDir: string;
  promptArgs: string[];
}): string {
  const { spec } = o;
  const parts: string[] = [
    "pi", "--session", shellEscape(o.sessionFile),
    "-e", shellEscape(CHILD_EXTENSION), "-e", "builtin:codemode",
  ];
  if (spec.model) parts.push("--model", shellEscape(spec.model));

  // Multiline system prompts go through a file; pi reads path arguments.
  if (spec.systemPrompt) {
    const flag = spec.systemPrompt.mode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const syspromptPath = join(o.artifactDir, "context", `${slug(spec.name)}-sysprompt-${o.id}.md`);
    mkdirSync(dirname(syspromptPath), { recursive: true });
    writeFileSync(syspromptPath, spec.systemPrompt.text, "utf8");
    parts.push(flag, shellEscape(syspromptPath));
  }
  if (spec.tools) parts.push("--tools", shellEscape(spec.tools));
  if (spec.denyTools.length > 0) parts.push("--exclude-tools", shellEscape(spec.denyTools.join(",")));
  for (const arg of o.promptArgs) parts.push(shellEscape(arg));

  const env: string[] = [];
  if (spec.agentDir) env.push(`PI_CODING_AGENT_DIR=${shellEscape(spec.agentDir)}`);
  if (spec.denyTools.length > 0) env.push(`PI_DENY_TOOLS=${shellEscape(spec.denyTools.join(","))}`);
  if (spec.spawns) env.push(`PI_SUBAGENT_SPAWNS=${shellEscape(spec.spawns.join(","))}`);
  env.push(`PI_SUBAGENT_NAME=${shellEscape(spec.name)}`);
  env.push(`PI_SUBAGENT_AGENT=${shellEscape(spec.agent)}`);
  if (spec.interactive) env.push("PI_SUBAGENT_INTERACTIVE=1");
  env.push(`PI_SUBAGENT_SESSION=${shellEscape(o.sessionFile)}`);
  env.push(`PI_SUBAGENT_ID=${shellEscape(o.id)}`);
  env.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(o.activityFile)}`);

  const statusFile = shellEscape(`${o.sessionFile}.status`);
  const lines = [
    "#!/bin/bash",
    `# Subagent "${spec.name.replace(/\n/g, " ")}" (${spec.agent}), session ${o.sessionFile}`,
  ];
  if (spec.cwd) lines.push(`cd ${shellEscape(spec.cwd)} || { echo 1 > ${statusFile}; exit 1; }`);
  lines.push(`${env.join(" ")} ${parts.join(" ")}`);
  lines.push(`echo $? > ${statusFile}`);
  if (spec.lead) lines.push(`tmux kill-session -t "$(tmux display-message -p -t "$TMUX_PANE" '#{session_id}')"`);
  return lines.join("\n") + "\n";
}

/** Start a child from a spec: lead → new tmux session, else window in own session. */
function startChild(o: {
  spec: LaunchSpec;
  sessionFile: string;
  promptArgs: string[];
  task: string;
  artifactDir: string;
}): RunningSubagent {
  const { spec, sessionFile } = o;
  const id = Math.random().toString(16).slice(2, 10);
  const startTime = Date.now();
  const activityFile = getSubagentActivityFile(o.artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });
  // Leftovers from an earlier run of this session would end the new watch at once.
  for (const suffix of [".status", ".exit", ".ping"]) rmSync(`${sessionFile}${suffix}`, { force: true });

  const launchScriptFile = join(o.artifactDir, "subagent-scripts", `${slug(spec.name)}-${id}.sh`);
  mkdirSync(dirname(launchScriptFile), { recursive: true });
  writeFileSync(
    launchScriptFile,
    buildChildScript({ spec, sessionFile, id, activityFile, artifactDir: o.artifactDir, promptArgs: o.promptArgs }),
    { mode: 0o755 },
  );
  // Interactive shell: the child gets the user's rc env, like `tmux` tool runs.
  const command = viaUserShell(`bash ${shellEscape(launchScriptFile)}`);

  let surface: string;
  let sessionId: string | undefined;
  let tmuxSession: string | undefined;
  if (spec.lead) {
    const created = createSession({ name: `${sessionName(ownSession())}-${slug(spec.name)}`, cwd: spec.cwd, command });
    ({ paneId: surface, sessionId, name: tmuxSession } = created);
  } else {
    surface = createWindow({ name: spec.name, tag: { key: "@pi_subagent", value: spec.name }, cwd: spec.cwd, command });
  }

  const running: RunningSubagent = {
    id,
    name: spec.name,
    task: o.task,
    agent: spec.agent,
    model: spec.model,
    surface,
    sessionId,
    tmuxSession,
    startTime,
    sessionFile,
    launchScriptFile,
    activityFile,
    interactive: spec.interactive,
    awaitingReply: false,
    idleSteeredFor: null,
    statusState: createStatusState({ startTimeMs: startTime }),
  };
  runningSubagents.set(id, running);
  return running;
}

/** Idempotent: a lead's whole session, else the child's window. */
function closeChild(running: Pick<RunningSubagent, "surface" | "sessionId">): void {
  if (running.sessionId) killSession(running.sessionId);
  else closeWindow(running.surface);
}

async function launchSubagent(params: LaunchParams, ctx: LaunchContext): Promise<RunningSubagent> {
  const def = loadAgentDefinition(params.agent);
  if (!def) throw new Error(`Agent "${params.agent}" not found.`);

  // Model comes only from the agent definition (or the parent); callers cannot override it.
  const pinnedModel = def.model;
  const effectiveModel = pinnedModel ?? ctx.inheritedModel;
  const effectiveThinking = def.thinking ?? (pinnedModel ? undefined : ctx.inheritedThinking);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const artifactDir = artifactDirFor(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());

  const cwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
  const { effectiveAgentDir, agentDirEnv } = resolveSubagentPaths(cwd);
  const sessionDir = sessionDirFor(cwd, effectiveAgentDir);

  // Deterministic child session path: no race when several children start at once.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = Array.from({ length: 4 }, (_, i) => Math.random().toString(16).slice(2, i === 3 ? 6 : 10)).join("-");
  const childSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  const modeHint = def.interactive ? INTERACTIVE_HINT : AUTO_EXIT_HINT;
  const summaryInstruction = def.interactive
    ? "Pass your final result to subagent_done as `message`."
    : "Your FINAL assistant message should summarize what you accomplished.";
  const identityInSystemPrompt = def.systemPromptMode && def.body;
  const roleBlock = def.body && !identityInSystemPrompt ? `\n\n${def.body}` : "";
  // Models otherwise stamp research/reports with their training-era date.
  const dateLine = `Current date: ${currentDate()}.`;
  const fullTask = `${roleBlock}\n\n${dateLine}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;

  const spec: LaunchSpec = {
    version: 2,
    name: params.name,
    agent: def.name,
    model: effectiveModel && (effectiveThinking ? `${effectiveModel}:${effectiveThinking}` : effectiveModel),
    systemPrompt: identityInSystemPrompt && def.body
      ? { mode: def.systemPromptMode === "replace" ? "replace" : "append", text: def.body }
      : undefined,
    tools: buildChildToolAllowlist(def.tools) ?? undefined,
    denyTools: resolveDenyTools(def),
    spawns: def.spawns !== undefined ? csv(def.spawns) : undefined,
    lead: def.lead,
    interactive: def.interactive,
    cwd,
    agentDir: agentDirEnv,
  };
  writeLaunchSpec(childSessionFile, spec);

  const artifactPath = join(artifactDir, "context", `${slug(params.name)}-${Math.random().toString(16).slice(2, 10)}.md`);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, fullTask, "utf8");
  return startChild({ spec, sessionFile: childSessionFile, promptArgs: [`@${artifactPath}`], task: params.task, artifactDir });
}

/** Local calendar date, e.g. "2026-10-17 (Saturday)". */
export function currentDate(now = new Date()): string {
  const day = now.toLocaleDateString("en-US", { weekday: "long" });
  return `${now.toLocaleDateString("en-CA")} (${day})`;
}

export const AUTO_EXIT_HINT =
  "Complete your task autonomously. Ending your turn ends your run and returns your last message as the result, " +
  "unless your own subagents/tmux runs are still running (their results wake you). " +
  "Never end your turn to report progress, coordinate, or say you are continuing. " +
  "If the parent must act or decide, call caller_ping, then end your turn: you stay alive and the reply arrives as your next message.";

export const INTERACTIVE_HINT =
  "Complete your task. When finished, call subagent_done with your result; that ends your run. " +
  "Ending a turn without it leaves you idle in your own tmux session, where the user may talk to you. " +
  "If the parent must act or decide, call caller_ping, then end your turn: the reply arrives as your next message.";

/** Poll a launched child to completion, extract its summary, close its window/session. */
async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
  onPing?: (ping: { name: string; message: string }) => void,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;

  try {
    const result = await pollForExit(surface, AbortSignal.any([signal, moduleAbortSignal()]), {
      interval: 1000,
      sessionFile,
      onTick: () => observeRunningSubagent(running),
      onPing,
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const fallback = result.errorMessage
      ? `Subagent error: ${result.errorMessage}`
      : result.exitCode !== 0
        ? `Sub-agent exited with code ${result.exitCode}`
        : result.reason === "closed"
          ? "Sub-agent closed without calling subagent_done."
          : "Sub-agent exited without output";
    const summary = existsSync(sessionFile)
      ? (findLastAssistantMessage(getNewEntries(sessionFile, 0)) ?? fallback)
      : fallback;

    closeChild(running);
    runningSubagents.delete(running.id);

    return {
      name,
      task,
      summary,
      sessionFile,
      exitCode: result.exitCode,
      elapsed,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  } catch (err: any) {
    // Aborts come from stop (child already closed) or reload/shutdown (the
    // shutdown cascade decides by tags); never close the child here.
    runningSubagents.delete(running.id);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (signal.aborted) {
      return { name, task, summary: "Subagent cancelled.", exitCode: 1, elapsed, error: "cancelled", sessionFile };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed,
      error: err?.message ?? String(err),
    };
  }
}

export function resolveResultPresentation(
  result: Pick<SubagentResult, "exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage">,
  name: string,
): string {
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
    : "";

  if (result.errorMessage) {
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\nError: ${result.errorMessage}\n\n` +
      `The subagent produced no result. Retry with a new launch or resume the session.${sessionRef}`
    );
  }
  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

export function formatLivePing(
  running: Pick<RunningSubagent, "id" | "name">,
  ping: { name: string; message: string },
  elapsedSeconds: number,
): string {
  return (
    `Sub-agent "${ping.name}" [${running.id}] needs help (${formatElapsed(elapsedSeconds)}):\n\n${ping.message}\n\n` +
    `It is still running and waiting for your answer. Reply with ` +
    `tmux_subagent({ action: "send", id: "${running.id}", message: "..." }); it then continues its task.`
  );
}

/** Wire the background watcher: results and pings steer back into this session. */
function trackSubagent(pi: ExtensionAPI, running: RunningSubagent) {
  const abort = new AbortController();
  running.abortController = abort;
  startWidgetRefresh();
  startStatusRefresh(pi);

  // Live ping: the child stays alive awaiting `send`, so the watcher keeps running.
  const onPing = (ping: { name: string; message: string }) => {
    if (running.stopRequested) return;
    running.awaitingReply = true;
    const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
    pi.sendMessage(
      {
        customType: "subagent_ping",
        content: formatLivePing(running, ping, elapsed),
        display: true,
        details: {
          name: ping.name,
          message: ping.message,
          agent: running.agent,
          id: running.id,
          sessionFile: running.sessionFile,
          live: true,
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  };

  watchSubagent(running, abort.signal, onPing)
    .then((result) => {
      updateWidget();
      if (running.stopRequested) return;

      pi.sendMessage(
        {
          customType: "subagent_result",
          content: resolveResultPresentation(result, running.name),
          display: true,
          details: {
            name: running.name,
            task: running.task,
            agent: running.agent,
            exitCode: result.exitCode,
            elapsed: result.elapsed,
            sessionFile: result.sessionFile,
            ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    })
    .catch((err) => {
      updateWidget();
      if (running.stopRequested) return;
      pi.sendMessage(
        {
          customType: "subagent_result",
          content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
          display: true,
          details: { name: running.name, task: running.task, error: err?.message },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    });
}

// ── Target resolution ──

export function resolveTarget(
  running: Map<string, RunningSubagent>,
  ref: string | undefined,
): { running: RunningSubagent } | { error: string } {
  const wanted = ref?.trim();
  if (!wanted) return { error: "Provide a running subagent id or exact display name." };

  const byId = running.get(wanted);
  if (byId) return { running: byId };

  const matches = [...running.values()].filter((child) => child.name === wanted);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) return { error: `No running subagent with id or name "${wanted}".` };
  return {
    error: `Ambiguous subagent name "${wanted}". Matches: ${matches.map((c) => `${c.name} [${c.id}]`).join(", ")}`,
  };
}

// ── Tool ──

const ACTIONS = ["launch", "list", "status", "send", "interrupt", "stop", "resume"] as const;

const SubagentParams = Type.Object({
  action: Type.Optional(
    StringEnum([...ACTIONS], {
      description:
        "launch (default) spawns a child; list shows agent definitions; status shows running children; " +
        "send delivers a follow-up message to a live child; interrupt cancels a child's current turn; " +
        "stop kills a child; resume restarts a previous child session.",
    }),
  ),
  name: Type.Optional(Type.String({ description: "Display name for launch/resume (window/session name, widget label)" })),
  task: Type.Optional(Type.String({ description: "Task prompt for launch" })),
  agent: Type.Optional(Type.String({ description: "Agent definition (required for launch); see action list" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the child; picks up that folder's config" })),
  id: Type.Optional(Type.String({ description: "Running child id or exact name for status/send/interrupt/stop" })),
  message: Type.Optional(Type.String({ description: "Message body for send, or follow-up prompt for resume" })),
  sessionPath: Type.Optional(Type.String({ description: "Child session .jsonl to resume" })),
});

type SubagentToolParams = Static<typeof SubagentParams>;

function reply(text: string, details?: unknown, isError?: boolean) {
  return { content: [{ type: "text" as const, text }], details, isError };
}

function placement(running: RunningSubagent): string {
  return running.tmuxSession ? `in its own tmux session "${running.tmuxSession}"` : "in a tmux window";
}

const LAUNCH_CONTRACT =
  "Launching is fire-and-forget: the call returns immediately with an acknowledgement. " +
  "When the child finishes, the harness AUTOMATICALLY steers its result back and wakes you. " +
  "DO NOT poll, sleep, tail logs, or re-check status to detect completion. " +
  "DO NOT fabricate or assume results. After launching, end your turn or work on other independent tasks.";

/**
 * Children are found by tmux tags, not memory, so ones orphaned by an
 * earlier /reload are covered too. Reload keeps them (the process lives on).
 */
export function cascadeShutdown(reason: string): void {
  if (reason === "reload" || !isTmuxAvailable()) return;
  for (const window of ownedWindows("@pi_subagent")) closeWindow(window.paneId);
  for (const session of ownedSessions()) killSession(session);
}

/** Snapshot for the next module: plain data only, no watcher or stop state. */
export function reloadHandoff(children: Iterable<RunningSubagent>): RunningSubagent[] {
  return [...children].map(({ abortController: _a, stopRequested: _s, ...rest }) => ({ ...rest }));
}

/** Re-watch children handed off by the module this one replaced. Gone ones are dropped. */
function adoptHandoff(pi: ExtensionAPI): void {
  const g = globalThis as any;
  const parked = g[RELOAD_HANDOFF_KEY] as RunningSubagent[] | undefined;
  delete g[RELOAD_HANDOFF_KEY];
  if (!parked?.length || !isTmuxAvailable()) return;
  for (const running of parked) {
    if (runningSubagents.has(running.id)) continue;
    // Pane gone during the reload: pollForExit still reports it from the sidecars.
    runningSubagents.set(running.id, running);
    trackSubagent(pi, running);
  }
}

export default function tmuxSubagentsExtension(pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
    latestCtx = ctx;
    // session_shutdown can fire without the process dying (session switch in
    // the same pid); a controller aborted there would leave every later watch
    // born dead, so replace it when a session starts.
    const g = globalThis as any;
    if ((g[POLL_ABORT_KEY] as AbortController | undefined)?.signal.aborted) {
      g[POLL_ABORT_KEY] = new AbortController();
    }
    if (event.reason === "reload") adoptHandoff(pi);
    else delete g[RELOAD_HANDOFF_KEY];
  });

  pi.on("session_shutdown", (event) => {
    if (event.reason === "reload") (globalThis as any)[RELOAD_HANDOFF_KEY] = reloadHandoff(runningSubagents.values());
    clearInterval(widgetInterval ?? undefined);
    clearInterval(statusInterval ?? undefined);
    widgetInterval = null;
    statusInterval = null;
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    ((globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined)?.abort();
    for (const child of runningSubagents.values()) {
      child.stopRequested = true;
      child.abortController?.abort();
    }
    runningSubagents.clear();
    cascadeShutdown(event.reason);
  });

  // Parents deny this tool to children via PI_DENY_TOOLS (agent `spawning: false`).
  const deniedTools = new Set(csv(process.env.PI_DENY_TOOLS));
  if (deniedTools.has("tmux_subagent")) return;

  pi.registerTool({
    name: "tmux_subagent",
    label: "Subagent",
    description:
      "Spawn and manage sub-agents in tmux. A child opens as a detached window in your tmux session; " +
      "agents marked lead get their own new tmux session, own it, and can spawn their own children there. " +
      `Omit action (or use action "launch") with name+task+agent to spawn one. ${LAUNCH_CONTRACT} ` +
      'Other actions: "list" (agent definitions), "status" (running children), "send" (message a live child), ' +
      '"interrupt" (cancel a child turn), "stop" (kill a child), "resume" (restart a child session).',
    promptSnippet:
      "Spawn sub-agents in tmux with tmux_subagent({ name, task, agent }). " + LAUNCH_CONTRACT,
    parameters: SubagentParams,

    async execute(_toolCallId, params: SubagentToolParams, _signal, _onUpdate, ctx) {
      const action = params.action ?? "launch";

      if (action === "list") {
        const spawnable = allowedSpawns();
        const list = discoverAgentDefinitions().filter((agent) => !spawnable || spawnable.has(agent.name));
        if (list.length === 0) return reply("No agent definitions you may launch.", { agents: [] });
        const lines = list.map((a) => {
          const tools = a.tools ? `tools: ${a.tools}` : `tools: defaults${a.denyTools ? ` minus ${a.denyTools}` : ""}`;
          const traits = [a.lead && "own tmux session", a.interactive && "interactive"].filter(Boolean).join(", ");
          return `• ${a.name}${a.model ? ` [${a.model}]` : ""}${a.description ? ` — ${a.description}` : ""} (${tools}${traits ? `; ${traits}` : ""})`;
        });
        return reply(lines.join("\n"), { agents: list });
      }

      if (action === "status") {
        const now = Date.now();
        const children = [...runningSubagents.values()];
        if (children.length === 0) return reply("No running subagents.", { children: [] });
        const rows = children.map((child) => {
          observeRunningSubagent(child, now);
          const snapshot = classifyStatus(child.statusState, now);
          return {
            id: child.id,
            name: child.name,
            agent: child.agent,
            tmuxSession: child.tmuxSession,
            kind: snapshot.kind,
            elapsed: snapshot.elapsedText,
            sessionFile: child.sessionFile,
          };
        });
        const text = rows
          .map((row) =>
            `• ${row.name} [${row.id}]${row.agent ? ` (${row.agent})` : ""}${row.tmuxSession ? ` @${row.tmuxSession}` : ""} — ${row.kind}, ${row.elapsed}`)
          .join("\n");
        return reply(text, { children: rows });
      }

      if (action === "send" || action === "interrupt" || action === "stop") {
        const resolved = resolveTarget(runningSubagents, params.id ?? params.name);
        if ("error" in resolved) return reply(resolved.error, { error: resolved.error }, true);
        const child = resolved.running;

        if (action === "interrupt") {
          const now = Date.now();
          observeRunningSubagent(child, now);
          try {
            sendEscape(child.surface);
          } catch (error: any) {
            const message = `Failed to interrupt "${child.name}": ${error?.message ?? String(error)}`;
            return reply(message, { error: message }, true);
          }
          child.statusState = forceStatusAfterInterrupt(child.statusState, now);
          updateWidget();
          return reply(`Interrupt requested for "${child.name}".`, {
            id: child.id,
            name: child.name,
            status: "interrupt_requested",
          });
        }

        if (action === "send") {
          if (!params.message) return reply("Missing message for send.", { error: "missing message" }, true);
          if (!isPaneAlive(child.surface)) {
            return reply(`Subagent "${child.name}" is gone.`, { error: "pane closed" }, true);
          }
          try {
            sendText(child.surface, params.message);
          } catch (error: any) {
            const message = `Failed to send to "${child.name}": ${error?.message ?? String(error)}`;
            return reply(message, { error: message }, true);
          }
          child.awaitingReply = false;
          return reply(
            `Message delivered to "${child.name}". Its reply steers back when the child finishes; do not poll.`,
            { id: child.id, name: child.name, status: "message_sent" },
          );
        }

        child.stopRequested = true;
        child.abortController?.abort();
        closeChild(child);
        runningSubagents.delete(child.id);
        updateWidget();

        let summary = "No output captured.";
        try {
          if (existsSync(child.sessionFile)) {
            summary = findLastAssistantMessage(getNewEntries(child.sessionFile, 0)) ?? summary;
          }
        } catch {}
        return reply(`Stopped "${child.name}". Last output:\n\n${summary}`, {
          id: child.id,
          name: child.name,
          status: "stopped",
          sessionFile: child.sessionFile,
        });
      }

      if (!isTmuxAvailable()) {
        return reply(`Subagents need tmux. ${tmuxSetupHint()}`, { error: "tmux not available" }, true);
      }
      if (!ctx.sessionManager.getSessionFile()) {
        return reply("No session file. Start pi with a persistent session.", { error: "no session file" }, true);
      }

      let running: RunningSubagent;
      if (action === "resume") {
        if (!params.sessionPath) return reply("Missing sessionPath for resume.", { error: "missing sessionPath" }, true);
        if (!existsSync(params.sessionPath)) {
          return reply(`Session file not found: ${params.sessionPath}`, { error: "session not found" }, true);
        }

        // Re-apply the role the session was launched with.
        const saved = readLaunchSpec(params.sessionPath);
        if (!saved) {
          return reply(
            `No usable launch spec beside ${params.sessionPath} (not a subagent session, or launched by an older version). Launch a new subagent instead.`,
            { error: "no launch spec" },
            true,
          );
        }
        const refusal = spawnRefusal(saved.agent, allowedSpawns());
        if (refusal) return reply(refusal, { error: "spawn not allowed" }, true);
        const spec: LaunchSpec = {
          ...saved,
          name: params.name ?? saved.name,
          // Resumer's own denies still apply: resume must not escape them.
          denyTools: resolveDenyTools({ denyTools: saved.denyTools.join(",") }),
        };
        writeLaunchSpec(params.sessionPath, spec);
        const artifactDir = artifactDirFor(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
        const promptArgs: string[] = [];
        if (params.message) {
          const messageFile = join(artifactDir, "subagent-resume", `${slug(spec.name, "resume")}-${Date.now()}.md`);
          mkdirSync(dirname(messageFile), { recursive: true });
          writeFileSync(messageFile, params.message, "utf8");
          promptArgs.push(`@${messageFile}`);
        }
        try {
          running = startChild({
            spec,
            sessionFile: params.sessionPath,
            promptArgs,
            task: params.message ?? "resumed session",
            artifactDir,
          });
        } catch (error: any) {
          const message = `Resume failed: ${error?.message ?? String(error)}`;
          return reply(message, { error: message }, true);
        }
        trackSubagent(pi, running);
        return reply(`Session "${running.name}" resumed ${placement(running)}. ${LAUNCH_CONTRACT}`, {
          id: running.id,
          name: running.name,
          sessionPath: params.sessionPath,
          tmuxSession: running.tmuxSession,
          launchScriptFile: running.launchScriptFile,
          status: "started",
        });
      }

      // launch
      if (!params.name || !params.task || !params.agent) {
        return reply(
          "Missing name, task or agent. Provide all three to launch (see action list for agents), or set action to list/status/send/interrupt/stop/resume.",
          { error: "missing name, task or agent" },
          true,
        );
      }

      const refusal = spawnRefusal(params.agent, allowedSpawns());
      if (refusal) return reply(refusal, { error: "spawn not allowed" }, true);

      try {
        running = await launchSubagent(
          { name: params.name, task: params.task, agent: params.agent, cwd: params.cwd },
          {
            sessionManager: ctx.sessionManager as LaunchContext["sessionManager"],
            cwd: ctx.cwd,
            inheritedModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
            inheritedThinking: ctx.thinkingLevel,
          },
        );
      } catch (error: any) {
        const message = `Launch failed: ${error?.message ?? String(error)}`;
        return reply(message, { error: message }, true);
      }
      trackSubagent(pi, running);

      return reply(
        `Sub-agent "${params.name}" launched ${placement(running)} and is running in the background. ${LAUNCH_CONTRACT}`,
        {
          id: running.id,
          name: params.name,
          task: params.task,
          agent: params.agent,
          model: running.model,
          tmuxSession: running.tmuxSession,
          sessionFile: running.sessionFile,
          launchScriptFile: running.launchScriptFile,
          status: "started",
        },
      );
    },

    renderCall(args, theme) {
      const partial = args as Record<string, unknown>;
      const action = typeof partial.action === "string" ? partial.action : "launch";
      const name = typeof partial.name === "string" && partial.name ? partial.name : undefined;
      const target = name ?? (typeof partial.id === "string" ? partial.id : undefined);

      if (action !== "launch") {
        return new Text(
          `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(target ?? action))}${theme.fg("dim", ` — ${action}`)}`,
          0,
          0,
        );
      }

      const agent =
        typeof partial.agent === "string" && partial.agent ? theme.fg("dim", ` (${partial.agent})`) : "";
      const cwdHint = typeof partial.cwd === "string" && partial.cwd ? theme.fg("dim", ` in ${partial.cwd}`) : "";
      let text = "▸ " + theme.fg("toolTitle", theme.bold(target ?? "(unnamed)")) + agent + cwdHint;

      // renderCall runs while arguments stream in, so keep the task preview short.
      const task = typeof partial.task === "string" ? partial.task : "";
      if (task) {
        const firstLine = task.split("\n").find((line: string) => line.trim()) ?? "";
        const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
        if (preview) text += "\n" + theme.fg("toolOutput", preview);
        const totalLines = task.split("\n").length;
        if (totalLines > 1) text += theme.fg("muted", ` (${totalLines} lines)`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      if (details?.status === "started") {
        return new Text(
          `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(details.name ?? "subagent"))}${theme.fg("dim", " — started")}`,
          0,
          0,
        );
      }
      if (details?.status) {
        return new Text(
          `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent"))}${theme.fg("dim", ` — ${details.status.replace(/_/g, " ")}`)}`,
          0,
          0,
        );
      }
      const first = result.content[0] as { text?: string } | undefined;
      return new Text(theme.fg("dim", typeof first?.text === "string" ? first.text : ""), 0, 0);
    },
  });

  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = (text: string) => theme.bg(failed ? "toolErrorBg" : "toolSuccessBg", text);
        const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const status = errorMessage
          ? "failed (provider/agent error)"
          : failed
            ? `failed (exit ${exitCode})`
            : "completed";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;

        const raw = typeof message.content === "string" ? message.content : "";
        const summary = raw
          .replace(/\n\nSession: .+\nResume: .+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "");

        const contentLines = [header];
        if (options.expanded) {
          if (summary) for (const line of summary.split("\n")) contentLines.push(line.slice(0, width - 6));
          if (details.sessionFile) {
            contentLines.push("", theme.fg("dim", `Session: ${details.sessionFile}`));
            contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
          }
        } else {
          if (summary) {
            const lines = summary.split("\n");
            for (const line of lines.slice(0, 5)) contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            if (lines.length > 5) contentLines.push(theme.fg("muted", `… ${lines.length - 5} more lines`));
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines: string[] = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];
        if (overflow > 0) contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        if (!options.expanded) contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const header = `${theme.fg("accent", "?")} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;
        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("", details.message ?? "");
          if (details.sessionFile) contentLines.push("", theme.fg("dim", `Session: ${details.sessionFile}`));
        } else {
          contentLines.push(theme.fg("dim", (details.message ?? "").split("\n")[0].slice(0, width - 10)));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("toolSuccessBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });
}
