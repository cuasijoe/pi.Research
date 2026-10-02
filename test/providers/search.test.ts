import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	searchWeb,
	searchDuckDuckGo,
	searchTavily,
	searchBrave,
	searchSearXNG,
	searchSearXNGPool,
	querySingleSearXNGInstance,
	fetchSearxSpaceInstances,
	resetSearxngPoolState,
	getSearxngPoolState,
	resetProviderHealthState,
	getProviderHealthState,
	DEFAULT_PUBLIC_SEARXNG_INSTANCES,
	searchJina,
	searchLlm,
} from "../../src/providers/search.js";
import type { ResearchConfig } from "../../src/config.js";

test("search providers - structural export check", () => {
	assert.strictEqual(typeof searchWeb, "function");
	assert.strictEqual(typeof searchDuckDuckGo, "function");
	assert.strictEqual(typeof searchTavily, "function");
	assert.strictEqual(typeof searchBrave, "function");
	assert.strictEqual(typeof searchSearXNG, "function");
	assert.strictEqual(typeof searchJina, "function");
	assert.strictEqual(typeof searchLlm, "function");
});

test("searchBrave - correctly parses Brave JSON response", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(input);
			assert.ok(urlStr.includes("api.search.brave.com/res/v1/web/search"));
			assert.ok(urlStr.includes("q=typescript"));
			const headers = init?.headers as Record<string, string>;
			assert.strictEqual(headers["X-Subscription-Token"], "test-brave-key");

			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					web: {
						results: [
							{
								title: "TypeScript Official",
								url: "https://www.typescriptlang.org",
								description: "Typed JavaScript at Any Scale",
							},
						],
					},
				}),
			} as unknown as Response;
		}) as typeof fetch;

		const results = await searchBrave("typescript", "test-brave-key", 5);
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].title, "TypeScript Official");
		assert.strictEqual(results[0].url, "https://www.typescriptlang.org");
		assert.strictEqual(results[0].snippet, "Typed JavaScript at Any Scale");
		assert.strictEqual(results[0].sourceProvider, "brave");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("searchBrave - throws on non-200 response", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async () => ({
			ok: false,
			status: 401,
			statusText: "Unauthorized",
		})) as unknown as typeof fetch;

		await assert.rejects(() => searchBrave("test", "bad-key"), /Brave search failed \(401\)/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("searchSearXNG - parses SearXNG JSON response", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const urlStr = String(input);
			assert.ok(urlStr.startsWith("http://localhost:8080/search"));
			assert.ok(urlStr.includes("format=json"));
			assert.ok(urlStr.includes("q=searxng"));

			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					results: [
						{
							title: "SearXNG Docs",
							url: "https://docs.searxng.org",
							content: "A privacy-respecting, open metasearch engine",
						},
					],
				}),
			} as unknown as Response;
		}) as typeof fetch;

		const results = await searchSearXNG("searxng", "http://localhost:8080", 5);
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].title, "SearXNG Docs");
		assert.strictEqual(results[0].url, "https://docs.searxng.org");
		assert.strictEqual(results[0].sourceProvider, "searxng");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("querySingleSearXNGInstance - falls back to HTML scraping when JSON API is 403 or non-JSON", async () => {
	const originalFetch = globalThis.fetch;
	const calls: string[] = [];

	try {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const urlStr = String(input);
			calls.push(urlStr);

			if (urlStr.includes("format=json")) {
				// Operator blocked JSON
				return {
					ok: false,
					status: 403,
					statusText: "Forbidden",
					headers: new Headers({ "content-type": "text/html" }),
				} as unknown as Response;
			}

			// HTML fallback call
			return {
				ok: true,
				status: 200,
				headers: new Headers({ "content-type": "text/html" }),
				text: async () => `
          <html>
            <body>
              <article class="result">
                <h3><a href="https://example.com/searx-html">HTML Title</a></h3>
                <p class="content">Extracted from SearXNG HTML template</p>
              </article>
            </body>
          </html>
        `,
			} as unknown as Response;
		}) as typeof fetch;

		const results = await querySingleSearXNGInstance("http://localhost:8080", "test query", 3);
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].title, "HTML Title");
		assert.strictEqual(results[0].url, "https://example.com/searx-html");
		assert.strictEqual(results[0].snippet, "Extracted from SearXNG HTML template");
		assert.strictEqual(results[0].sourceProvider, "searxng");

		assert.ok(
			calls.some((c) => c.includes("format=json")),
			"JSON format should have been attempted first",
		);
		assert.ok(
			calls.some((c) => !c.includes("format=json")),
			"HTML format should have been attempted as fallback",
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("searchSearXNGPool - succeeds on healthy instance and sets preferredInstance", async () => {
	resetSearxngPoolState();
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const urlStr = String(input);
			if (urlStr.includes("searx.be")) {
				return {
					ok: true,
					status: 200,
					headers: new Headers({ "content-type": "application/json" }),
					json: async () => ({
						results: [
							{
								title: "Public SearXNG Result",
								url: "https://searx.be/res",
								content: "Found via public pool",
							},
						],
					}),
				} as unknown as Response;
			}
			throw new Error(`Unexpected endpoint: ${urlStr}`);
		}) as typeof fetch;

		const results = await searchSearXNGPool("test query", 3, {
			customPool: ["https://searx.be"],
		});
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].title, "Public SearXNG Result");
		assert.strictEqual(results[0].sourceProvider, "searxng");

		const state = getSearxngPoolState();
		assert.strictEqual(state.preferred, "https://searx.be");
		assert.strictEqual(state.health["https://searx.be"]?.failureCount, 0);
	} finally {
		globalThis.fetch = originalFetch;
		resetSearxngPoolState();
	}
});

