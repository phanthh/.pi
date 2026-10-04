import assert from "node:assert/strict";
import register from "./src/index.ts";

let tool;
register({
	registerTool(definition) {
		tool = definition;
	},
});
const realFetch = globalThis.fetch;
const search = (params = { query: "test" }, signal) =>
	tool.execute("selftest", params, signal);
const text = (result) =>
	result.content.map((block) => block.text ?? "").join("\n");
const reply = (data, status = 200) => {
	globalThis.fetch = async () => Response.json(data, { status });
};

try {
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return Response.json({
			results: [
				{
					title: "First",
					url: "https://example.com",
					content: "word ".repeat(100),
				},
				{ title: "Duplicate", url: "https://example.com" },
				null,
				{ title: "Missing URL" },
				{ url: "https://example.org" },
				{ url: "https://example.net" },
			],
			unresponsive_engines: [["google", "CAPTCHA"], null, [7, "bad"]],
		});
	};
	const partial = await search({
		query: "a & b",
		max_results: 2,
		page: 2.8,
		categories: "news",
		time_range: "year",
	});
	assert.equal(partial.details.count, 2);
	assert.equal(partial.details.results[1].title, "https://example.org");
	assert.equal(partial.isError, false);
	assert.match(text(partial), /Engine failures: google: CAPTCHA/);
	assert.match(text(partial), /…/);
	for (const [key, value] of Object.entries({
		q: "a & b",
		pageno: "2",
		categories: "news",
		time_range: "year",
		format: "json",
	})) {
		assert.equal(request.url.searchParams.get(key), value);
	}
	assert.equal(request.options.headers.Accept, "application/json");

	reply({
		results: [],
		unresponsive_engines: [
			["google", "access denied"],
			["duckduckgo", "CAPTCHA"],
		],
	});
	const failed = await search();
	assert.equal(failed.isError, true);
	assert.match(text(failed), /upstream engines failed/);
	assert.match(text(failed), /duckduckgo: CAPTCHA/);

	reply({ results: [], suggestions: ["other query", 42] });
	const empty = await search();
	assert.equal(empty.isError, false);
	assert.match(text(empty), /No results for: test/);
	assert.match(text(empty), /Suggestions: other query/);

	reply({
		results: [],
		answers: ["42"],
		unresponsive_engines: [["google", "CAPTCHA"]],
	});
	assert.equal((await search()).isError, false);
	for (const data of [null, {}, { results: "not an array" }]) {
		reply(data);
		await assert.rejects(search(), /Invalid SearXNG response/);
	}
	reply({}, 403);
	await assert.rejects(search(), /HTTP 403/);
	globalThis.fetch = async () => {
		throw new TypeError("fetch failed");
	};
	await assert.rejects(search(), /Could not connect to SearXNG/);

	const controller = new AbortController();
	controller.abort();
	globalThis.fetch = async (_url, options) => {
		options.signal.throwIfAborted();
		throw new Error("Expected cancellation");
	};
	await assert.rejects(search(undefined, controller.signal), {
		name: "AbortError",
	});

	const theme = { fg: (_color, value) => value, bold: (value) => value };
	const render = (result) =>
		tool
			.renderResult(result, { expanded: false, isPartial: false }, theme)
			.render(120)
			.join("\n");
	assert.match(render(failed), /duckduckgo: CAPTCHA/);
	assert.match(render(partial), /google: CAPTCHA/);
	assert.match(
		render({ content: [{ type: "text", text: "HTTP 403" }], isError: true }),
		/HTTP 403/,
	);
	console.log(
		"web-search selftest: PASS (results, dedup, limits, params, engine errors, invalid responses, HTTP/network errors, cancellation, rendering)",
	);
} finally {
	globalThis.fetch = realFetch;
}

if (process.argv.includes("--live")) {
	for (const [query, domain] of [
		["Python official documentation", "python.org"],
		["Docker Compose documentation", "docs.docker.com"],
		["TypeScript handbook", "typescriptlang.org"],
	]) {
		const result = await search({ query, max_results: 5 });
		assert.equal(result.isError, false, text(result));
		assert.ok(result.details.count > 0 && result.details.count <= 5);
		assert.ok(
			result.details.results.some((item) =>
				new URL(item.url).hostname.endsWith(domain),
			),
			text(result),
		);
		console.log(
			`LIVE PASS: ${query} (${result.details.count} results; official domain found)`,
		);
	}
}
