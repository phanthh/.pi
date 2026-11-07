import { parseHTML } from "linkedom";
import { throttle } from "./throttle.ts";

const TIMEOUT_MS = 15_000;
const DDG_URL = "https://html.duckduckgo.com/html/";
type Source = "SearXNG" | "DuckDuckGo";

export interface SearchResult {
	title: string;
	url: string;
	content?: string;
	engine?: string;
	publishedDate?: string;
	sources: Source[];
}

interface BackendResult {
	results: SearchResult[];
	answers?: string[];
	suggestions?: string[];
	engineFailures?: string[];
}

export interface SearchDetails extends BackendResult {
	query: string;
	count: number;
	notes: string[];
}

interface SearchOptions {
	query: string;
	maxResults: number;
	page: number;
	categories?: string;
	timeRange?: "day" | "month" | "year";
	baseUrl: string;
	minIntervalMs: number;
}

function asStrings(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings = value.filter(
		(v): v is string => typeof v === "string" && v.trim().length > 0,
	);
	return strings.length ? strings : undefined;
}

/** Comparison only: retain original URL in output. Ignore tracking and fragments. */
function normalizedUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (!/^https?:$/.test(url.protocol)) return undefined;
		for (const key of [...url.searchParams.keys()]) {
			if (/^utm_/i.test(key)) url.searchParams.delete(key);
		}
		url.searchParams.sort();
		return `${url.host.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`;
	} catch {
		return undefined;
	}
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	return AbortSignal.any([
		AbortSignal.timeout(TIMEOUT_MS),
		...(signal ? [signal] : []),
	]);
}

