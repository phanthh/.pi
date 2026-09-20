#!/usr/bin/env node
/**
 * Promote the live-discovered Cursor model list into the bundled fallback
 * snapshot (cursor-models-raw.json).
 *
 * The extension writes the models it discovers from Cursor's GetUsableModels
 * RPC to ~/.pi/agent/cursor-models-cache.json. This script copies that list
 * into the checked-in snapshot so a first-ever run (before any cache exists)
 * still registers current models instead of a stale baseline.
 *
 * Usage:
 *   1. Run pi with the cursor provider at least once so discovery populates
 *      the cache.
 *   2. pnpm refresh-models
 *   3. Commit the updated cursor-models-raw.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const cachePath = join(agentDir, "cursor-models-cache.json");
const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cursor-models-raw.json");

let cache;
try {
  cache = JSON.parse(readFileSync(cachePath, "utf-8"));
} catch (err) {
  console.error(`Could not read discovery cache at ${cachePath}: ${err.message}`);
  console.error("Run pi with the cursor provider first so discovery populates it.");
  process.exit(1);
}

const rawModels = Array.isArray(cache?.models) ? cache.models : [];
if (rawModels.length === 0) {
  console.error(`No discovered models found in ${cachePath}.`);
  process.exit(1);
}

// Only publish normalized catalog metadata, never arbitrary cached properties
// such as credentials from a raw model-discovery response.
const models = rawModels.map((model) => {
  if (!model || typeof model.id !== "string" || !model.id.trim()
    || typeof model.name !== "string" || typeof model.reasoning !== "boolean"
    || !Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0
    || !Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0) {
    throw new Error("Invalid cached model metadata; refusing to overwrite the bundled snapshot");
  }
  return {
    id: model.id, name: model.name, reasoning: model.reasoning,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens,
  };
});

models.sort((a, b) => String(a.id).localeCompare(String(b.id)));
writeFileSync(outPath, `${JSON.stringify(models, null, 2)}\n`, "utf-8");
console.log(`Wrote ${models.length} models to cursor-models-raw.json`);
