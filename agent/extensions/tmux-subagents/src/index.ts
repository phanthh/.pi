/**
 * tmux-subagents — async subagents in tmux panes, one unified `tmux_subagent` tool.
 *
 * Launches return immediately; the child runs in its own pane and its result is
 * steered back into this session when it finishes. Liveness comes from the
 * child-written activity snapshot, not session-file growth.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";
import { findLastAssistantMessage, getNewEntries, seedSubagentSessionFile } from "./session.ts";
import {
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
  STATUS_LINE_LIMIT,
  type StatusSnapshot,
  type SubagentStatusState,
} from "./status.ts";
import {
  closeSurface,
  createSurface,
  isPaneAlive,
  isTmuxAvailable,
  pollForExit,
  sendEscape,
  sendLongCommand,
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

{
  const g = globalThis as any;
  if (g[WIDGET_INTERVAL_KEY]) clearInterval(g[WIDGET_INTERVAL_KEY]);
  if (g[STATUS_INTERVAL_KEY]) clearInterval(g[STATUS_INTERVAL_KEY]);
  g[WIDGET_INTERVAL_KEY] = null;
  g[STATUS_INTERVAL_KEY] = null;
  (g[POLL_ABORT_KEY] as AbortController | undefined)?.abort();
  g[POLL_ABORT_KEY] = new AbortController();
  try {
    const log = (msg: string) =>
      require("node:fs").appendFileSync(
        require("node:os").homedir() + "/.pi/agent/subagent-module-load.log",
        `${new Date().toISOString()} pid=${process.pid} ${msg}\n`,
      );
    log("evaluated");
    (g[POLL_ABORT_KEY] as AbortController).signal.addEventListener("abort", () =>
      log(`controller-aborted stack=${new Error().stack?.split("\n").slice(1, 6).join(" | ")}`),
    );
  } catch {}
}

function moduleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

// ── Agent definitions ──

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";
type AgentSource = "bundled" | "global" | "project";

interface AgentDefaults {
  model?: string;
  thinking?: string;
  tools?: string;
  skills?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  body?: string;
}

interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  hidden: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
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

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  return value === "standalone" || value === "lineage-only" || value === "fork" ? value : undefined;
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fm = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const promptMode = frontmatterValue(fm, "system-prompt") ?? frontmatterValue(fm, "systemPromptMode");

  return {
    name: frontmatterValue(fm, "name") ?? fallbackName,
    description: frontmatterValue(fm, "description"),
    model: frontmatterValue(fm, "model"),
    thinking: frontmatterValue(fm, "thinking"),
    tools: frontmatterValue(fm, "tools"),
    skills: frontmatterValue(fm, "skills") ?? frontmatterValue(fm, "skill"),
    denyTools: frontmatterValue(fm, "deny-tools"),
    spawning: parseBool(frontmatterValue(fm, "spawning")),
    autoExit: parseBool(frontmatterValue(fm, "auto-exit")),
    interactive: parseBool(frontmatterValue(fm, "interactive")),
    systemPromptMode: promptMode === "replace" ? "replace" : promptMode === "append" ? "append" : undefined,
    sessionMode: parseSessionMode(frontmatterValue(fm, "session-mode")),
    cwd: frontmatterValue(fm, "cwd"),
    body: body || undefined,
    hidden: parseBool(frontmatterValue(fm, "disable-model-invocation")) === true,
  };
}

/** Later dirs win: bundled < global < project. */
function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: bundledAgentsDir(), source: "bundled" },
    { path: join(agentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(readFileSync(join(dir, file), "utf8"), file.replace(/\.md$/, ""));
      if (parsed) agents.set(parsed.name, { ...parsed, source });
    }
  }
  return [...agents.values()];
}

function loadAgentDefaults(agentName: string): AgentDefinition | null {
  return discoverAgentDefinitions().find((agent) => agent.name === agentName) ?? null;
}

/** Tools gated by `spawning: false`. */
const SPAWNING_TOOLS = new Set(["tmux_subagent"]);
const CHILD_CONTROL_TOOLS = ["caller_ping", "subagent_done"] as const;