async function searchSearxng(options: SearchOptions, signal?: AbortSignal): Promise<BackendResult> {
	const url = new URL("search", `${options.baseUrl}/`);
	url.searchParams.set("q", options.query);
	url.searchParams.set("format", "json");
	url.searchParams.set("pageno", String(options.page));
	if (options.categories) url.searchParams.set("categories", options.categories);
	if (options.timeRange) url.searchParams.set("time_range", options.timeRange);
	await throttle(options.minIntervalMs, signal);
	const response = await fetch(url, {
		headers: { Accept: "application/json" },
		signal: requestSignal(signal),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
	const data = await response.json() as Record<string, unknown> | null;
	if (!data || !Array.isArray(data.results)) {
		throw new Error("invalid response: expected a results array");
	}
	const engineFailures = Array.isArray(data.unresponsive_engines)
		? data.unresponsive_engines.flatMap((entry: unknown) =>
			Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string"
				? [`${entry[0]}: ${entry[1]}`] : [])
		: [];
	const results: SearchResult[] = [];
	for (const item of data.results) {
		if (!item || typeof item !== "object") continue;
		const r = item as Record<string, unknown>;
		if (typeof r.url !== "string" || !normalizedUrl(r.url)) continue;
		results.push({
			title: typeof r.title === "string" && r.title ? r.title : r.url,
			url: r.url,
			content: typeof r.content === "string" ? r.content : undefined,
			engine: typeof r.engine === "string" ? r.engine : undefined,
			publishedDate: typeof r.publishedDate === "string" ? r.publishedDate : undefined,
			sources: ["SearXNG"],
		});
	}
	return { results, answers: asStrings(data.answers), suggestions: asStrings(data.suggestions), engineFailures };
}

export function parseDuckDuckGo(html: string): SearchResult[] {
	const { document } = parseHTML(html);
	if (document.querySelector("#challenge-form, #anomaly-form, .anomaly-modal")) {
		throw new Error("CAPTCHA / bot challenge");
	}
	const results: SearchResult[] = [];
	for (const link of document.querySelectorAll("a.result__a")) {
		const href = link.getAttribute("href");
		if (!href) continue;
		let url: URL;
		try {
			url = new URL(href, DDG_URL);
			if (/(^|\.)duckduckgo\.com$/.test(url.hostname) && url.pathname === "/l/") {
				const target = url.searchParams.get("uddg");
				if (!target) continue;
				url = new URL(target);
			}
		} catch {
			continue;
		}
		if (!normalizedUrl(url.href)) continue;
		results.push({
			title: link.textContent?.trim() || url.href,
			url: url.href,
			content: link.closest(".result")?.querySelector(".result__snippet")?.textContent?.trim(),
			sources: ["DuckDuckGo"],
		});
	}
	if (!results.length && !document.querySelector(".no-results, .result--no-result")) {
		throw new Error("unrecognized HTML or blocked response (no result links)");
	}
	return results;
}

async function searchDuckDuckGo(options: SearchOptions, signal?: AbortSignal): Promise<BackendResult> {
	const url = new URL(DDG_URL);
	url.searchParams.set("q", options.query);
	if (options.timeRange) {
		url.searchParams.set("df", { day: "d", month: "m", year: "y" }[options.timeRange]);
	}
	await throttle(options.minIntervalMs, signal, "duckduckgo");
	// Same browser TLS approach as web-fetch, without article extraction. Load within
	// this backend so native-client failures cannot prevent SearXNG from working.
	const { fetch: browserFetch } = await import("wreq-js");
	const response = await browserFetch(url.href, {
		browser: "chrome_145",
		os: "windows",
		headers: { Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
		timeout: TIMEOUT_MS,
		signal: requestSignal(signal),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
	return { results: parseDuckDuckGo(await response.text()) };
}

/** Round-robin unique URLs; duplicates do not consume a source's turn. */
function mergeResults(lists: SearchResult[][], maxResults: number): SearchResult[] {
	const merged = new Map<string, SearchResult>();
	for (const list of lists) {
		for (const result of list) {
			const key = normalizedUrl(result.url)!;
			const existing = merged.get(key);
			if (!existing) merged.set(key, { ...result, sources: [...result.sources] });
			else {
				existing.sources = [...new Set([...existing.sources, ...result.sources])];
				existing.content ||= result.content;
			}
		}
	}
	const seen = new Set<string>();
	const output: SearchResult[] = [];
	const positions = lists.map(() => 0);
	while (output.length < maxResults) {
		let added = false;
		for (let i = 0; i < lists.length && output.length < maxResults; i++) {
			while (positions[i] < lists[i].length) {
				const key = normalizedUrl(lists[i][positions[i]++].url)!;
				if (seen.has(key)) continue;
				seen.add(key);
				output.push(merged.get(key)!);
				added = true;
				break;
			}
		}
		if (!added) break;
	}
	return output;
}

export async function search(options: SearchOptions, signal?: AbortSignal): Promise<{ details: SearchDetails; isError: boolean }> {
	const [searxng, ddg] = await Promise.allSettled([
		searchSearxng(options, signal),
		options.page === 1 ? searchDuckDuckGo(options, signal) : Promise.resolve(undefined),
	]);
	signal?.throwIfAborted();
	const notes: string[] = [];
	let failures = 0;
	const lists: SearchResult[][] = [];
	let searxData: BackendResult | undefined;
	for (const [name, outcome] of [["SearXNG", searxng], ["DuckDuckGo", ddg]] as const) {
		if (outcome.status === "rejected") {
			const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
			notes.push(`${name} failed: ${reason}`);
			failures++;
		} else if (outcome.value) {
			const data = outcome.value;
			lists.push(data.results);
			if (name === "SearXNG") searxData = data;
			if (data.engineFailures?.length) {
				notes.push(`SearXNG engine failures: ${data.engineFailures.join("; ")}`);
				if (!data.results.length && !data.answers?.length) failures++;
			}
		}
	}
	if (options.page > 1) notes.push("DuckDuckGo skipped: page > 1 uses SearXNG pagination only.");
	const results = mergeResults(lists, options.maxResults);
	return {
		details: {
			query: options.query,
			count: results.length,
			results,
			answers: searxData?.answers,
			suggestions: searxData?.suggestions,
			engineFailures: searxData?.engineFailures,
			notes,
		},
		isError: failures === (options.page === 1 ? 2 : 1),
	};
}
