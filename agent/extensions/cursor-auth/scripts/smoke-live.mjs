#!/usr/bin/env node
/** Explicitly opt-in live smoke test. Sends only synthetic prompts and tool results. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.argv.includes("--live")) {
  console.error("Live inference is opt in: node scripts/smoke-live.mjs --live [--tool] [model IDs...]");
  process.exit(2);
}
process.env.PI_CURSOR_PROVIDER_DEBUG = "0";
const require = createRequire(import.meta.url);
const piRoot = process.env.PI_SMOKE_CORE_ROOT
  ?? dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const { createJiti } = require(require.resolve("jiti", { paths: [piRoot] }));
const jiti = createJiti(import.meta.url);
const extension = await jiti.import(new URL("../src/index.ts", import.meta.url).href);
const proxy = await jiti.import(new URL("../src/proxy.ts", import.meta.url).href);
const aiEntry = process.env.PI_SMOKE_AI_ROOT
  ? join(process.env.PI_SMOKE_AI_ROOT, "dist/index.js")
  : process.env.PI_SMOKE_CORE_ROOT
    ? join(piRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")
    : fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
const { streamSimple } = await import(pathToFileURL(join(dirname(aiEntry), "api/openai-completions.js")).href);
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")).cursor;
assert(auth?.access, "Cursor login required");
assert(!auth.expires || auth.expires > Date.now(), "Cursor token expired; login or refresh before testing");
let config;
const hooks = new Map();
const requested = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
const modelIds = requested.length ? requested : ["cursor-grok-4.6", "claude-fable-5-1", "gpt-5.6-sol"];
const toolMode = process.argv.includes("--tool");
const results = [];
try {
  await extension.default({
    on(event, callback) { hooks.set(event, callback); },
    registerProvider(id, next) { assert.equal(id, "cursor"); config = next; },
  });
  const proxyCredential = config.oauth.getApiKey(auth);
  assert.equal(proxyCredential, proxy.getProxyAuthToken());
  assert.notEqual(proxyCredential, auth.access);
  assert.notEqual(proxyCredential, "cursor-proxy");
  for (const id of modelIds) {
    const definition = config.models.find(model => model.id === id);
    assert(definition, `Model is not registered: ${id}`);
    const model = { ...definition, provider: "cursor", api: config.api, baseUrl: config.baseUrl };
    const sessionId = `synthetic-smoke-${randomUUID()}`;
    const tools = toolMode ? [{
      name: "echo_probe",
      description: "Returns the fixed synthetic probe result.",
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    }] : undefined;
    const context = {
      systemPrompt: "This is a synthetic connectivity test. No files, secrets, or real user data are involved.",
      messages: [{ role: "user", content: toolMode
        ? "Call echo_probe with value probe, then reply with exactly CURSOR_SMOKE_OK after its result."
        : "Reply with exactly CURSOR_SMOKE_OK.", timestamp: Date.now() }],
      ...(tools && { tools }),
    };
    const run = async () => {
      const events = [];
      const stream = streamSimple(model, context, {
        apiKey: proxyCredential, reasoning: "low", maxTokens: 512, signal: AbortSignal.timeout(60_000),
        onPayload(payload) {
          const ctx = { model, sessionManager: { getSessionId: () => sessionId } };
          return hooks.get("before_provider_request")?.({ payload }, ctx) ?? payload;
        },
      });
      for await (const event of stream) events.push(event.type);
      const message = await stream.result();
      assert(!["error", "aborted"].includes(message.stopReason), message.errorMessage ?? message.stopReason);
      return { message, events };
    };
    try {
      const first = await run();
      let last = first;
      if (toolMode) {
        const calls = first.message.content.filter(block => block.type === "toolCall");
        assert.equal(first.message.stopReason, "toolUse");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, "echo_probe");
        assert.equal(calls[0].arguments.value, "probe");
        context.messages.push(first.message, {
          role: "toolResult", toolCallId: calls[0].id, toolName: calls[0].name,
          content: [{ type: "text", text: "CURSOR_SMOKE_OK" }], isError: false, timestamp: Date.now(),
        });
        last = await run();
      }
      const text = last.message.content.filter(block => block.type === "text").map(block => block.text).join("");
      assert(text.includes("CURSOR_SMOKE_OK"), "Missing synthetic success marker");
      results.push({ id, mode: toolMode ? "tool-replay" : "text", ok: true, stopReason: last.message.stopReason, totalTokens: last.message.usage.totalTokens, streamed: last.events.includes("text_delta") });
    } catch (error) {
      results.push({ id, mode: toolMode ? "tool-replay" : "text", ok: false, error: error instanceof Error ? error.message : "Smoke test failed" });
      process.exitCode = 1;
    } finally {
      proxy.cleanupSessionState(sessionId);
    }
  }
} finally {
  proxy.stopProxy();
}
console.log(JSON.stringify(results, null, 2));
