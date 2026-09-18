/**
 * new_topic: hard context cutover when latest user request is unrelated to
 * everything before it.
 *
 * Compaction cannot run inside tool execution because it would abort active
 * agent run. Tool terminates run; agent_end performs compaction, then invisible
 * continuation resumes retained latest user request without re-sending it.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface NewTopicDependencies {
  compactMarker: string;
  triggerInvisibleContinue: (pi: ExtensionAPI) => void;
}

export const registerNewTopic = (pi: ExtensionAPI, dependencies: NewTopicDependencies) => {
  let pending = false;
  let compacting = false;
  let generation = 0;

  const compact = (ctx: ExtensionContext) => {
    compacting = true;
    const runGeneration = ++generation;
    try {
      ctx.compact({
        customInstructions: `${dependencies.compactMarker} keep:1`,
        onComplete: () => {
          if (runGeneration !== generation) return;
          pending = compacting = false;
          ctx.ui.notify("context: new topic — prior context compacted", "info");
          dependencies.triggerInvisibleContinue(pi);
        },
        onError: (error) => {
          if (runGeneration !== generation) return;
          pending = compacting = false;
          ctx.ui.notify(`context: new topic failed: ${error.message}`, "error");
        },
      });
    } catch (error) {
      pending = compacting = false;
      ctx.ui.notify(
        `context: new topic failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  };

  pi.on("agent_end", (_event, ctx) => {
    if (!pending || compacting) return;
    compact(ctx);
  });

  pi.on("session_shutdown", () => {
    generation++;
    pending = compacting = false;
  });

  pi.registerTool({
    name: "new_topic",
    label: "New Topic",
    description:
      "Start a fresh context for the current request. Compacts everything before the latest user " +
      "message away, keeps that message, and continues working on it. Call this ONLY when the latest " +
      "user request is wholly unrelated to the preceding conversation — a sharp cutover to a different " +
      "task, project area, or question where no earlier detail is needed. Do NOT call it for a next " +
      "step, follow-up, subtask, refactor of prior work, or any request that benefits from earlier " +
      "context: losing that context would be unrecoverable for the current turn. When in doubt, do not " +
      "call it. Call it alone, as the only tool call in the turn, and stop afterwards: the work resumes " +
      "automatically once the context has been reset.",
    promptSnippet:
      "new_topic: reset the context when the latest user request is a sharp, wholly unrelated cutover.",
    promptGuidelines: [
      "Call new_topic only when the latest user request is wholly unrelated to the preceding " +
        "conversation, never for a follow-up or subtask of prior work; call it alone and stop, the " +
        "request is resumed automatically afterwards.",
    ],
    parameters: Type.Object({}),
    async execute() {
      if (pending) {
        return {
          content: [{ type: "text", text: "Context reset already queued. Stop and wait." }],
          details: undefined,
          terminate: true,
        };
      }
      pending = true;
      return {
        content: [
          {
            type: "text",
            text:
              "Context reset queued. End your turn now without any further tool call or answer — " +
              "the request resumes automatically after compaction. Do not call new_topic again.",
          },
        ],
        details: undefined,
        terminate: true,
      };
    },
  });
};