test("searchSearXNGPool - rotates when first instance returns 403 or non-JSON", async () => {
	resetSearxngPoolState();
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const urlStr = String(input);
			if (urlStr.includes("instance1.org")) {
				return {
					ok: false,
					status: 403,
					statusText: "Forbidden",
					headers: new Headers({ "content-type": "text/html" }),
				} as unknown as Response;
			}
			if (urlStr.includes("instance2.org")) {
				return {
					ok: true,
					status: 200,
					headers: new Headers({ "content-type": "application/json" }),
					json: async () => ({
						results: [
							{
								title: "Instance 2 Success",
								url: "https://instance2.org/res",
								content: "Recovered from pool",
							},
						],
					}),
				} as unknown as Response;
			}
			throw new Error(`Unexpected endpoint: ${urlStr}`);
		}) as typeof fetch;

		const results = await searchSearXNGPool("query", 2, {
			customPool: ["https://instance1.org", "https://instance2.org"],
			maxPoolAttempts: 2,
		});
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].title, "Instance 2 Success");

		const state = getSearxngPoolState();
		assert.strictEqual(state.preferred, "https://instance2.org");
		assert.strictEqual(state.health["https://instance1.org"]?.failureCount, 1);
		assert.strictEqual(state.health["https://instance2.org"]?.failureCount, 0);
	} finally {
		globalThis.fetch = originalFetch;
		resetSearxngPoolState();
	}
});

test("searchSearXNG - falls back from failed self-hosted baseUrl to public pool", async () => {
	resetSearxngPoolState();
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const urlStr = String(input);
			if (urlStr.includes("localhost:8080")) {
				return {
					ok: false,
					status: 502,
					statusText: "Bad Gateway",
				} as unknown as Response;
			}
			if (urlStr.includes("fallback-pool.org")) {
				return {
					ok: true,
					status: 200,
					headers: new Headers({ "content-type": "application/json" }),
					json: async () => ({
						results: [
							{
								title: "Pool Backup Result",
								url: "https://fallback-pool.org/backup",
								content: "Recovered",
							},
						],
					}),
				} as unknown as Response;
			}
			throw new Error(`Unexpected endpoint: ${urlStr}`);
		}) as typeof fetch;

		const results = await searchSearXNG("query", "http://localhost:8080", 2, {
			customPool: ["https://fallback-pool.org"],
		});
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].title, "Pool Backup Result");
	} finally {
		globalThis.fetch = originalFetch;
		resetSearxngPoolState();
	}
});