function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;
  if (agentDefs.spawning === false) for (const tool of SPAWNING_TOOLS) denied.add(tool);
  for (const tool of (agentDefs.denyTools ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    denied.add(tool);
  }
  return denied;
}

/** Child `--tools` allowlist always keeps the control tools reachable. */
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
  agent?: string;
  model?: string;
  tools?: string;
  skills?: string;
  systemPrompt?: string;
  cwd?: string;
  fork?: boolean;
  interactive?: boolean;
}

function resolveSessionMode(params: LaunchParams, agentDefs: AgentDefaults | null): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

export function resolveLaunchBehavior(params: LaunchParams, agentDefs: AgentDefaults | null) {
  const sessionMode = resolveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? ("direct" as const) : ("artifact" as const),
  };
}

/**
 * Interactive children never wake the parent on stall/recovery — the user is
 * driving them in their own pane. Default: inverse of `auto-exit`.
 */
export function resolveEffectiveInteractive(params: LaunchParams, agentDefs: AgentDefaults | null): boolean {
  if (params.interactive != null) return params.interactive;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

function resolveSubagentPaths(params: LaunchParams, agentDefs: AgentDefaults | null) {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdBase = !params.cwd && agentDefs?.cwd != null ? agentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd ? (rawCwd.startsWith("/") ? rawCwd : join(cwdBase, rawCwd)) : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir = localAgentDir && existsSync(localAgentDir) ? localAgentDir : agentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
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

/** Some shells (direnv/devenv) need longer before the prompt accepts input. */
export function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

/**
 * Artifact-backed launches concatenate `@file` content into messages[0], which
 * breaks `/skill:` expansion. Prepend an empty message so skills land in
 * messages[1..] and arrive as standalone prompts.
 */
export function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);
  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;
  return [...(needsSeparator ? [""] : []), ...skillPrompts, params.taskArg];
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
  ping?: { name: string; message: string };
}

interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  model?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  abortController?: AbortController;
  stopRequested?: boolean;
  interactive: boolean;
  statusState: SubagentStatusState;
}

const runningSubagents = new Map<string, RunningSubagent>();

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
    const left = ` ${formatElapsedMMSS(agent.startTime)}  ${agent.name}${agentTag} `;
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
      // Interactive children stay silent: the user is in that pane already.
      if (transition && !running.interactive) {
        transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
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
  /** Parent model/thinking, used when neither the call nor the agent pins one. */
  inheritedModel?: string;
  inheritedThinking?: string;
}

