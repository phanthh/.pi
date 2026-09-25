/**
 * Child-side extension, loaded into every subagent session with `-e`.
 *
 * - Writes the activity snapshot the parent widget reads (liveness).
 * - `subagent_done` — self-terminate and hand the last assistant message back.
 * - `caller_ping` — ask the parent for help, then exit for later resume.
 * - Identity/tools widget above the editor (Ctrl+J toggles).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { writeFileSync } from "node:fs";
import { Type } from "typebox";
import { createSubagentActivityRecorder } from "./activity.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

/**
 * Manual input must not strand an auto-exit subagent: if the latest agent turn
 * completed normally, close the session. Escape/abort leaves it open.
 * stopReason "error" also exits so the parent gets woken — paired with
 * findLatestAssistantError() so it learns it was an error, not a completion.
 */
export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
  runningChildren = 0,
): boolean {
  // Exiting would abort our own children's watchers and kill their panes;
  // their results steer back in and trigger the turn that ends us.
  if (runningChildren > 0) return false;
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") return msg.stopReason !== "aborted";
    }
  }
  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

export function findLatestAssistantError(messages: any[] | undefined): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

/**
 * Own subagents + pending autoExit tmux panes whose results will steer back.
 * Read via Symbol.for keys, not imports: index.ts has load-time side effects
 * and the tmux extension is a separate package.
 */
export function runningChildCount(): number {
  const g = globalThis as any;
  const size = (key: string) => (g[Symbol.for(key)] as Map<string, unknown> | undefined)?.size ?? 0;
  return size("pi-tmux-subagents/running") + size("pi-tmux/auto-exit-watchers");
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));
        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");
          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));
          const deniedLine =
            denied.length > 0
              ? "\n" +
                theme.fg("muted", "denied: ") +
                denied.map((name: string) => theme.fg("error", name)).join(theme.fg("muted", ", "))
              : "";
          box.addChild(new Text(`${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`, 0, 0));
        } else {
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");
          box.addChild(new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0));
        }
        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;

  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    toolNames = pi.getAllTools().map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);
    if (ctx.hasUI) renderWidget(ctx);
  });

  pi.on("input", () => {
    recorder.input();
    // The initial task message is not a takeover; only inputs after the first run are.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", () => recorder.beforeAgentStart());

  pi.on("agent_start", () => {
    agentStarted = true;
    recorder.agentStart();
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;
    const shouldExit = autoExit && shouldAutoExitOnAgentEnd(userTookOver, messages, runningChildCount());

    if (shouldExit) {
      // Surface retry-exhausted turns through the .exit sidecar; without it the
      // parent sees exit code 0 plus a stale message and calls the crash a success.
      const errorInfo = findLatestAssistantError(messages);
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (errorInfo && sessionFile) {
        try {
          writeFileSync(
            `${sessionFile}.exit`,
            JSON.stringify({ type: "error", errorMessage: errorInfo.errorMessage, stopReason: errorInfo.stopReason }),
          );
        } catch {}
      }
      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    recorder.agentEndWaiting();
    // Auto-exit hinges on whether the last turn completed, not on who started it.
    if (autoExit) userTookOver = false;
  });

  pi.on("turn_start", (event) => recorder.turnStart((event as any).turnIndex));
  pi.on("turn_end", (event) => recorder.turnEnd((event as any).turnIndex));
  pi.on("before_provider_request", () => recorder.beforeProviderRequest());
  pi.on("after_provider_response", () => recorder.afterProviderResponse());
  pi.on("message_update", (event) => recorder.messageUpdate((event as any).assistantMessageEvent?.type));
  pi.on("tool_execution_start", (event) =>
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName),
  );
  pi.on("tool_call", (event) => recorder.toolCall((event as any).toolCallId, (event as any).toolName));
  pi.on("tool_execution_update", (event) =>
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName),
  );
  pi.on("tool_result", (event) => recorder.toolResult((event as any).toolCallId, (event as any).toolName));
  pi.on("tool_execution_end", (event) =>
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName),
  );
  pi.on("session_shutdown", (event) => recorder.sessionShutdown((event as any).reason));

  pi.registerShortcut("ctrl+alt+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent is notified with your message and can resume this session with a response. " +
      "Use when you are stuck, need clarification, or need the parent to act.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error("caller_ping is only available in subagent contexts (PI_SUBAGENT_SESSION unset).");
      }

      recorder.callerPing();
      writeFileSync(
        `${sessionFile}.exit`,
        JSON.stringify({
          type: "ping",
          name: process.env.PI_SUBAGENT_NAME ?? "subagent",
          message: params.message,
        }),
      );

      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Ping sent. Session exits and the parent is notified." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call when your task is complete. Closes this session and returns your results to the caller. " +
      "Your LAST assistant message before this call becomes the summary.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const children = runningChildCount();
      if (children > 0) {
        throw new Error(
          `${children} of your subagent(s)/autoExit tmux pane(s) still running; exiting now would lose their results. ` +
            "End your turn and wait — their results steer back automatically — then call subagent_done.",
        );
      }
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      recorder.subagentDone();
      if (sessionFile) writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
      ctx.shutdown();
      return { content: [{ type: "text", text: "Shutting down subagent session." }], details: {} };
    },
  });
}
