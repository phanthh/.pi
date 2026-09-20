/**
 * web_fetch — unified multi-URL fetch and readable-content extraction.
 * Browser-grade TLS fingerprinting (wreq-js) + Defuddle extraction.
 * Always accepts urls[]; fans out with bounded concurrency.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type BatchFetchItemProgress,
	type BatchFetchProgressSnapshot,
	type BatchFetchResult,
	buildBatchFetchResponseText,
	buildFetchResponseText,
	executeBatchFetchToolCall,
	isFileFetchResult,
	type OutputFormat,
	resolveFetchToolDefaults,
} from "./core/index.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;

type RenderDetails = {
	batchProgress?: BatchFetchProgressSnapshot;
	batchResult?: BatchFetchResult;
	spinnerTick?: number;
};

function truncateMiddle(value: string, width: number): string {
	if (width <= 0) return "";
	if (value.length <= width) return value;
	if (width === 1) return "…";
	const left = Math.ceil((width - 1) / 2);
	const right = Math.floor((width - 1) / 2);
	return `${value.slice(0, left)}…${value.slice(value.length - right)}`;
}

function statusGlyph(
	item: BatchFetchItemProgress,
	spinnerIndex: number,
	theme: { fg(color: string, value: string): string },
): string {
	const frame = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length] ?? "⠋";
	switch (item.status) {
		case "done":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
		case "queued":
			return theme.fg("muted", frame);
		default:
			return theme.fg("accent", frame);
	}
}

function renderProgressText(
	snapshot: BatchFetchProgressSnapshot,
	width: number,
	expanded: boolean,
	theme: {
		bold(value: string): string;
		fg(color: string, value: string): string;
	},
	spinnerTick = 0,
): string {
	const summary =
		theme.fg("toolTitle", theme.bold("fetch ")) +
		theme.fg(
			"muted",
			`${snapshot.completed}/${snapshot.total} done · ok ${snapshot.succeeded} · err ${snapshot.failed}`,
		);

	const urlWidth = Math.max(12, width - 12);
	const rows = snapshot.items.map((item, index) => {
		const glyph = statusGlyph(item, spinnerTick + index, theme);
		const url = theme.fg("accent", truncateMiddle(item.url, urlWidth));
		const status = theme.fg("muted", item.status);
		const row = `${glyph} ${url} ${status}`;
		if (expanded && item.error) {
			return `${row}\n  ${theme.fg("error", item.error)}`;
		}
		return row;
	});

	return [summary, ...rows].join("\n");
}

export default function (pi: ExtensionAPI) {
	const defaults = resolveFetchToolDefaults();

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: [
			"Fetch one or more URLs with browser-grade TLS fingerprinting and extract clean, readable content.",
			"Uses wreq-js for browser-like TLS/HTTP2 impersonation and Defuddle for article extraction.",
			"Handles HTML, PDFs/binaries (saved to temp file), JSON, and plain text.",
			"Multiple URLs fan out concurrently. Does NOT execute JavaScript.",
		].join(" "),
		promptSnippet:
			"web_fetch(urls, format?, maxChars?, timeoutMs?): fetch one or more URLs with browser TLS fingerprinting and readable-content extraction; always pass urls as an array",

		parameters: Type.Object({
			urls: Type.Array(Type.String(), {
				minItems: 1,
				description: "URLs to fetch (http/https only). One or many.",
			}),
			browser: Type.Optional(
				Type.String({
					description: `Browser profile for TLS fingerprinting. Default: "${defaults.browser}". Examples: chrome_145, firefox_147, safari_26`,
				}),
			),
			os: Type.Optional(
				Type.String({
					description: `OS profile for fingerprinting. Default: "${defaults.os}". Options: windows, macos, linux, android, ios`,
				}),
			),
			headers: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "Custom HTTP headers applied to every request.",
				}),
			),
			maxChars: Type.Optional(
				Type.Number({
					description: `Max characters returned per URL. Default: ${defaults.maxChars}`,
				}),
			),
			timeoutMs: Type.Optional(
				Type.Number({
					description: `Per-request timeout in ms. Default: ${defaults.timeoutMs}`,
				}),
			),
			format: Type.Optional(
				Type.Union(
					[
						Type.Literal("markdown"),
						Type.Literal("html"),
						Type.Literal("text"),
						Type.Literal("json"),
						Type.Literal("raw"),
					],
					{
						description:
							'Output format. "markdown" (default), "html", "text", "json", or "raw" (no extraction/truncation)',
					},
				),
			),
			removeImages: Type.Optional(
				Type.Boolean({
					description: "Strip image references from output. Default: false",
				}),
			),
			includeReplies: Type.Optional(
				Type.Union([Type.Boolean(), Type.Literal("extractors")], {
					description:
						"Include replies/comments: 'extractors' (default, site-specific only), true for all, false for none",
				}),
			),
			proxy: Type.Optional(
				Type.String({
					description: "Proxy URL (http://user:pass@host:port or socks5://host:port)",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, onUpdate) {
			const { urls, ...shared } = params as {
				urls: string[];
			} & Record<string, unknown>;
			const requests = urls.map((url) => ({ ...shared, url }));

			let latestSnapshot: BatchFetchProgressSnapshot | undefined;
			let spinnerTick = 0;

			const emitProgress = (snapshot: BatchFetchProgressSnapshot) => {
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Fetching ${snapshot.total} URL(s) (${snapshot.completed}/${snapshot.total} complete)...`,
						},
					],
					details: {
						batchProgress: snapshot,
						spinnerTick,
					} satisfies RenderDetails,
				});
			};

			const spinnerTimer = setInterval(() => {
				if (!latestSnapshot || latestSnapshot.completed >= latestSnapshot.total)
					return;
				spinnerTick += 1;
				emitProgress(latestSnapshot);
			}, SPINNER_INTERVAL_MS);

			try {
				const batchResult = await executeBatchFetchToolCall(
					{ requests },
					defaults,
					{
						batchConcurrency: defaults.batchConcurrency,
						onProgress(snapshot) {
							latestSnapshot = snapshot;
							emitProgress(snapshot);
						},
					},
				);

				const finalProgress: BatchFetchProgressSnapshot = {
					items: batchResult.items.map((item) => ({
						index: item.index,
						url: item.request.url,
						status: item.status,
						progress: item.progress,
						...(item.error ? { error: item.error } : {}),
					})),
					total: batchResult.total,
					completed: batchResult.total,
					succeeded: batchResult.succeeded,
					failed: batchResult.failed,
					batchConcurrency: batchResult.batchConcurrency,
				};

				const text =
					batchResult.total === 1 && batchResult.items[0]?.result
						? buildFetchResponseText(batchResult.items[0].result, {
								verbose: true,
							})
						: buildBatchFetchResponseText(batchResult, { verbose: true });

				if (batchResult.total === batchResult.failed) {
					throw new Error(text);
				}

				return {
					content: [{ type: "text", text }],
					details: {
						batchProgress: finalProgress,
						batchResult,
						spinnerTick,
					} satisfies RenderDetails,
				};
			} finally {
				clearInterval(spinnerTimer);
			}
		},

		renderCall(args, theme) {
			const urls = Array.isArray((args as { urls?: unknown }).urls)
				? ((args as { urls: unknown[] }).urls as string[])
				: [];
			const first = typeof urls[0] === "string" ? urls[0] : "...";
			const display = first.length > 70 ? `${first.slice(0, 67)}...` : first;
			const extra = urls.length > 1 ? ` (+${urls.length - 1} more)` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("fetch ")) +
					theme.fg("accent", display) +
					theme.fg("muted", extra),
				0,
				0,
			);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const details = (result.details as RenderDetails | undefined) ?? {};

			if (isPartial || !details.batchResult) {
				const text = new Text("", 0, 0);
				return {
					render(width: number) {
						if (!details.batchProgress) {
							text.setText(theme.fg("warning", "Fetching…"));
						} else {
							text.setText(
								renderProgressText(
									details.batchProgress,
									width,
									expanded,
									theme,
									details.spinnerTick ?? 0,
								),
							);
						}
						return text.render(width);
					},
					invalidate() {
						text.invalidate();
					},
				};
			}

			if (context.isError) {
				const msg =
					result.content.find((c) => c.type === "text")?.text || "Error";
				return new Text(theme.fg("error", expanded ? msg : msg.split("\n")[0]), 0, 0);
			}

			const batch = details.batchResult;
			const lines: string[] = [];

			if (batch.total > 1) {
				lines.push(
					theme.fg("toolTitle", theme.bold("fetched ")) +
						theme.fg("muted", `${batch.succeeded}/${batch.total} ok`),
				);
			}

			for (const item of batch.items) {
				if (item.status === "error") {
					lines.push(
						`${theme.fg("error", "✗")} ${theme.fg("accent", truncateMiddle(item.request.url, 70))}`,
					);
					if (expanded && item.error) {
						lines.push(`  ${theme.fg("error", item.error.split("\n")[0])}`);
					}
					continue;
				}

				const r = item.result;
				if (!r) continue;

				const title = r.title || r.finalUrl || r.url;
				const size = isFileFetchResult(r)
					? `${Math.round(r.fileSize / 1024)}KB → ${r.filePath}`
					: `${r.content.length} chars`;
				lines.push(
					`${theme.fg("success", "✓")} ${theme.fg("success", title)} ${theme.fg("muted", `(${size})`)}`,
				);

				if (expanded) {
					lines.push(`  ${theme.fg("dim", r.finalUrl || r.url)}`);
					if (!isFileFetchResult(r) && r.content) {
						const preview = r.content.slice(0, 500);
						lines.push(
							theme.fg(
								"dim",
								preview
									.split("\n")
									.map((l) => `  ${l}`)
									.join("\n") + (r.content.length > 500 ? "…" : ""),
							),
						);
					}
				}
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
