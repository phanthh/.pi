import { afterEach, describe, expect, test } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
function fixture(models: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "cursor-refresh-test-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, ".pi", "agent"), { recursive: true });
  const script = join(root, "scripts", "refresh-models.mjs");
  copyFileSync(new URL("../scripts/refresh-models.mjs", import.meta.url), script);
  const agentDir = join(root, ".pi", "agent");
  writeFileSync(join(agentDir, "cursor-models-cache.json"), JSON.stringify({ models }));
  const snapshot = join(root, "src", "cursor-models-raw.json");
  writeFileSync(snapshot, "original snapshot\n");
  const run = () => spawnSync(process.execPath, [script], {
    env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir }, encoding: "utf8", timeout: 5_000,
  });
  return { run, snapshot };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    for (const path of ["scripts/refresh-models.mjs", ".pi/agent/cursor-models-cache.json", "src/cursor-models-raw.json"]) {
      const file = join(root, path);
      if (existsSync(file)) unlinkSync(file);
    }
    for (const path of ["scripts", "src", ".pi/agent", ".pi"]) rmdirSync(join(root, path));
    rmdirSync(root);
  }
});

describe("model snapshot refresh", () => {
  test("publishes only normalized fields and preserves privacy labels", () => {
    const model = {
      id: "claude-fable-5-1-high", name: "Claude Fable 5.1 (NO ZDR)",
      reasoning: true, contextWindow: 200_000, maxTokens: 64_000,
      credentials: { accessToken: "test" },
    };
    const { run, snapshot } = fixture([model]);
    expect(run().status).toBe(0);
    const text = readFileSync(snapshot, "utf8");
    expect(JSON.parse(text)).toEqual([{
      id: model.id, name: model.name, reasoning: true, contextWindow: 200_000, maxTokens: 64_000,
    }]);
    expect(text).not.toContain('"credentials"');
    expect(text).not.toContain('"accessToken"');
  });

  test.each([null, {}, { id: "bad", name: "Bad", reasoning: false, contextWindow: -1, maxTokens: 1 }])(
    "invalid cache does not overwrite the snapshot: %j", (model) => {
      const { run, snapshot } = fixture([model]);
      expect(run().status).not.toBe(0);
      expect(readFileSync(snapshot, "utf8")).toBe("original snapshot\n");
    },
  );
});
