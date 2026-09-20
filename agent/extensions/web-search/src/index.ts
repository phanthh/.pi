/**
 * web_search — minimal SearXNG search tool.
 * Base URL from ~/.pi/agent/web-search.json ({ "searxngBaseUrl": ... }),
 * else SEARXNG_URL env, else http://localhost:8888.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_BASE_URL = "http://localhost:8888";
const DEFAULT_MAX_RESULTS = 8;
const MAX_RESULTS_LIMIT = 50;
const TIMEOUT_MS = 15_000;

interface SearchResult {
	title: string;
	url: string;
	content?: string;
	engine?: string;
	publishedDate?: string;
}

interface SearchDetails {
	query: string;
	count: number;
	results: SearchResult[];
	answers?: string[];
	suggestions?: string[];
}

function resolveBaseUrl(): string {
	try {
		const config = JSON.parse(
			readFileSync(join(getAgentDir(), "web-search.json"), "utf-8"),
		);
		if (typeof config.searxngBaseUrl === "string" && config.searxngBaseUrl) {
			return config.searxngBaseUrl.replace(/\/+$/, "");
		}
	} catch {
		/* no config */
	}
	return (process.env.SEARXNG_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function asStrings(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out = value.filter(
		(v): v is string => typeof v === "string" && v.trim().length > 0,
	);
	return out.length > 0 ? out : undefined;
}

function snippet(value: string | undefined, max = 240): string | undefined {
	if (!value) return undefined;
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function hostname(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using a local SearXNG instance. Returns titles, URLs, and snippets. Use web_fetch to read page contents.",
		promptSnippet:
			"web_search(query, max_results?): search web via local SearXNG; returns compact results, use web_fetch to read pages",

		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			max_results: Type.Optional(
				Type.Number({
					description: `Max results. Default: ${DEFAULT_MAX_RESULTS}`,
					minimum: 1,
					maximum: MAX_RESULTS_LIMIT,
				}),
			),
			categories: Type.Optional(
				Type.String({
					description:
						"Comma-separated SearXNG categories (e.g. general, it, science, news)",
				}),
			),
			time_range: Type.Optional(
				Type.Union(
					[Type.Literal("day"), Type.Literal("month"), Type.Literal("year")],
					{ description: "Restrict results to time range" },
				),
			),
			page: Type.Optional(
				Type.Number({ description: "Result page. Default: 1", minimum: 1 }),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const baseUrl = resolveBaseUrl();
			const maxResults = Math.min(
				MAX_RESULTS_LIMIT,
				Math.max(1, Math.floor(params.max_results ?? DEFAULT_MAX_RESULTS)),
			);

			const url = new URL("/search", `${baseUrl}/`);
			url.searchParams.set("q", params.query);
			url.searchParams.set("format", "json");
			url.searchParams.set("pageno", String(Math.max(1, params.page ?? 1)));
			if (params.categories)
				url.searchParams.set("categories", params.categories);
			if (params.time_range)
				url.searchParams.set("time_range", params.time_range);

			let response: Response;
			try {
				response = await fetch(url, {
					headers: { Accept: "application/json" },
					signal: AbortSignal.any([
						AbortSignal.timeout(TIMEOUT_MS),
						...(signal ? [signal] : []),
					]),
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (/fetch failed|ECONNREFUSED/.test(message)) {
					throw new Error(
						`Could not connect to SearXNG at ${baseUrl}. Check docker compose service is running.`,
					);
				}
				throw err;
			}

			if (!response.ok) {
				throw new Error(
					`SearXNG search failed: HTTP ${response.status} ${response.statusText}`,
				);
			}

			const data = (await response.json()) as {
				results?: unknown;
				answers?: unknown;
				suggestions?: unknown;
			};

			const seen = new Set<string>();
			const results: SearchResult[] = [];
			for (const item of Array.isArray(data.results) ? data.results : []) {
				if (!item || typeof item !== "object") continue;
				const r = item as Record<string, unknown>;
				if (typeof r.url !== "string" || seen.has(r.url)) continue;
				seen.add(r.url);
				results.push({
					title: typeof r.title === "string" && r.title ? r.title : r.url,
					url: r.url,
					content: typeof r.content === "string" ? r.content : undefined,
					engine: typeof r.engine === "string" ? r.engine : undefined,
					publishedDate:
						typeof r.publishedDate === "string" ? r.publishedDate : undefined,
				});
				if (results.length >= maxResults) break;
			}

			const details: SearchDetails = {
				query: params.query,
				count: results.length,
				results,
				answers: asStrings(data.answers),
				suggestions: asStrings(data.suggestions),
			};

			const lines: string[] = [];
			if (details.answers?.length) {
				lines.push(`Answers: ${details.answers.join(" | ")}`, "");
			}
			if (results.length === 0) {
				lines.push(`No results for: ${params.query}`);
				if (details.suggestions?.length) {
					lines.push(`Suggestions: ${details.suggestions.join(", ")}`);
				}
			} else {
				lines.push(`Search results for: ${params.query}`, "");
				results.forEach((r, i) => {
					lines.push(`${i + 1}. ${r.title}`);
					lines.push(`   URL: ${r.url}`);
					const s = snippet(r.content);
					if (s) lines.push(`   ${s}`);
					const meta = [r.engine, r.publishedDate].filter(Boolean).join(" · ");
					if (meta) lines.push(`   ${meta}`);
					if (i < results.length - 1) lines.push("");
				});
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details,
			};
		},

		renderCall(args, theme) {
			const query = typeof args.query === "string" ? args.query : "...";
			return new Text(
				theme.fg("toolTitle", theme.bold("search ")) +
					theme.fg("accent", query),
				0,
				0,
			);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Searching…"), 0, 0);
			}
			const details = result.details as SearchDetails | undefined;
			if (!details) {
				return new Text(theme.fg("muted", "No search details."), 0, 0);
			}
			if (details.results.length === 0) {
				return new Text(
					theme.fg("muted", `No results for ${details.query}`),
					0,
					0,
				);
			}

			const lines = [
				theme.fg("toolTitle", theme.bold(`Results (${details.count})`)),
			];
			details.results.forEach((r, i) => {
				lines.push(
					`${i + 1}. ${theme.fg("text", r.title)} ${theme.fg("muted", "—")} ${theme.fg("accent", hostname(r.url))}`,
				);
				if (expanded) {
					lines.push(`   ${theme.fg("dim", r.url)}`);
					const s = snippet(r.content, 160);
					if (s) lines.push(`   ${theme.fg("muted", s)}`);
				}
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