async function launchSubagent(params: LaunchParams, ctx: LaunchContext): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  if (params.agent && !agentDefs) throw new Error(`Agent "${params.agent}" not found.`);

  const pinnedModel = params.model ?? agentDefs?.model;
  const effectiveModel = pinnedModel ?? ctx.inheritedModel;
  const effectiveThinking = agentDefs?.thinking ?? (pinnedModel ? undefined : ctx.inheritedThinking);
  const effectiveTools = params.tools ?? agentDefs?.tools;
  const effectiveSkills = params.skills ?? agentDefs?.skills;
  const interactive = resolveEffectiveInteractive(params, agentDefs);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const artifactDir = artifactDirFor(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());

  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs);
  const targetCwd = effectiveCwd ?? ctx.cwd;
  const sessionDir = sessionDirFor(targetCwd, effectiveAgentDir);

  // Deterministic child session path: no race when several children start at once.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const childSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  const surface = createSurface(params.name);
  await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

  const behavior = resolveLaunchBehavior(params, agentDefs);
  if (behavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: behavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile,
      childCwd: targetCwd,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });

  // Fork mode inherits the parent conversation, so the task goes in verbatim.
  // Blank sessions need the wrapper instructions and an artifact handoff.
  const modeHint = agentDefs?.autoExit
    ? "Complete your task autonomously."
    : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
  const summaryInstruction = agentDefs?.autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before subagent_done or before the user exits) should summarize what you accomplished.";
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const identityInSystemPrompt = agentDefs?.systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = behavior.inheritsConversationContext
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;

  const parts: string[] = ["pi", "--session", shellEscape(childSessionFile), "-e", shellEscape(CHILD_EXTENSION)];

  if (effectiveModel) {
    parts.push("--model", shellEscape(effectiveThinking ? `${effectiveModel}:${effectiveThinking}` : effectiveModel));
  }

  // Multiline system prompts go through a file; pi reads path arguments.
  if (identityInSystemPrompt && identity) {
    const flag = agentDefs?.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const syspromptPath = join(artifactDir, "context", `${slug(params.name)}-sysprompt-${id}.md`);
    mkdirSync(dirname(syspromptPath), { recursive: true });
    writeFileSync(syspromptPath, identity, "utf8");
    parts.push(flag, shellEscape(syspromptPath));
  }

  const toolAllowlist = buildChildToolAllowlist(effectiveTools);
  if (toolAllowlist) parts.push("--tools", shellEscape(toolAllowlist));

  const envParts: string[] = [];
  if (localAgentDir && existsSync(localAgentDir)) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(localAgentDir)}`);
  } else if (process.env.PI_CODING_AGENT_DIR) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`);
  }
  const denySet = resolveDenyTools(agentDefs);
  if (denySet.size > 0) envParts.push(`PI_DENY_TOOLS=${shellEscape([...denySet].join(","))}`);
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  if (params.agent) envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  if (agentDefs?.autoExit) envParts.push("PI_SUBAGENT_AUTO_EXIT=1");
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(childSessionFile)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
  envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
  envParts.push(`PI_SUBAGENT_SURFACE=${shellEscape(surface)}`);
  envParts.push(`PI_SUBAGENT_DEPTH=${Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) + 1}`);

  let taskArg: string;
  if (behavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const artifactPath = join(artifactDir, "context", `${slug(params.name)}-${id}.md`);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    taskArg = `@${artifactPath}`;
  }
  for (const promptArg of buildPiPromptArgs({ effectiveSkills, taskDelivery: behavior.taskDelivery, taskArg })) {
    parts.push(shellEscape(promptArg));
  }

  const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";
  const command = `${cdPrefix}${envParts.join(" ")} ${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
  const launchScriptFile = join(artifactDir, "subagent-scripts", `${slug(params.name)}-${id}.sh`);

  sendLongCommand(surface, command, {
    scriptPath: launchScriptFile,
    scriptPreamble: [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${childSessionFile}`,
      `# Pane: ${surface}`,
    ].join("\n"),
  });

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    model: effectiveModel,
    surface,
    startTime,
    sessionFile: childSessionFile,
    launchScriptFile,
    activityFile,
    interactive,
    statusState: createStatusState({ startTimeMs: startTime }),
  };
  runningSubagents.set(id, running);
  return running;
}

