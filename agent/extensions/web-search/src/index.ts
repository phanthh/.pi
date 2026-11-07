/**
 * web_search — parallel SearXNG + DuckDuckGo HTML search.
 * Base URL from ~/.pi/agent/web-search.json ({ "searxngBaseUrl": ... }),
 * else SEARXNG_URL env, else http://localhost:8888.
 * Requests are spaced globally across pi processes (see throttle.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ExtensionAPI,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { search, type SearchDetails } from "./search.ts";

const DEFAULT_BASE_URL = "http://localhost:8888";
const DEFAULT_MAX_RESULTS = 8;
const MAX_RESULTS_LIMIT = 50;
const DEFAULT_MIN_INTERVAL_MS = 1_500;

function readConfig(): Record<string, unknown> {
	try {
		return JSON.parse(
			readFileSync(join(getAgentDir(), "web-search.json"), "utf-8"),
		);
	} catch {
		return {};
	}
}

function resolveBaseUrl(config: Record<string, unknown>): string {
	const configured =
		typeof config.searxngBaseUrl === "string" && config.searxngBaseUrl
			? config.searxngBaseUrl
			: process.env.SEARXNG_URL || DEFAULT_BASE_URL;
	return configured.replace(/\/+$/, "");
}

/** Min spacing between request starts across all pi processes on this host. */
function resolveMinInterval(config: Record<string, unknown>): number {
	const env = Number(process.env.PI_WEB_SEARCH_MIN_INTERVAL_MS);
	if (process.env.PI_WEB_SEARCH_MIN_INTERVAL_MS && Number.isFinite(env))
		return Math.max(0, env);
	return typeof config.minIntervalMs === "number" &&
		Number.isFinite(config.minIntervalMs)
		? Math.max(0, config.minIntervalMs)
		: DEFAULT_MIN_INTERVAL_MS;
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
			"Search SearXNG and DuckDuckGo HTML in parallel. Returns merged titles, URLs, snippets, and sources. Categories apply only to SearXNG; page > 1 uses SearXNG only. Use web_fetch to read page contents.",
		promptSnippet:
			"web_search(query, max_results?): search SearXNG + DuckDuckGo HTML; returns merged, source-labelled results, use web_fetch to read pages",

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
				Type.Number({ description: "Result page. Default: 1; page > 1 queries SearXNG only", minimum: 1 }),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const config = readConfig();
			const { details, isError } = await search({
				query: params.query,
				baseUrl: resolveBaseUrl(config),
				minIntervalMs: resolveMinInterval(config),
				maxResults: Math.min(
					MAX_RESULTS_LIMIT,
					Math.max(1, Math.floor(params.max_results ?? DEFAULT_MAX_RESULTS)),
				),
				page: Math.max(1, Math.floor(params.page ?? 1)),
				categories: params.categories,
				timeRange: params.time_range,
			}, signal);
			const { results } = details;
			const lines: string[] = [];
			if (details.answers?.length) {
				lines.push(`Answers: ${details.answers.join(" | ")}`, "");
			}
			if (results.length === 0) {
				lines.push(isError ? `Search failed for: ${params.query}` : `No results for: ${params.query}`);
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
					lines.push(`   Sources: ${r.sources.join(", ")}`);
					const meta = [r.engine, r.publishedDate].filter(Boolean).join(" · ");
					if (meta) lines.push(`   ${meta}`);
					if (i < results.length - 1) lines.push("");
				});
			}
			if (details.notes.length) lines.push("", ...details.notes);
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details,
				isError,
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
			if (!details || details.results.length === 0) {
				const message = result.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				return new Text(
					theme.fg(result.isError ? "error" : "muted", message),
					0,
					0,
				);
			}

			const lines = [
				theme.fg("toolTitle", theme.bold(`Results (${details.count})`)),
			];
			for (const note of details.notes ?? []) {
				lines.push(theme.fg("warning", note));
			}
			details.results.forEach((r, i) => {
				lines.push(
					`${i + 1}. ${theme.fg("text", r.title)} ${theme.fg("muted", "—")} ${theme.fg("accent", hostname(r.url))} ${theme.fg("muted", `[${r.sources?.join(", ") ?? r.engine ?? "SearXNG"}]`)}`,
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
