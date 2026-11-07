/**
 * Child-side extension, loaded into every subagent session with `-e`.
 *
 * - Writes the activity snapshot the parent widget reads (liveness).
 * - `subagent_done` — self-terminate and hand the last assistant message back.
 * - `caller_ping` — ask the parent for help (room message); session stays alive until the reply arrives.
 * - Delivers room messages (PI_ROOM inbox) into the session.
 * - Identity/tools widget above the editor (Ctrl+J toggles).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { writeFileSync } from "node:fs";
import { Type } from "typebox";
import { createSubagentActivityRecorder } from "./activity.ts";
import { drainInbox, formatRoomMessage, HOST, postMessage } from "./room.ts";

const INBOX_INTERVAL_KEY = Symbol.for("pi-tmux-subagents/child-inbox-interval");


export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

/**
 * Manual input must not strand a non-interactive subagent: if the latest agent turn
 * completed normally, close the session. Escape/abort leaves it open.
 * stopReason "error" also exits so the parent gets woken — paired with
 * findLatestAssistantError() so it learns it was an error, not a completion.
 */
export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
  runningChildren = 0,
  awaitingReply = false,
): boolean {
  // A caller_ping is a question, not a result: wait for the parent's reply.
  if (awaitingReply) return false;
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
 * Own subagents + pending tmux panes whose results will steer back.
 * Read via Symbol.for keys, not imports: index.ts has load-time side effects
 * and the tmux extension is a separate package.
 */
export function runningChildCount(keepWindows = false): number {
  const g = globalThis as any;
  const size = (key: string) => (g[Symbol.for(key)] as Map<string, unknown> | undefined)?.size ?? 0;
  return size("pi-tmux-subagents/running") + (keepWindows ? 0 : size("pi-tmux/auto-exit-watchers"));
}

/** Exiting now would kill pending children/panes and strand their results. */
export function pendingChildrenError(action: string, children = runningChildCount()): Error | null {
  if (children <= 0) return null;
  return new Error(
    `${children} of your subagent(s)/tmux pane(s) still running; ${action} now would exit and lose their results. ` +
      "End your turn instead — this session stays alive and their results steer back automatically. " +
      "To hand tmux run windows to your parent, call subagent_done with keepWindows: true. Running subagents still block finishing.",
  );
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
  // Interactive children (frontmatter `interactive`) stay up until subagent_done/stop/user quit.
  const autoExit = process.env.PI_SUBAGENT_INTERACTIVE !== "1";
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
  let awaitingReply = false;

  pi.on("session_start", (_event, ctx) => {
    // Resume and project defaults can omit codemode; keep the role's other tools unchanged.
    const activeTools = pi.getActiveTools();
    if (!activeTools.includes("codemode")) pi.setActiveTools([...activeTools, "codemode"]);
    recorder.sessionStart();
    toolNames = pi.getAllTools().map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);
    if (ctx.hasUI) renderWidget(ctx);
  });

  pi.on("input", () => {
    recorder.input();
    // Typed input (the user in the child's pane) also answers a pending ping.
    if (agentStarted) awaitingReply = false;
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
    const shouldExit = autoExit && shouldAutoExitOnAgentEnd(userTookOver, messages, runningChildCount(), awaitingReply);

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

    // Parent's idle note skips children whose own children will wake them.
    recorder.agentEndWaiting(runningChildCount());
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
  pi.on("session_shutdown", (event) => {
    clearInterval((globalThis as any)[INBOX_INTERVAL_KEY]);
    recorder.sessionShutdown((event as any).reason);
  });

  // Messages from the parent and siblings; a parent message also answers a caller_ping.
  const room = process.env.PI_ROOM;
  const g = globalThis as any;
  clearInterval(g[INBOX_INTERVAL_KEY]);
  if (room && subagentName) {
    g[INBOX_INTERVAL_KEY] = setInterval(() => {
      try {
        drainInbox(room, subagentName, (message) => {
          if (message.from === HOST) awaitingReply = false;
          pi.sendMessage(
            { customType: "room_message", content: formatRoomMessage(message), display: true, details: message },
            { triggerTurn: true, deliverAs: "steer" },
          );
        });
      } catch {}
    }, 1000);
    g[INBOX_INTERVAL_KEY].unref?.();
  }

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
      "Ask the parent agent for help or a decision. This session stays alive: after calling, end your turn; " +
      "the parent's reply arrives as your next message and you continue the task. " +
      "Use only when blocked and the parent must act or decide. Not for progress updates or FYIs; " +
      "to tell the parent something without stopping, use the room tool. " +
      "Never ping to say you are waiting on your own tmux panes/subagents: just end your turn; you stay alive and their results wake you.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const room = process.env.PI_ROOM;
      if (!room || !subagentName) {
        throw new Error("caller_ping is only available in subagent contexts (PI_ROOM unset).");
      }
      awaitingReply = true;
      recorder.callerPing();
      // A room message, not `.exit`: the parent keeps watching and answers through the room.
      postMessage(room, { from: subagentName, to: HOST, body: params.message, ts: Date.now(), ping: true });
      return {
        content: [
          {
            type: "text",
            text: "Ping sent. End your turn now; the parent's reply arrives as your next message. This session stays alive.",
          },
        ],
        details: {},
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call when your task is complete. Closes this session and returns your results to the caller. " +
      "Pass your final result as `message`; without it, your LAST assistant text becomes the summary. " +
      "Set keepWindows: true to hand live tmux-tool runs to the parent (ownership, widget, completion delivery). " +
      "Running subagents always block finishing.",
    executionMode: "sequential",
    parameters: Type.Object({
      message: Type.Optional(Type.String({ description: "Final result returned to the caller" })),
      keepWindows: Type.Optional(Type.Boolean({ description: "Hand live tmux-tool run windows to the parent instead of blocking completion" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const pending = pendingChildrenError("finishing", runningChildCount(params.keepWindows));
      if (pending) throw new Error(`${pending.message} Then call subagent_done.`);
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      let handedOverWindows: string[] = [];
      if (params.keepWindows) {
        const handover = g[Symbol.for("pi-tmux/handover-windows")] as ((parentPane: string) => Promise<string[]>) | undefined;
        const parentPane = process.env.PI_SUBAGENT_PARENT_PANE;
        if (handover && parentPane) handedOverWindows = await handover(parentPane);
        else if (runningChildCount() > 0) throw new Error("Cannot hand over windows: parent pane or tmux extension unavailable. End your turn and wait for completion instead.");
      }
      recorder.subagentDone();
      if (sessionFile) writeFileSync(`${sessionFile}.exit`, JSON.stringify({
        type: "done", summary: params.message, handedOverWindows,
      }));
      ctx.shutdown();
      const handoverNote = handedOverWindows.length ? ` Handed tmux windows to parent: ${handedOverWindows.join(", ")}.` : "";
      return {
        content: [{ type: "text", text: `Shutting down subagent session.${handoverNote}` }],
        details: { handedOverWindows },
        terminate: true,
      };
    },
  });
}

