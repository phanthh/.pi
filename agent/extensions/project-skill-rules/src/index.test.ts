import assert from "node:assert/strict";
import test from "node:test";
import { CombinedAutocompleteProvider, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { filterSkillAutocomplete, findAllowedSkills, isGlobalSkill, parseConfig, type SkillRulesConfig } from "./index.ts";

const config: SkillRulesConfig = {
	rules: [
		{ path: "*", skills: ["fallback"] },
		{ path: "~/dev", skills: ["dev"] },
		{ path: "~/dev/pi", skills: ["pi"] },
	],
};

test("uses longest matching project path", () => {
	assert.deepEqual([...findAllowedSkills("/home/me/dev/pi/src", config, "/home/me")!], ["pi"]);
	assert.deepEqual([...findAllowedSkills("/home/me/dev/app", config, "/home/me")!], ["dev"]);
});

test("uses wildcard fallback without matching sibling prefixes", () => {
	assert.deepEqual([...findAllowedSkills("/home/me/developer", config, "/home/me")!], ["fallback"]);
	assert.deepEqual([...findAllowedSkills("/tmp/project", config, "/home/me")!], ["fallback"]);
});

test("supports multiple paths per rule", () => {
	const rules: SkillRulesConfig = {
		rules: [
			{ path: ["~/work/one", "~/work/two"], skills: ["shared"] },
			{ path: "*", skills: ["fallback"] },
		],
	};

	assert.deepEqual([...findAllowedSkills("/home/me/work/one/src", rules, "/home/me")!], ["shared"]);
	assert.deepEqual([...findAllowedSkills("/home/me/work/two", rules, "/home/me")!], ["shared"]);
});

test("supports regex paths with home expansion", () => {
	const rules: SkillRulesConfig = {
		rules: [
			{ path: "^~/dev/mml[^/]*(?:/|$)", regex: true, skills: [] },
			{ path: "*", skills: ["fallback"] },
		],
	};

	assert.deepEqual([...findAllowedSkills("/home/me/dev/mml", rules, "/home/me")!], []);
	assert.deepEqual([...findAllowedSkills("/home/me/dev/mml-api/src", rules, "/home/me")!], []);
	assert.deepEqual([...findAllowedSkills("/home/me/dev/other", rules, "/home/me")!], ["fallback"]);
});

test("literal paths take precedence over regex paths", () => {
	const rules: SkillRulesConfig = {
		rules: [
			{ path: "^~/dev/", regex: true, skills: ["regex"] },
			{ path: "~/dev/pi", skills: ["pi"] },
		],
	};

	assert.deepEqual([...findAllowedSkills("/home/me/dev/pi", rules, "/home/me")!], ["pi"]);
});

test("rejects invalid path arrays and regex", () => {
	assert.throws(() => parseConfig('{"rules":[{"path":[],"skills":[]}]}'));
	assert.throws(() => parseConfig('{"rules":[{"path":"[","regex":true,"skills":[]}]}'));
});

test("leaves skills unrestricted when no rule matches", () => {
	assert.equal(findAllowedSkills("/tmp/project", { rules: [] }, "/home/me"), undefined);
});

test("filters slash autocomplete and re-reads the allowlist", async () => {
	const current = new CombinedAutocompleteProvider([
		{ name: "help" }, { name: "skill:allowed" }, { name: "skill:blocked" }, { name: "skill:global" },
	], "/tmp");
	let allowed: ReadonlySet<string> | undefined = new Set(["allowed", "global"]);
	const provider = filterSkillAutocomplete(current, () => allowed);
	const options = { signal: new AbortController().signal };
	assert.deepEqual((await provider.getSuggestions(["/"], 0, 1, options))?.items.map((item) => item.value),
		["help", "skill:allowed", "skill:global"]);
	assert.equal(await provider.getSuggestions(["/blocked"], 0, 8, options), null);
	const item = { value: "skill:allowed", label: "skill:allowed" };
	assert.deepEqual(provider.applyCompletion(["/"], 0, 1, item, "/"),
		current.applyCompletion(["/"], 0, 1, item, "/"));

	allowed = new Set(["global"]);
	assert.deepEqual((await provider.getSuggestions(["/"], 0, 1, options))?.items.map((item) => item.value),
		["help", "skill:global"]);
	allowed = undefined;
	assert.deepEqual(await provider.getSuggestions(["/"], 0, 1, options),
		await current.getSuggestions(["/"], 0, 1, options));
	allowed = new Set(["*"]);
	assert.deepEqual(await provider.getSuggestions(["/"], 0, 1, options),
		await current.getSuggestions(["/"], 0, 1, options));
});

test("leaves path and argument completions unchanged", async () => {
	const result = { prefix: "/tmp/", items: [{ value: "skill:file", label: "file" }] };
	const current: AutocompleteProvider = {
		triggerCharacters: ["@"],
		getSuggestions: async () => result,
		applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		shouldTriggerFileCompletion: () => true,
	};
	const provider = filterSkillAutocomplete(current, () => { throw new Error("not a slash command"); });
	assert.equal(await provider.getSuggestions(["/tmp/"], 0, 5, { signal: new AbortController().signal }), result);
	result.prefix = "/command ";
	assert.equal(await provider.getSuggestions(["/command "], 0, 9, { signal: new AbortController().signal }), result);
	assert.deepEqual(provider.triggerCharacters, ["@"]);
	assert.equal(provider.shouldTriggerFileCompletion?.([""], 0, 0), true);
});

test("recognizes only skills inside the global skills directory", () => {
	assert.equal(isGlobalSkill({ filePath: "/home/me/.pi/agent/skills/review/SKILL.md" }, "/home/me/.pi/agent/skills"), true);
	assert.equal(isGlobalSkill({ filePath: "/home/me/project/.pi/skills/review/SKILL.md" }, "/home/me/.pi/agent/skills"), false);
	assert.equal(isGlobalSkill({ filePath: "/home/me/.pi/agent/skills-old/review/SKILL.md" }, "/home/me/.pi/agent/skills"), false);
});