test("searchSearXNG - throws when disablePublicPool is true and baseUrl fails", async () => {
	resetSearxngPoolState();
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async () => ({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
		})) as unknown as typeof fetch;

		await assert.rejects(
			() =>
				searchSearXNG("query", "http://localhost:8080", 2, {
					disablePublicPool: true,
				}),
			/SearXNG HTTP error \(500\)/,
		);
	} finally {
		globalThis.fetch = originalFetch;
		resetSearxngPoolState();
	}
});

test("fetchSearxSpaceInstances - parses active normal instances", async () => {
	resetSearxngPoolState();
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const urlStr = String(input);
			assert.ok(urlStr.includes("searx.space/data/instances.json"));
			return {
				ok: true,
				status: 200,
				json: async () => ({
					instances: {
						"https://searx1.test/": {
							network_type: "normal",
							http: { status_code: 200 },
						},
						"https://searx2.onion/": {
							network_type: "tor",
							http: { status_code: 200 },
						},
						"https://searx3.test/": {
							network_type: "normal",
							http: { status_code: 500 },
						},
					},
				}),
			} as unknown as Response;
		}) as typeof fetch;

		const instances = await fetchSearxSpaceInstances();
		assert.strictEqual(instances.length, 1);
		assert.strictEqual(instances[0], "https://searx1.test");
	} finally {
		globalThis.fetch = originalFetch;
		resetSearxngPoolState();
	}
});

test("searchWeb - provider circuit breaker skips recently failed provider on next search", async () => {
	resetProviderHealthState();
	const originalFetch = globalThis.fetch;
	const calls: string[] = [];

	try {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const urlStr = String(input);
			calls.push(urlStr);

			if (urlStr.includes("api.search.brave.com")) {
				return {
					ok: false,
					status: 429,
					statusText: "Rate Limit Exceeded",
				} as unknown as Response;
			}
			if (urlStr.includes("s.jina.ai")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						data: [
							{
								title: "Jina Result",
								url: "https://jina.ai",
								content: "Success",
							},
						],
					}),
				} as unknown as Response;
			}
			throw new Error(`Unexpected call: ${urlStr}`);
		}) as typeof fetch;

		// First search: Brave fails with 429, cascades to Jina and succeeds
		const res1 = await searchWeb("query 1", {
			searchProviders: ["brave", "jina"],
			BRAVE_API_KEY: "test_key",
			providerCooldownMs: 60000,
		});
		assert.strictEqual(res1[0].sourceProvider, "jina");
		assert.ok(
			calls.some((c) => c.includes("api.search.brave.com")),
			"Brave should have been called on query 1",
		);

		// Check circuit breaker status
		const health = getProviderHealthState();
		assert.strictEqual(health["brave"]?.failureCount, 1);
		assert.strictEqual(health["jina"]?.failureCount, 0);

		// Second search: Brave should be SKIPPED on cooldown, going straight to Jina!
		calls.length = 0;
		const res2 = await searchWeb("query 2", {
			searchProviders: ["brave", "jina"],
			BRAVE_API_KEY: "test_key",
			providerCooldownMs: 60000,
		});
		assert.strictEqual(res2[0].sourceProvider, "jina");
		assert.strictEqual(
			calls.filter((c) => c.includes("api.search.brave.com")).length,
			0,
			"Brave should be bypassed on query 2 due to circuit breaker cooldown",
		);
	} finally {
		globalThis.fetch = originalFetch;
		resetProviderHealthState();
	}
});

