import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface SkillRule {
	path: string | string[];
	regex?: boolean;
	skills: string[];
}

export interface SkillRulesConfig {
	rules: SkillRule[];
}

const CONFIG_PATH = resolve(getAgentDir(), "project-skill-rules.json");

function resolveRulePath(path: string, home: string): string {
	if (path === "~") return resolve(home);
	if (path.startsWith(`~${sep}`) || path.startsWith("~/")) return resolve(home, path.slice(2));
	return resolve(path);
}

function isWithin(path: string, root: string): boolean {
	const child = relative(root, path);
	return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compilePathRegex(pattern: string, home: string): RegExp {
	const homePattern = escapeRegex(resolve(home));
	const expanded = pattern.replace(/^(\^?)~(?=\/|$)/, `$1${homePattern}`);
	return new RegExp(expanded);
}

export function findAllowedSkills(
	cwd: string,
	config: SkillRulesConfig,
	home = homedir(),
): ReadonlySet<string> | undefined {
	let best: { depth: number; skills: string[] } | undefined;
	const normalizedCwd = resolve(cwd);

	for (const rule of config.rules) {
		for (const path of Array.isArray(rule.path) ? rule.path : [rule.path]) {
			if (rule.regex) {
				if (compilePathRegex(path, home).test(normalizedCwd) && (!best || best.depth < 0)) {
					best = { depth: 0, skills: rule.skills };
				}
				continue;
			}

			if (path === "*") {
				best ??= { depth: -1, skills: rule.skills };
				continue;
			}

			const root = resolveRulePath(path, home);
			if (!isWithin(normalizedCwd, root)) continue;
			if (!best || root.length > best.depth) best = { depth: root.length, skills: rule.skills };
		}
	}

	return best ? new Set(best.skills) : undefined;
}

export function parseConfig(text: string): SkillRulesConfig {
	const value: unknown = JSON.parse(text);
	const invalid = () =>
		new Error('expected { "rules": [{ "path": string | string[], "regex"?: boolean, "skills": string[] }] }');
	if (!value || typeof value !== "object" || !("rules" in value) || !Array.isArray(value.rules)) {
		throw invalid();
	}

	const rules: SkillRule[] = [];
	for (const rule of value.rules) {
		if (
			!rule ||
			typeof rule !== "object" ||
			!("path" in rule) ||
			(typeof rule.path !== "string" &&
				(!Array.isArray(rule.path) ||
					rule.path.length === 0 ||
					!rule.path.every((path: unknown) => typeof path === "string"))) ||
			("regex" in rule && typeof rule.regex !== "boolean") ||
			!("skills" in rule) ||
			!Array.isArray(rule.skills) ||
			!rule.skills.every((skill: unknown) => typeof skill === "string")
		) {
			throw invalid();
		}
		const parsedRule: SkillRule = { path: rule.path, skills: rule.skills };
		if ("regex" in rule) parsedRule.regex = rule.regex;
		if (parsedRule.regex) {
			for (const path of Array.isArray(parsedRule.path) ? parsedRule.path : [parsedRule.path]) {
				compilePathRegex(path, homedir());
			}
		}
		rules.push(parsedRule);
	}

	return { rules };
}

function loadAllowedSkills(cwd: string): ReadonlySet<string> | undefined {
	if (!existsSync(CONFIG_PATH)) return undefined;
	return findAllowedSkills(cwd, parseConfig(readFileSync(CONFIG_PATH, "utf8")));
}

function permits(allowed: ReadonlySet<string> | undefined, skillName: string): boolean {
	return allowed === undefined || allowed.has("*") || allowed.has(skillName);
}

export default function projectSkillRules(pi: ExtensionAPI): void {
	let reportedError: string | undefined;

	function allowedFor(cwd: string, notify: (message: string) => void): ReadonlySet<string> | undefined {
		try {
			const allowed = loadAllowedSkills(cwd);
			reportedError = undefined;
			return allowed;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message !== reportedError) {
				reportedError = message;
				notify(`Invalid ${CONFIG_PATH}: ${message}. Blocking skills.`);
			}
			return new Set();
		}
	}

	pi.on("before_agent_start", (event, ctx) => {
		const allowed = allowedFor(ctx.cwd, (message) => ctx.ui.notify(message, "error"));
		event.systemPromptOptions.skills = (event.systemPromptOptions.skills ?? []).filter((skill) =>
			permits(allowed, skill.name),
		);
	});

	pi.on("input", (event, ctx) => {
		const command = event.text.match(/^\/skill:([^\s]+)/);
		if (!command) return { action: "continue" as const };

		const skillName = command[1].replace(/:\d+$/, "");
		const allowed = allowedFor(ctx.cwd, (message) => ctx.ui.notify(message, "error"));
		if (permits(allowed, skillName)) return { action: "continue" as const };

		ctx.ui.notify(`Skill "${skillName}" is not allowed for ${ctx.cwd}`, "warning");
		return { action: "handled" as const };
	});
}