/** Poll a launched child to completion, extract its summary, close its pane. */
async function watchSubagent(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;

  try {
    const result = await pollForExit(surface, AbortSignal.any([signal, moduleAbortSignal()]), {
      interval: 1000,
      sessionFile,
      onTick: () => observeRunningSubagent(running),
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const fallback = result.errorMessage
      ? `Subagent error: ${result.errorMessage}`
      : result.reason === "closed"
        ? "Sub-agent pane was closed."
        : result.exitCode !== 0
          ? `Sub-agent exited with code ${result.exitCode}`
          : "Sub-agent exited without output";
    const summary = existsSync(sessionFile)
      ? (findLastAssistantMessage(getNewEntries(sessionFile, 0)) ?? fallback)
      : fallback;

    try {
      closeSurface(surface);
    } catch {}
    runningSubagents.delete(running.id);

    return {
      name,
      task,
      summary,
      sessionFile,
      exitCode: result.exitCode,
      elapsed,
      ping: result.ping,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  } catch (err: any) {
    try {
      require("node:fs").appendFileSync(
        require("node:os").homedir() + "/.pi/agent/subagent-module-load.log",
        `${new Date().toISOString()} watch-catch name=${name} err=${err?.message} childSignal=${signal.aborted} moduleSignal=${moduleAbortSignal().aborted}\n`,
      );
    } catch {}
    try {
      closeSurface(surface);
    } catch {}
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

/** Wire the background watcher: results and pings steer back into this session. */
function trackSubagent(pi: ExtensionAPI, running: RunningSubagent) {
  const abort = new AbortController();
  running.abortController = abort;
  startWidgetRefresh();
  startStatusRefresh(pi);

  watchSubagent(running, abort.signal)
    .then((result) => {
      updateWidget();
      if (running.stopRequested) return;

      if (result.ping) {
        const sessionRef = `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`;
        pi.sendMessage(
          {
            customType: "subagent_ping",
            content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
            display: true,
            details: {
              name: result.ping.name,
              message: result.ping.message,
              agent: running.agent,
              sessionFile: result.sessionFile,
            },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
        return;
      }

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
  name: Type.Optional(Type.String({ description: "Display name for launch/resume (pane title, widget label)" })),
  task: Type.Optional(Type.String({ description: "Task prompt for launch" })),
  agent: Type.Optional(Type.String({ description: "Agent definition to load defaults from, e.g. scout, worker, delegate, researcher" })),
  model: Type.Optional(Type.String({ description: "Model override; defaults to the agent's model, else this session's model" })),
  tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist override" })),
  skills: Type.Optional(Type.String({ description: "Comma-separated skills to auto-load" })),
  systemPrompt: Type.Optional(Type.String({ description: "Extra role instructions when no agent is given" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the child; picks up that folder's config" })),
  fork: Type.Optional(Type.Boolean({ description: "Fork this conversation into the child instead of a blank session" })),
  interactive: Type.Optional(
    Type.Boolean({ description: "Mark the child as user-driven: no stall/recovery pings back to this session" }),
  ),
  id: Type.Optional(Type.String({ description: "Running child id or exact name for status/send/interrupt/stop" })),
  message: Type.Optional(Type.String({ description: "Message body for send, or follow-up prompt for resume" })),
  sessionPath: Type.Optional(Type.String({ description: "Child session .jsonl to resume" })),
  autoExit: Type.Optional(
    Type.Boolean({ description: "For resume: exit after the next response (default true); false keeps it interactive" }),
  ),
});

type SubagentToolParams = Static<typeof SubagentParams>;

function reply(text: string, details?: unknown, isError?: boolean) {
  return { content: [{ type: "text" as const, text }], details, isError };
}

const LAUNCH_CONTRACT =
  "Launching is fire-and-forget: the call returns immediately with an acknowledgement. " +
  "When the child finishes, the harness AUTOMATICALLY steers its result back and wakes you. " +
  "DO NOT poll, sleep, tail logs, or re-check status to detect completion. " +
  "DO NOT fabricate or assume results. After launching, end your turn or work on other independent tasks.";

export default function tmuxSubagentsExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    // session_shutdown can fire without the process dying (session switch in
    // the same pid); a controller aborted there would leave every later watch
    // born dead, so replace it when a session starts.
    const g = globalThis as any;
    if ((g[POLL_ABORT_KEY] as AbortController | undefined)?.signal.aborted) {
      g[POLL_ABORT_KEY] = new AbortController();
    }
  });

  pi.on("session_shutdown", () => {
    if (widgetInterval) clearInterval(widgetInterval);
    if (statusInterval) clearInterval(statusInterval);
    widgetInterval = null;
    statusInterval = null;
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    try {
      require("node:fs").appendFileSync(
        require("node:os").homedir() + "/.pi/agent/subagent-module-load.log",
        `${new Date().toISOString()} pid=${process.pid} session_shutdown-handler firing\n`,
      );
    } catch {}
    ((globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined)?.abort();
    for (const child of runningSubagents.values()) child.abortController?.abort();
    runningSubagents.clear();
  });

  // Parents deny this tool to children via PI_DENY_TOOLS (agent `spawning: false`).
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );
  if (deniedTools.has("tmux_subagent")) return;

  pi.registerTool({
    name: "tmux_subagent",
    label: "Subagent",
    description:
      "Spawn and manage sub-agents running in their own tmux panes. " +
      `Omit action (or use action "launch") with name+task to spawn one. ${LAUNCH_CONTRACT} ` +
      'Other actions: "list" (agent definitions), "status" (running children), "send" (message a live child), ' +
      '"interrupt" (cancel a child turn), "stop" (kill a child), "resume" (restart a child session).',
    promptSnippet:
      "Spawn sub-agents in tmux panes with tmux_subagent({ name, task, agent }). " + LAUNCH_CONTRACT,
    parameters: SubagentParams,

    async execute(_toolCallId, params: SubagentToolParams, _signal, _onUpdate, ctx) {
      const action = params.action ?? "launch";

      if (action === "list") {
        const list = discoverAgentDefinitions().filter((agent) => !agent.hidden);
        if (list.length === 0) return reply("No agent definitions found.", { agents: [] });
        const lines = list.map((a) => {
          const badge = a.source === "bundled" ? "" : ` (${a.source})`;
          return `• ${a.name}${badge}${a.model ? ` [${a.model}]` : ""}${a.description ? ` — ${a.description}` : ""}`;
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
            kind: snapshot.kind,
            elapsed: snapshot.elapsedText,
            sessionFile: child.sessionFile,
          };
        });
        const text = rows
          .map((row) => `• ${row.name} [${row.id}]${row.agent ? ` (${row.agent})` : ""} — ${row.kind}, ${row.elapsed}`)
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
            return reply(`Subagent "${child.name}" pane is gone.`, { error: "pane closed" }, true);
          }
          try {
            sendText(child.surface, params.message);
          } catch (error: any) {
            const message = `Failed to send to "${child.name}": ${error?.message ?? String(error)}`;
            return reply(message, { error: message }, true);
          }
          return reply(
            `Message delivered to "${child.name}". Its reply steers back when the child finishes; do not poll.`,
            { id: child.id, name: child.name, status: "message_sent" },
          );
        }

        child.stopRequested = true;
        child.abortController?.abort();
        try {
          closeSurface(child.surface);
        } catch {}
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

      const launchCtx: LaunchContext = {
        sessionManager: ctx.sessionManager as LaunchContext["sessionManager"],
        cwd: ctx.cwd,
        inheritedModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        inheritedThinking: ctx.thinkingLevel,
      };

      if (action === "resume") {
        if (!params.sessionPath) return reply("Missing sessionPath for resume.", { error: "missing sessionPath" }, true);
        if (!existsSync(params.sessionPath)) {
          return reply(`Session file not found: ${params.sessionPath}`, { error: "session not found" }, true);
        }

        const name = params.name ?? "Resume";
        const autoExit = params.autoExit ?? true;
        const id = Math.random().toString(16).slice(2, 10);
        const startTime = Date.now();
        const artifactDir = artifactDirFor(
          ctx.sessionManager.getSessionDir(),
          ctx.sessionManager.getSessionId(),
        );
        const activityFile = getSubagentActivityFile(artifactDir, id);
        mkdirSync(dirname(activityFile), { recursive: true });

        const surface = createSurface(name);
        await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

        const parts = ["pi", "--session", shellEscape(params.sessionPath), "-e", shellEscape(CHILD_EXTENSION)];
        if (params.message) {
          const messageFile = join(artifactDir, "subagent-resume", `${slug(name, "resume")}-${id}.md`);
          mkdirSync(dirname(messageFile), { recursive: true });
          writeFileSync(messageFile, params.message, "utf8");
          parts.push(shellEscape(`@${messageFile}`));
        }

        const envParts: string[] = [];
        if (process.env.PI_CODING_AGENT_DIR) {
          envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`);
        }
        envParts.push(`PI_SUBAGENT_NAME=${shellEscape(name)}`);
        envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(params.sessionPath)}`);
        envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
        envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
        if (autoExit) envParts.push("PI_SUBAGENT_AUTO_EXIT=1");

        const launchScriptFile = join(artifactDir, "subagent-scripts", `${slug(name, "resume")}-resume-${id}.sh`);
        sendLongCommand(surface, `${envParts.join(" ")} ${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`, {
          scriptPath: launchScriptFile,
          scriptPreamble: [
            `# Subagent resume script for ${name}`,
            `# Generated: ${new Date().toISOString()}`,
            `# Session: ${params.sessionPath}`,
            `# Pane: ${surface}`,
          ].join("\n"),
        });

        const running: RunningSubagent = {
          id,
          name,
          task: params.message ?? "resumed session",
          surface,
          startTime,
          sessionFile: params.sessionPath,
          launchScriptFile,
          activityFile,
          interactive: !autoExit,
          statusState: createStatusState({ startTimeMs: startTime }),
        };
        runningSubagents.set(id, running);
        trackSubagent(pi, running);

        return reply(`Session "${name}" resumed in a tmux pane. ${LAUNCH_CONTRACT}`, {
          id,
          name,
          sessionPath: params.sessionPath,
          launchScriptFile,
          status: "started",
        });
      }

      // launch
      if (!params.name || !params.task) {
        return reply(
          'Missing name or task. Provide both to launch, or set action to list/status/send/interrupt/stop/resume.',
          { error: "missing name or task" },
          true,
        );
      }

      // Depth cap: children may delegate once, grandchildren never. Keeps a
      // runaway agent from filling the window with panes.
      const depth = Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0;
      const maxDepth = Number.parseInt(process.env.PI_SUBAGENT_MAX_DEPTH ?? "2", 10) || 2;
      if (depth >= maxDepth) {
        return reply(
          `Subagent depth limit reached (${depth}/${maxDepth}). Do this work yourself.`,
          { error: "depth limit" },
          true,
        );
      }

      const currentAgent = process.env.PI_SUBAGENT_AGENT;
      if (params.agent && currentAgent && params.agent === currentAgent) {
        return reply(
          `You are the ${currentAgent} agent — do not start another ${currentAgent}. Do the work yourself.`,
          { error: "self-spawn blocked" },
          true,
        );
      }

      let running: RunningSubagent;
      try {
        running = await launchSubagent(params as LaunchParams, launchCtx);
      } catch (error: any) {
        const message = `Launch failed: ${error?.message ?? String(error)}`;
        return reply(message, { error: message }, true);
      }
      trackSubagent(pi, running);

      return reply(
        `Sub-agent "${params.name}" launched in a tmux pane and is running in the background. ${LAUNCH_CONTRACT}`,
        {
          id: running.id,
          name: params.name,
          task: params.task,
          agent: params.agent,
          model: running.model,
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

  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }
      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      if (!loadAgentDefaults(agentName)) {
        ctx.ui.notify(`Agent "${agentName}" not found in bundled, ~/.pi/agent/agents/, or .pi/agents/`, "error");
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      pi.sendUserMessage(
        `Use tmux_subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`,
      );
    },
  });

  pi.registerCommand("iterate", {
    description: "Fork this session into a subagent pane for focused work",
    handler: async (args) => {
      const task = args.trim();
      pi.sendUserMessage(
        `Use tmux_subagent to fork this session. fork: true, name: "Iterate", task: ${JSON.stringify(
          task || "The user wants to do some hands-on work. Help them with whatever they need.",
        )}`,
      );
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

export const __test__ = {
  borderLine,
  buildChildToolAllowlist,
  buildPiPromptArgs,
  discoverAgentDefinitions,
  formatElapsed,
  formatWidgetRightLabel,
  getShellReadyDelayMs,
  loadAgentDefaults,
  observeRunningSubagent,
  parseAgentDefinition,
  renderSubagentWidgetLines,
  resolveDenyTools,
  resolveEffectiveInteractive,
  resolveLaunchBehavior,
  resolveResultPresentation,
  resolveTarget,
  runningSubagents,
};
