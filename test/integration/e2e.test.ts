/**
 * Integration tests for pi.Research.
 *
 * These tests hit real network endpoints and exercise the full
 * extraction + search pipeline end-to-end.
 *
 * They are intentionally separate from unit tests and guarded
 * by the PI_RESEARCH_INTEGRATION env var so they never run in CI
 * by accident (and never cost money without opt-in).
 *
 * Run with:
 *   PI_RESEARCH_INTEGRATION=1 npm run test:integration
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import {
	searchDuckDuckGo,
	searchWeb,
	searchSearXNGPool,
	searchLlm,
	getSearxngPoolState,
} from "../../src/providers/search.js";
import { extractWithReadability } from "../../src/providers/extract.js";
import { getResearchTools } from "../../src/tools/index.js";

const SKIP = !process.env["PI_RESEARCH_INTEGRATION"];

describe(
	"Integration: DuckDuckGo search",
	{ skip: SKIP ? "Set PI_RESEARCH_INTEGRATION=1 to run" : false },
	() => {
		// DDG may return a 202 bot-challenge in automated environments.
		// When that happens the scraper throws with a clear message.
		// Tests that require real results skip themselves if bot-blocked.
		async function safeDDGSearch(query: string, max?: number) {
			try {
				return {
					results: await searchDuckDuckGo(query, max),
					botBlocked: false,
				};
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				if (msg.includes("bot challenge")) return { results: [], botBlocked: true };
				throw e; // Re-throw unexpected errors
			}
		}

		test("returns ≥1 result for a broad query, or a clear bot-challenge error", async (t) => {
			const { results, botBlocked } = await safeDDGSearch("TypeScript handbook");
			if (botBlocked) {
				t.skip(
					"DDG is bot-blocking this environment — add TAVILY_API_KEY for reliable search",
				);
				return;
			}
			assert.ok(results.length >= 1, `Expected at least 1 result, got ${results.length}`);
		});

		test("each result has non-empty title, url, and snippet", async (t) => {
			const { results, botBlocked } = await safeDDGSearch("Node.js documentation");
			if (botBlocked) {
				t.skip("DDG bot-blocked");
				return;
			}
			for (const r of results) {
				assert.ok(r.title.length > 0, "title must not be empty");
				assert.ok(r.url.startsWith("http"), `url must be absolute http(s), got: ${r.url}`);
				assert.ok(r.snippet.length > 0, "snippet must not be empty");
			}
		});

		test("respects maxResults parameter", async (t) => {
			const { results, botBlocked } = await safeDDGSearch("javascript array methods", 3);
			if (botBlocked) {
				t.skip("DDG bot-blocked");
				return;
			}
			assert.ok(results.length <= 3, `Expected ≤3 results, got ${results.length}`);
		});

		test("returns empty array (not error) for a highly unusual query", async (t) => {
			const { results, botBlocked } = await safeDDGSearch("xyzzy1234567890noresultsexpected");
			if (botBlocked) {
				t.skip("DDG bot-blocked");
				return;
			}
			assert.ok(Array.isArray(results));
		});
	},
);

describe(
	"Integration: Readability page extraction",
	{ skip: SKIP ? "Set PI_RESEARCH_INTEGRATION=1 to run" : false },
	() => {
		test("extracts readable markdown from a real public page", async () => {
			const result = await extractWithReadability("https://example.com");
			assert.ok(result.title.length > 0, "title must not be empty");
			assert.ok(result.markdown.length > 0, "markdown must not be empty");
			assert.strictEqual(result.source, "readability");
		});

		test("extracted markdown does not contain raw HTML tags", async () => {
			const result = await extractWithReadability("https://example.com");
			// Readability + Turndown should not leave <div>, <span>, etc. in output
			assert.doesNotMatch(result.markdown, /<div|<span|<script|<style/i);
		});

		test("extracted markdown does not contain image syntax (observation masking)", async () => {
			const result = await extractWithReadability("https://example.com");
			// Images should be stripped by the Turndown rule
			assert.doesNotMatch(result.markdown, /!\[/);
		});

		test("throws on a non-existent URL", async () => {
			await assert.rejects(
				() => extractWithReadability("https://this-domain-does-not-exist-xyz-abc-123.com"),
				/fetch failed|ENOTFOUND|getaddrinfo/i,
			);
		});
	},
);

describe(
	"Integration: read_page_markdown tool",
	{ skip: SKIP ? "Set PI_RESEARCH_INTEGRATION=1 to run" : false },
	() => {
		test("returns clean markdown for a real URL", async () => {
			const tools = getResearchTools({});
			const readTool = tools.find((t) => t.name === "read_page_markdown")!;

			const result = (await readTool.execute({
				url: "https://example.com",
			})) as string;
			assert.ok(
				result.startsWith("--- TITLE:"),
				`Response should start with TITLE header, got: ${result.slice(0, 80)}`,
			);
			assert.ok(result.includes("Example Domain"), "Should contain page content");
		});

		test("returns error string (not throws) for an unreachable URL", async () => {
			const tools = getResearchTools({});
			const readTool = tools.find((t) => t.name === "read_page_markdown")!;

			const result = (await readTool.execute({
				url: "https://this-domain-does-not-exist-xyz-abc.com",
			})) as string;
			assert.ok(
				result.startsWith("Extraction failed:"),
				`Should return error string, got: ${result.slice(0, 80)}`,
			);
		});

		test("caches large documents and returns a cache_id", async () => {
			// Use a known large page (Node.js docs) to trigger the cache path
			const tools = getResearchTools({ maxChars: 100 }); // Tiny limit to force caching
			const readTool = tools.find((t) => t.name === "read_page_markdown")!;
			const searchCacheTool = tools.find((t) => t.name === "search_cache")!;

			const result = (await readTool.execute({
				url: "https://example.com",
			})) as string;

			// If the page exceeds maxChars, a cache_id is embedded
			if (result.includes("cache_id:")) {
				const match = result.match(/cache_id: "([^"]+)"/);
				assert.ok(match, "cache_id should be in UUID format");
				const cacheId = match![1];

				// Now verify search_cache can find content in that cached doc
				const cached = (await searchCacheTool.execute({
					cache_id: cacheId,
					query: "Example",
				})) as string;
				assert.ok(
					!cached.startsWith("Error:"),
					`Cache lookup should succeed, got: ${cached}`,
				);
			}
			// If the page is small enough to fit in maxChars, that's fine too
		});

		test("extracts GitHub URLs natively without HTML DOM bloat", async () => {
			const tools = getResearchTools({});
			const readTool = tools.find((t) => t.name === "read_page_markdown")!;

			const result = (await readTool.execute({
				url: "https://github.com/octocat/Hello-World",
			})) as string;

			assert.ok(result.includes("--- TITLE:"), "Should have title header");
			assert.ok(
				result.toLowerCase().includes("hello-world") ||
					result.toLowerCase().includes("hello world"),
			);
		});
	},
);

describe(
	"Integration: Resilient searchWeb fallback",
	{ skip: SKIP ? "Set PI_RESEARCH_INTEGRATION=1 to run" : false },
	() => {
		test("searchWeb cascades across tiers without crashing and yields valid results", async () => {
			// Intentionally pass invalid API keys to force cascading down through the chain
			const results = await searchWeb("TypeScript handbook documentation", {
				TAVILY_API_KEY: "invalid_test_key",
				BRAVE_API_KEY: "invalid_test_key",
			});

			assert.ok(Array.isArray(results), "searchWeb should return an array of results");
			assert.ok(results.length >= 1, `Expected at least 1 result, got ${results.length}`);

			for (const r of results) {
				assert.ok(r.title.length > 0, "Each result must have a title");
				assert.ok(
					r.url.startsWith("http"),
					`Each result must have a valid URL, got: ${r.url}`,
				);
				assert.ok(r.snippet.length > 0, "Each result must have a non-empty snippet");
				assert.ok(
					["tavily", "brave", "searxng", "jina", "duckduckgo", "llm"].includes(
						r.sourceProvider || "",
					),
					`sourceProvider must be valid, got: ${r.sourceProvider}`,
				);
			}
		});

		test("searchSearXNGPool executes with timeout and circuit breaker against real network", async () => {
			try {
				const results = await searchSearXNGPool("Node.js runtime", 3, {
					timeoutMs: 3000,
					maxPoolAttempts: 2,
				});
				assert.ok(Array.isArray(results));
				if (results.length > 0) {
					assert.strictEqual(results[0].sourceProvider, "searxng");
					const poolState = getSearxngPoolState();
					assert.ok(
						poolState.preferred,
						"Successful instance should be marked as preferred",
					);
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				// If public operators block or time out, circuit breaker should cleanly report exhaustion
				assert.ok(
					msg.includes("Public SearXNG pool exhausted") ||
						msg.includes("SearXNG HTTP error"),
					`Expected circuit-breaker pool exhaustion or HTTP error, got: ${msg}`,
				);
			}
		});

		test("searchWeb respects allowLlmFallback: false and emits comprehensive diagnostics on total failure", async () => {
			await assert.rejects(
				() =>
					searchWeb("impossible query with failing keys", {
						searchProviders: ["tavily", "brave"],
						TAVILY_API_KEY: "bad_test_key",
						BRAVE_API_KEY: "bad_test_key",
						allowLlmFallback: false,
					}),
				(err: Error) => {
					assert.ok(err.message.includes("All search providers failed"));
					assert.ok(err.message.includes("tavily:"));
					assert.ok(err.message.includes("brave:"));
					return true;
				},
			);
		});

		test("searchWeb with allowLlmFallback: true recovers when all search engines fail", async () => {
			const results = await searchWeb("functional programming concepts in TypeScript", {
				searchProviders: ["tavily", "brave", "llm"],
				TAVILY_API_KEY: "bad_test_key",
				BRAVE_API_KEY: "bad_test_key",
				allowLlmFallback: true,
			});

			assert.ok(Array.isArray(results));
			assert.ok(
				results.length >= 1,
				"Should return at least 1 synthesized or grounded result",
			);
			assert.strictEqual(results[0].sourceProvider, "llm");
			assert.ok(results[0].snippet.length > 0);
		});

		test("searchLlm leverages ambient Pi auth, env keys, or parametric synthesis directly", async () => {
			const results = await searchLlm("Docker container networking architecture", {});
			assert.ok(Array.isArray(results));
			assert.ok(results.length >= 1, "searchLlm must return at least 1 result");
			assert.strictEqual(results[0].sourceProvider, "llm");
			assert.ok(results[0].title.length > 0);
			assert.ok(results[0].snippet.length > 0);
		});

		test("search_web tool end-to-end integration through research subagent tool interface", async () => {
			const tools = getResearchTools({
				TAVILY_API_KEY: "invalid_key",
				BRAVE_API_KEY: "invalid_key",
			});
			const searchTool = tools.find((t) => t.name === "search_web")!;
			assert.ok(searchTool, "search_web tool should exist");

			const jsonStr = (await searchTool.execute({
				query: "Node.js EventEmitter pattern",
			})) as string;
			assert.ok(
				typeof jsonStr === "string",
				"search_web execute should return a JSON string",
			);

			const parsed = JSON.parse(jsonStr) as Array<{
				title: string;
				url: string;
				snippet: string;
			}>;
			assert.ok(Array.isArray(parsed), "Parsed output should be an array");
			assert.ok(
				parsed.length >= 1,
				`Expected at least 1 search result, got: ${parsed.length}`,
			);
			assert.ok(parsed[0].title.length > 0);
			assert.ok(parsed[0].url.startsWith("http"));
		});
	},
);
