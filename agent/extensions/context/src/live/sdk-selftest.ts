import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager, type AgentSession, type ExtensionUIContext, type Theme,
} from "@earendil-works/pi-coding-agent";
import { buildNativeSnapshot } from "../view/capture.ts";
import { LIVE_CONTEXT_SKILL_PATH } from "./document.ts";

const root = mkdtempSync(join(tmpdir(), "pi-context-sdk-test-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
let session: AgentSession | undefined;
try {
  writeFileSync(join(root, "om.json"), JSON.stringify({ liveContext: { mode: "all" }, sessionFallback: false }));
  writeFileSync(join(root, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 2_048, enabled: false } }));
  const { default: contextExtension } = await import("../index.ts");
  const faux = fauxProvider({ tokensPerSecond: Infinity, models: [{ id: "live-test", contextWindow: 200_000, maxTokens: 8_192 }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.create(root, root, { projectTrusted: false });
  const manager = SessionManager.create(root, join(root, "sessions"));
  const old = manager.appendMessage({ role: "user", content: "SDK_ORIGINAL_REQUEST", timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage("Original answer"));
  const livePath = `${manager.getSessionFile()}.context/live.md`;
  const errors: string[] = [];
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [contextExtension], systemPromptOverride: () => "Offline live-context integration test.",
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const created = await createAgentSession({
    cwd: root, agentDir: root, settingsManager, sessionManager: manager,
    resourceLoader: loader, modelRuntime, model: faux.getModel(), tools: ["read", "edit"], thinkingLevel: "off",
  });
  session = created.session;
  await session.bindExtensions({ onError: (error) => errors.push(error.error) });
  let observedEditedRequest = false;
  faux.setResponses([
    (context) => {
      assert.ok(JSON.stringify(context.messages).includes(livePath), "live-context file instructions reach real provider");
      assert.match(session!.systemPrompt, /<live_context>\n[\s\S]*\n<\/live_context>/);
      assert.ok(JSON.stringify(context.messages).includes(LIVE_CONTEXT_SKILL_PATH), "Skill reference reaches real provider");
      const snapshot = buildNativeSnapshot({
        systemPrompt: session!.systemPrompt, options: { cwd: root }, allTools: [], activeToolNames: [],
      });
      assert.ok(snapshot.groups.flatMap((group) => group.items).flatMap((item) => item.children ?? []).some((item) => item.label === "Live Context" && item.text.includes(livePath) && item.tokens > 0), "real injected instructions appear in context view");
      assert.match(readFileSync(livePath, "utf8"), /SDK_ORIGINAL_REQUEST/);
      return fauxAssistantMessage(fauxToolCall("edit", {
        path: livePath, edits: [{ oldText: "SDK_ORIGINAL_REQUEST", newText: "SDK_SHORT_FINDING" }],
      }), { stopReason: "toolUse" });
    },
    (context) => {
      const users = context.messages.filter((message) => message.role === "user");
      assert.ok(users.some((message) => JSON.stringify(message.content).includes("SDK_SHORT_FINDING")), "following real request uses accepted edit");
      assert.ok(!users.some((message) => JSON.stringify(message.content).includes("SDK_ORIGINAL_REQUEST")), "original user body not resurrected");
      observedEditedRequest = true;
      return fauxAssistantMessage("Edited context received.");
    },
  ]);
  await session.prompt("Edit the earlier user request using the live file, then confirm.");
  assert.equal(observedEditedRequest, true);
  assert.deepEqual(errors, []);
  const edit = manager.getBranch().find((entry) => entry.type === "custom" && entry.customType === "context.live.checkpoint");
  assert.ok(edit?.type === "custom" && edit.data && typeof edit.data === "object" && "entries" in edit.data && Array.isArray(edit.data.entries) && edit.data.entries.length, "checkpoint persisted in JSONL");
  assert.match(readFileSync(manager.getSessionFile()!, "utf8"), /SDK_ORIGINAL_REQUEST/, "raw archive is preserved");
  const reopened = SessionManager.open(manager.getSessionFile()!);
  assert.deepEqual(reopened.buildSessionProjection().messages, JSON.parse(JSON.stringify(manager.buildSessionProjection().messages)));
  assert.ok(reopened.getBranch().some((entry) => entry.type === "custom" && entry.customType === "context.live.checkpoint"));
  assert.doesNotMatch(session.systemPrompt, /<live_context>/, "Pi clears run-only prompt overrides after the model run");
  let inspectedUsage = false;
  let expectLiveInstructions = true;
  await session.bindExtensions({ mode: "tui", uiContext: {
    ...session.extensionRunner.createCommandContext().ui,
    custom: async (factory: any) => {
      const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
      const component = factory({ terminal: { rows: 1_000 }, requestRender: () => {} }, theme, {}, () => {});
      component.handleInput("\r");
      const preview = component.render(180).join("\n");
      if (expectLiveInstructions) {
        assert.match(preview, /<live_context>/, "actual /context System Prompt preview shows live instructions");
        assert.match(preview, /live\.md/);
        assert.equal(preview.split("<live_context>").length - 1, 1, "viewer shows live instructions once");
      } else {
        assert.doesNotMatch(preview, /<live_context>/, "disabled live instructions are excluded");
      }
      inspectedUsage = true;
    },
  } as ExtensionUIContext });
  await session.prompt("/context");
  assert.deepEqual(errors, []);
  assert.equal(inspectedUsage, true);
  await session.prompt("/context live off");
  expectLiveInstructions = false;
  await session.prompt("/context");
  await session.prompt("/context live on");
  expectLiveInstructions = true;
  await session.prompt("/context");
  assert.deepEqual(errors, []);
  await session.reload();
  assert.deepEqual(errors, []);
  assert.match(readFileSync(livePath, "utf8"), /SDK_SHORT_FINDING/);
  assert.ok(existsSync(`${manager.getSessionFile()}.context/writer.lock`));
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.ok(!existsSync(`${manager.getSessionFile()}.context/writer.lock`));
  console.log("live SDK selftest passed (real file tool → turn_end checkpoint → following request → JSONL reopen → reload)");
} finally {
  session?.dispose();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(root, { recursive: true, force: true });
}
