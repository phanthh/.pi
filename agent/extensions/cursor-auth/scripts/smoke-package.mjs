#!/usr/bin/env node
/** Load the package in an empty HOME and verify registration without external traffic. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { request } from "node:http";

process.env.PI_CURSOR_PROVIDER_DEBUG = "0";
const require = createRequire(import.meta.url);
const coreRoot = realpathSync(process.env.PI_SMOKE_CORE_ROOT
  ?? dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")))));
// Canonical paths avoid duplicate Jiti instances through macOS /tmp symlinks.
const root = realpathSync(process.env.PI_SMOKE_PACKAGE_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url))));
const { createJiti } = require(require.resolve("jiti", { paths: [coreRoot] }));
const jiti = createJiti(import.meta.url);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("External fetch is forbidden in offline package smoke tests"); };
const extension = await jiti.import(pathToFileURL(join(root, "src/index.ts")).href);
const proxy = await jiti.import(pathToFileURL(join(root, "src/proxy.ts")).href);
let config;
const hooks = new Set();
const get = (port, key) => new Promise((resolve, reject) => {
  const req = request({ hostname: "127.0.0.1", port, path: "/v1/models", headers: key ? { Authorization: `Bearer ${key}` } : {} }, res => {
    res.resume();
    res.on("end", () => resolve(res.statusCode));
  });
  req.setTimeout(5_000, () => req.destroy(new Error("Local proxy timeout")));
  req.on("error", reject);
  req.end();
});
try {
  await extension.default({
    on(name) { hooks.add(name); },
    registerProvider(id, next) { assert.equal(id, "cursor"); config = next; },
  });
  for (const id of ["claude-fable-5-1", "claude-fable-5-1-thinking", "cursor-grok-4.6", "cursor-grok-4.6-fast", "gpt-5.6-sol", "gemini-3.6-flash"]) {
    assert(config.models.some(model => model.id === id), `Missing model: ${id}`);
  }
  const fable = config.models.find(model => model.id === "claude-fable-5-1");
  assert(fable.name.includes("NO ZDR"));
  assert.equal(config.models.find(model => model.id === "default").reasoning, false);
  assert(hooks.has("before_provider_request"));
  assert(hooks.has("session_shutdown"));
  const port = proxy.getProxyPort();
  const token = proxy.getProxyAuthToken();
  assert(token && token !== "cursor-proxy");
  assert.equal(await get(port), 401);
  assert.equal(await get(port, token), 200);
  console.log(JSON.stringify({ ok: true, models: config.models.length, authentication: "enforced", privacyLabel: "preserved", externalFetches: 0 }));
} finally {
  proxy.stopProxy();
  globalThis.fetch = originalFetch;
}
