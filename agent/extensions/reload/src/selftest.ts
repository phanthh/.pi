import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import extension, { isInsidePiConfig } from "./index.ts";
import { installToolContextReloadPatch } from "./runtime-reload.ts";

const load = async () => {
	let tool: any;
	let sessionStart: any;
	const sentMessages: any[] = [];
	await extension({
		on(event: string, handler: any) {
			if (event === "session_start") sessionStart = handler;
		},
		registerTool(value: any) {
			tool = value;
		},
		sendMessage(message: any, options: any) {
			sentMessages.push({ message, options });
		},
	} as never);
	return { tool, sessionStart, sentMessages };
};

assert.equal(isInsidePiConfig(join(homedir(), ".pi", "agent")), true);
assert.equal(isInsidePiConfig(join(homedir(), ".pi-other")), false);
assert.equal(isInsidePiConfig("/tmp"), false);
assert.equal(await installToolContextReloadPatch(), true);

const originalCwd = process.cwd();
process.chdir("/tmp");
assert.equal((await load()).tool, undefined);
process.chdir(originalCwd);

const { tool } = await load();
assert.equal(tool.name, "reload_pi");
let reloads = 0;
const result = await tool.execute("call", {}, undefined, undefined, {
	isIdle: () => true,
	reload: async () => {
		reloads += 1;
	},
});
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(reloads, 1);
assert.equal(result.content[0].text, "Pi runtime reload scheduled.");

const reloaded = await load();
await reloaded.sessionStart({ type: "session_start", reason: "reload" });
await new Promise((resolve) => setTimeout(resolve, 10));
assert.deepEqual(reloaded.sentMessages, [
	{
		message: {
			customType: "reload-continuation",
			content: "Pi runtime reloaded. Continue the task immediately from where you left off.",
			display: false,
		},
		options: { triggerTurn: true },
	},
]);
await reloaded.sessionStart({ type: "session_start", reason: "reload" });
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(reloaded.sentMessages.length, 1);

console.log("reload self-check passed");
