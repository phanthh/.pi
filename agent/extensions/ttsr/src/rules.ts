import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type InterruptMode = "always" | "never" | "prose-only" | "tool-only";

export interface ToolScope {
	// null = all tools; Map value null = no path filter for that tool
	tools: "all" | Map<string, RegExp[] | null>;
	text: boolean;
	thinking: boolean;
}

export interface TtsrRule {
	name: string;
	content: string;
	conditions: RegExp[];
	astConditions: string[];
	scope: ToolScope;
	interruptMode?: InterruptMode;
	globs: RegExp[];
	source: string;
}

// split on commas at depth 0 (parens/braces/brackets protected)
export function depthSplit(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = "";
	for (const c of s) {
		if ("({[".includes(c)) depth++;
		else if (")}]".includes(c)) depth--;
		if (c === "," && depth === 0) {
			out.push(cur);
			cur = "";
		} else cur += c;
	}
	out.push(cur);
	return out.map((s) => s.trim()).filter(Boolean);
}

export function globToRegex(glob: string): RegExp {
	let re = "";
	let brace = 0;
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "{") {
			brace++;
			re += "(?:";
		} else if (c === "}" && brace > 0) {
			brace--;
			re += ")";
		} else if (c === "," && brace > 0) re += "|";
		else if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
				if (glob[i + 1] === "/") i++;
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else if ("\\^$.|+()[]{}".includes(c)) re += `\\${c}`;
		else re += c;
	}
	return new RegExp(`^${re}$`);
}

export function pathMatches(patterns: RegExp[], paths: string[]): boolean {
	return paths.some((p) => {
		const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
		return patterns.some((re) => re.test(norm) || re.test(basename(norm)));
	});
}

// leading (?ims) inline flags → RegExp flags
export function compileCondition(src: string): RegExp | undefined {
	let flags = "";
	let body = src;
	const m = /^\(\?([ims]+)\)/.exec(body);
	if (m) {
		flags = m[1];
		body = body.slice(m[0].length);
	}
	try {
		return new RegExp(body, flags);
	} catch {
		return undefined;
	}
}

function parseScope(tokens: string[]): ToolScope | undefined {
	const scope: ToolScope = { tools: new Map(), text: false, thinking: false };
	let allTools = false;
	const toolMap = scope.tools as Map<string, RegExp[] | null>;
	for (const raw of tokens) {
		const tok = raw.trim();
		if (!tok) continue;
		if (tok === "text") scope.text = true;
		else if (tok === "thinking") scope.thinking = true;
		else if (tok === "tool" || tok === "toolcall") allTools = true;
		else {
			const m = /^(?:tool:)?([\w-]+)(?:\(([^)]*)\))?$/.exec(tok);
			if (!m) continue;
			const globs = m[2]
				? depthSplit(m[2]).map((g) => globToRegex(g.replace(/^["']|["']$/g, "")))
				: null;
			toolMap.set(m[1], globs);
		}
	}
	if (allTools) scope.tools = "all";
	else if (toolMap.size === 0 && !scope.text && !scope.thinking) return undefined;
	if (scope.tools !== "all" && (scope.tools as Map<string, unknown>).size === 0 && !scope.text && !scope.thinking)
		return undefined;
	return scope;
}

const DEFAULT_SCOPE: ToolScope = { tools: "all", text: true, thinking: false };

// minimal flat YAML: scalars, inline [a, b], dash lists
function parseFrontmatter(text: string): { meta: Record<string, string[]>; body: string } {
	const meta: Record<string, string[]> = {};
	if (!text.startsWith("---")) return { meta, body: text };
	const end = text.indexOf("\n---", 3);
	if (end === -1) return { meta, body: text };
	const body = text.slice(text.indexOf("\n", end + 1) + 1);
	const lines = text.slice(3, end).split("\n");
	let key: string | undefined;
	const unquote = (s: string) => {
		const t = s.trim();
		if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
			try {
				return JSON.parse(t) as string;
			} catch {
				return t.slice(1, -1);
			}
		}
		if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
		return t;
	};
	for (const line of lines) {
		const dash = /^\s+-\s+(.*)$/.exec(line);
		if (dash && key) {
			meta[key].push(unquote(dash[1]));
			continue;
		}
		const kv = /^([\w-]+):\s*(.*)$/.exec(line);
		if (!kv) continue;
		key = kv[1].replace(/[-_](\w)/g, (_, c) => c.toUpperCase());
		const val = kv[2].trim();
		meta[key] = [];
		if (!val) continue;
		if (val.startsWith("[") && val.endsWith("]")) {
			for (const part of val.slice(1, -1).split(",")) {
				const v = unquote(part);
				if (v) meta[key].push(v);
			}
		} else if (key === "scope" || key === "globs") meta[key] = depthSplit(unquote(val));
		else meta[key] = [unquote(val)];
	}
	return { meta, body };
}

export function parseRule(file: string): TtsrRule | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const { meta, body } = parseFrontmatter(text);
	const condSrc = meta.condition ?? meta.ttsrTrigger ?? [];
	const conditions = condSrc.map(compileCondition).filter((r): r is RegExp => !!r);
	const astConditions = (meta.astCondition ?? []).filter(Boolean);
	if (conditions.length === 0 && astConditions.length === 0) return undefined;
	const scope = meta.scope?.length ? parseScope(meta.scope) : DEFAULT_SCOPE;
	if (!scope) return undefined;
	const im = meta.interruptMode?.[0];
	return {
		name: basename(file).replace(/\.md$/, ""),
		content: body.trim(),
		conditions,
		astConditions,
		scope,
		interruptMode:
			im === "always" || im === "never" || im === "prose-only" || im === "tool-only" ? im : undefined,
		globs: (meta.globs ?? []).map(globToRegex),
		source: file,
	};
}

// later dirs win on name dup (pass global dir first, project dir last)
export function loadRules(dirs: string[]): Map<string, TtsrRule> {
	const rules = new Map<string, TtsrRule>();
	for (const dir of dirs) {
		let files: string[] = [];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".md"));
		} catch {
			continue;
		}
		for (const f of files.sort()) {
			const rule = parseRule(join(dir, f));
			if (rule) rules.set(rule.name, rule);
		}
	}
	return rules;
}
