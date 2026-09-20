import { spawn } from "node:child_process";
import { extname } from "node:path";
import { pathMatches, type TtsrRule } from "./rules.ts";

export interface MatchContext {
	source: "text" | "thinking" | "tool";
	toolName?: string;
	toolCallId?: string;
	paths: string[];
}

const EXT_LANG: Record<string, string> = {
	".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
	".tsx": "tsx",
	".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
	".jsx": "javascript",
	".py": "python", ".rs": "rust", ".go": "go", ".java": "java",
	".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
	".cs": "csharp", ".css": "css", ".html": "html", ".json": "json",
	".kt": "kotlin", ".lua": "lua", ".php": "php", ".rb": "ruby",
	".scala": "scala", ".swift": "swift", ".yaml": "yaml", ".yml": "yaml",
	".sh": "bash", ".bash": "bash", ".ex": "elixir", ".exs": "elixir",
};

export function inferLang(path: string): string | undefined {
	return EXT_LANG[extname(path).toLowerCase()];
}

export function astGrepMatch(pattern: string, lang: string, code: string): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawn("ast-grep", ["run", "-p", pattern, "-l", lang, "--stdin", "--json=compact"], {
			stdio: ["pipe", "pipe", "ignore"],
		});
		let out = "";
		const timer = setTimeout(() => proc.kill("SIGKILL"), 3000);
		proc.stdout.on("data", (d) => (out += d));
		proc.on("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
		proc.on("close", () => {
			clearTimeout(timer);
			try {
				resolve(Array.isArray(JSON.parse(out)) && JSON.parse(out).length > 0);
			} catch {
				resolve(false);
			}
		});
		proc.stdin.write(code);
		proc.stdin.end();
	});
}

export class TtsrManager {
	rules = new Map<string, TtsrRule>();
	disabled = new Set<string>();
	fired = new Set<string>();
	#buffers = new Map<string, string>();
	#astLast = new Map<string, string>();
	#astInFlight = new Set<string>();

	resetStream(): void {
		this.#buffers.clear();
		this.#astLast.clear();
		this.#astInFlight.clear();
	}

	appendBuffer(key: string, delta: string): string {
		const buf = (this.#buffers.get(key) ?? "") + delta;
		this.#buffers.set(key, buf);
		return buf;
	}

	setBuffer(key: string, snapshot: string): string {
		this.#buffers.set(key, snapshot);
		return snapshot;
	}

	eligible(rule: TtsrRule, ctx: MatchContext): boolean {
		if (this.disabled.has(rule.name) || this.fired.has(rule.name)) return false;
		const { scope } = rule;
		if (ctx.source === "text" && !scope.text) return false;
		if (ctx.source === "thinking" && !scope.thinking) return false;
		if (ctx.source === "tool") {
			if (scope.tools === "all") {
				// no per-tool filter
			} else {
				const globs = scope.tools.get(ctx.toolName ?? "");
				if (globs === undefined) return false;
				if (globs && !pathMatches(globs, ctx.paths)) return false;
			}
		}
		if (rule.globs.length > 0 && !pathMatches(rule.globs, ctx.paths)) return false;
		return true;
	}

	checkRegex(buffer: string, ctx: MatchContext): TtsrRule[] {
		const matches: TtsrRule[] = [];
		for (const rule of this.rules.values()) {
			if (rule.conditions.length === 0) continue;
			if (!this.eligible(rule, ctx)) continue;
			if (rule.conditions.some((re) => re.test(buffer))) matches.push(rule);
		}
		return matches;
	}

	// dedupe identical snapshots per stream key, skip if shellout in-flight
	async checkAst(key: string, snapshot: string, ctx: MatchContext): Promise<TtsrRule[]> {
		if (ctx.source !== "tool" || ctx.paths.length === 0) return [];
		const lang = inferLang(ctx.paths[0]);
		if (!lang) return [];
		const candidates = [...this.rules.values()].filter(
			(r) => r.astConditions.length > 0 && this.eligible(r, ctx),
		);
		if (candidates.length === 0) return [];
		if (this.#astInFlight.has(key) || this.#astLast.get(key) === snapshot) return [];
		this.#astLast.set(key, snapshot);
		this.#astInFlight.add(key);
		try {
			const matches: TtsrRule[] = [];
			for (const rule of candidates) {
				const results = await Promise.all(
					rule.astConditions.map((p) => astGrepMatch(p, lang, snapshot)),
				);
				if (results.some(Boolean)) matches.push(rule);
			}
			return matches;
		} finally {
			this.#astInFlight.delete(key);
		}
	}
}