test("searchJina - parses s.jina.ai JSON response", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(input);
			assert.ok(urlStr.includes("s.jina.ai/jina%20query"));
			const headers = init?.headers as Record<string, string>;
			assert.strictEqual(headers.Authorization, "Bearer my-jina-key");

			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					data: [
						{
							title: "Jina AI Search",
							url: "https://jina.ai",
							description: "Search Foundation Models",
							content: "Search for AI applications",
						},
					],
				}),
			} as unknown as Response;
		}) as typeof fetch;

		const results = await searchJina("jina query", "my-jina-key", 5);
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].title, "Jina AI Search");
		assert.strictEqual(results[0].snippet, "Search Foundation Models");
		assert.strictEqual(results[0].sourceProvider, "jina");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("searchWeb - cascading fallback: Tavily fails -> Brave succeeds", async () => {
	const originalFetch = globalThis.fetch;
	const attemptedUrls: string[] = [];

	try {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const urlStr = String(input);
			attemptedUrls.push(urlStr);

			if (urlStr.includes("api.tavily.com")) {
				return {
					ok: false,
					status: 429,
					statusText: "Rate Limit Exceeded",
				} as unknown as Response;
			}

			if (urlStr.includes("api.search.brave.com")) {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({
						web: {
							results: [
								{
									title: "Brave Fallback Result",
									url: "https://brave.com/search",
									description: "Recovered via Brave",
								},
							],
						},
					}),
				} as unknown as Response;
			}

			throw new Error(`Unexpected URL: ${urlStr}`);
		}) as typeof fetch;

		const config: ResearchConfig = {
			TAVILY_API_KEY: "bad-tavily-key",
			BRAVE_API_KEY: "good-brave-key",
		};

		const results = await searchWeb("fallback query", config);
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].title, "Brave Fallback Result");
		assert.strictEqual(results[0].sourceProvider, "brave");
		assert.ok(attemptedUrls.some((u) => u.includes("api.tavily.com")));
		assert.ok(attemptedUrls.some((u) => u.includes("api.search.brave.com")));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("searchWeb - custom searchProviders order is respected", async () => {
	const originalFetch = globalThis.fetch;
	const executionOrder: string[] = [];

	try {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const urlStr = String(input);
			if (urlStr.includes("s.jina.ai")) {
				executionOrder.push("jina");
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({
						data: [
							{
								title: "Jina Winner",
								url: "https://jina.ai",
								description: "Jina first",
							},
						],
					}),
				} as unknown as Response;
			}

			if (urlStr.includes("api.brave.com")) {
				executionOrder.push("brave");
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({ web: { results: [] } }),
				} as unknown as Response;
			}

			throw new Error(`Unexpected: ${urlStr}`);
		}) as typeof fetch;

		const config: ResearchConfig = {
			BRAVE_API_KEY: "brave-key",
			searchProviders: ["jina", "brave"],
		};

		const results = await searchWeb("custom order", config);
		assert.strictEqual(results[0].sourceProvider, "jina");
		assert.deepStrictEqual(executionOrder, ["jina"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("searchWeb - throws comprehensive diagnostic when all providers fail", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const urlStr = String(input);
			if (urlStr.includes("s.jina.ai")) {
				return {
					ok: false,
					status: 401,
					statusText: "Unauthorized",
					text: async () => "Jina Auth Error",
				} as unknown as Response;
			}
			if (urlStr.includes("duckduckgo.com")) {
				return {
					ok: false,
					status: 500,
					statusText: "Server Error",
				} as unknown as Response;
			}
			throw new Error(`Unhandled: ${urlStr}`);
		}) as typeof fetch;

		const config: ResearchConfig = {
			searchProviders: ["jina", "duckduckgo"],
		};

		await assert.rejects(
			() => searchWeb("all fail query", config),
			(err: Error) => {
				assert.ok(err.message.includes("All search providers failed"));
				assert.ok(err.message.includes("jina: Jina search failed (401)"));
				assert.ok(
					err.message.includes("duckduckgo: DuckDuckGo search failed: Server Error"),
				);
				return true;
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("searchLlm - parses Gemini Google Search Grounding response", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(input);
			assert.ok(urlStr.includes("generativelanguage.googleapis.com"));
			assert.ok(urlStr.includes("key=test-gemini-key"));

			const body = JSON.parse(String(init?.body));
			assert.ok(body.tools.some((t: any) => t.google_search));

			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					candidates: [
						{
							content: {
								parts: [{ text: "React is a UI library maintained by Meta." }],
							},
							groundingMetadata: {
								groundingChunks: [
									{
										web: {
											uri: "https://react.dev",
											title: "React Official Documentation",
										},
									},
								],
							},
						},
					],
				}),
			} as unknown as Response;
		}) as typeof fetch;

		const results = await searchLlm("React documentation", {
			GEMINI_API_KEY: "test-gemini-key",
		});

		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].title, "React Official Documentation");
		assert.strictEqual(results[0].url, "https://react.dev");
		assert.strictEqual(results[0].sourceProvider, "llm");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("searchLlm - parses OpenAI knowledge synthesis response", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(input);
			assert.ok(urlStr.includes("api.openai.com/v1/chat/completions"));
			const headers = init?.headers as Record<string, string>;
			assert.strictEqual(headers.Authorization, "Bearer test-openai-key");

			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					choices: [
						{
							message: {
								content:
									"TypeScript is a strongly typed programming language that builds on JavaScript.",
							},
						},
					],
				}),
			} as unknown as Response;
		}) as typeof fetch;

		const results = await searchLlm("TypeScript overview", {
			OPENAI_API_KEY: "test-openai-key",
		});

		assert.strictEqual(results.length, 1);
		assert.ok(results[0].title.includes("OpenAI Knowledge Synthesis"));
		assert.ok(results[0].snippet.includes("TypeScript is a strongly typed"));
		assert.strictEqual(results[0].sourceProvider, "llm");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("searchWeb - cascading fallback to LLM when all search engines fail", async () => {
	resetProviderHealthState();
	resetSearxngPoolState();
	const originalFetch = globalThis.fetch;
	const attemptedEndpoints: string[] = [];

	try {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const urlStr = String(input);
			attemptedEndpoints.push(urlStr);

			if (urlStr.includes("s.jina.ai")) {
				return {
					ok: false,
					status: 401,
					statusText: "Unauthorized",
					text: async () => "IP Blocked",
				} as unknown as Response;
			}

			if (urlStr.includes("duckduckgo.com")) {
				// Return 202 bot challenge
				return {
					ok: true,
					status: 202,
					text: async () => '<html><script src="/anomaly.js?cc=botnet"></script></html>',
				} as unknown as Response;
			}

			if (urlStr.includes("generativelanguage.googleapis.com")) {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({
						candidates: [
							{
								content: {
									parts: [{ text: "Grounded answer from Gemini search" }],
								},
								groundingMetadata: {
									groundingChunks: [
										{
											web: {
												uri: "https://nodejs.org/docs",
												title: "Node.js Documentation",
											},
										},
									],
								},
							},
						],
					}),
				} as unknown as Response;
			}

			throw new Error(`Unexpected endpoint: ${urlStr}`);
		}) as typeof fetch;

		const config: ResearchConfig = {
			GEMINI_API_KEY: "gemini-key",
			disablePublicSearxngPool: true,
			// Default cascade: Jina -> DDG -> LLM
		};

		const results = await searchWeb("nodejs documentation", config);
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].title, "Node.js Documentation");
		assert.strictEqual(results[0].url, "https://nodejs.org/docs");
		assert.strictEqual(results[0].sourceProvider, "llm");

		// Ensure it attempted Jina, then DDG, then recovered on LLM
		assert.ok(attemptedEndpoints.some((u) => u.includes("s.jina.ai")));
		assert.ok(attemptedEndpoints.some((u) => u.includes("duckduckgo.com")));
		assert.ok(attemptedEndpoints.some((u) => u.includes("generativelanguage.googleapis.com")));
	} finally {
		globalThis.fetch = originalFetch;
		resetProviderHealthState();
		resetSearxngPoolState();
	}
});

test("searchLlm - uses ChatGPT Codex subscription endpoint when credentials exist", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(input);
			if (urlStr.includes("chatgpt.com/backend-api/codex/responses")) {
				const headers = init?.headers as Record<string, string>;
				assert.ok(headers.Authorization.includes("Bearer test-codex-oauth-token"));
				assert.strictEqual(headers["ChatGPT-Account-ID"], "test-account-123");

				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({
						sources: [
							{
								title: "ChatGPT Live Web Result",
								url: "https://openai.com/blog",
								snippet: "Direct from ChatGPT live search",
							},
						],
					}),
				} as unknown as Response;
			}
			throw new Error(`Unexpected URL: ${urlStr}`);
		}) as typeof fetch;

		// Simulate Pi auth with openai-codex subscription
		const originalEnv = process.env.PI_CODING_AGENT_DIR;
		const tmpAuthDir = path.join(os.tmpdir(), `pi-test-auth-${Date.now()}`);
		fs.mkdirSync(tmpAuthDir, { recursive: true });
		fs.writeFileSync(
			path.join(tmpAuthDir, "auth.json"),
			JSON.stringify({
				"openai-codex": {
					type: "oauth",
					access: "test-codex-oauth-token",
					account: "test-account-123",
				},
			}),
			"utf-8",
		);
		process.env.PI_CODING_AGENT_DIR = tmpAuthDir;

		try {
			const results = await searchLlm("query with codex subscription", {});
			assert.strictEqual(results.length, 1);
			assert.strictEqual(results[0].title, "ChatGPT Live Web Result");
			assert.strictEqual(results[0].url, "https://openai.com/blog");
			assert.strictEqual(results[0].sourceProvider, "llm");
		} finally {
			process.env.PI_CODING_AGENT_DIR = originalEnv;
			fs.rmSync(tmpAuthDir, { recursive: true, force: true });
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("searchLlm - uses GitHub Copilot subscription when token exists", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(input);
			if (urlStr.includes("api.githubcopilot.com")) {
				const headers = init?.headers as Record<string, string>;
				assert.strictEqual(headers.Authorization, "Bearer copilot-test-token");

				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({
						choices: [
							{
								message: {
									content:
										"GitHub Copilot technical synthesis for requested query.",
								},
							},
						],
					}),
				} as unknown as Response;
			}
			throw new Error(`Unexpected: ${urlStr}`);
		}) as typeof fetch;

		const originalEnv = process.env.PI_CODING_AGENT_DIR;
		const tmpAuthDir = path.join(os.tmpdir(), `pi-test-copilot-${Date.now()}`);
		fs.mkdirSync(tmpAuthDir, { recursive: true });
		fs.writeFileSync(
			path.join(tmpAuthDir, "auth.json"),
			JSON.stringify({
				"github-copilot": {
					type: "oauth",
					access: "copilot-test-token",
				},
			}),
			"utf-8",
		);
		process.env.PI_CODING_AGENT_DIR = tmpAuthDir;

		try {
			const results = await searchLlm("query with copilot", {});
			assert.strictEqual(results.length, 1);
			assert.ok(results[0].title.includes("GitHub Copilot"));
			assert.strictEqual(results[0].sourceProvider, "llm");
		} finally {
			process.env.PI_CODING_AGENT_DIR = originalEnv;
			fs.rmSync(tmpAuthDir, { recursive: true, force: true });
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("searchLlm - returns active model knowledge synthesis when no keys or subscriptions available", async () => {
	const originalEnv = process.env.PI_CODING_AGENT_DIR;
	const tmpAuthDir = path.join(os.tmpdir(), `pi-test-empty-${Date.now()}`);
	fs.mkdirSync(tmpAuthDir, { recursive: true });
	fs.writeFileSync(path.join(tmpAuthDir, "auth.json"), "{}", "utf-8");
	process.env.PI_CODING_AGENT_DIR = tmpAuthDir;

	try {
		const results = await searchLlm("query with no credentials", {});
		assert.strictEqual(results.length, 1);
		assert.ok(results[0].title.includes("Active Model Knowledge Synthesis"));
		assert.strictEqual(results[0].sourceProvider, "llm");
	} finally {
		process.env.PI_CODING_AGENT_DIR = originalEnv;
		fs.rmSync(tmpAuthDir, { recursive: true, force: true });
	}
});
