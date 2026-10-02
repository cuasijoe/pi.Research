import { JSDOM } from "jsdom";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { ResearchConfig, SearchProviderName } from "../config.js";
import { DEFAULTS } from "../config.js";

export interface StoredCredential {
	type: string;
	key?: string;
	access?: string;
	refresh?: string;
	account?: string;
	expires?: number;
}

/**
 * Resolves credentials stored in Pi's auth system (~/.pi/agent/auth.json or ~/.pi/auth.json).
 * This allows reusing active subscriptions (ChatGPT Codex, GitHub Copilot, DeepSeek, etc.)
 * without requiring the user to configure redundant API keys in research.json.
 */
export function getPiAuthCredentials(customAuthPath?: string): Record<string, StoredCredential> {
	const creds: Record<string, StoredCredential> = {};

	const authPaths = customAuthPath
		? [customAuthPath]
		: process.env["PI_CODING_AGENT_DIR"]
			? [path.join(process.env["PI_CODING_AGENT_DIR"], "auth.json")]
			: [
					path.join(os.homedir(), ".pi", "agent", "auth.json"),
					path.join(os.homedir(), ".pi", "auth.json"),
				];

	for (const authFile of authPaths) {
		if (fs.existsSync(authFile)) {
			try {
				const raw = fs.readFileSync(authFile, "utf-8");
				const data = JSON.parse(raw);
				if (data && typeof data === "object") {
					for (const [provider, val] of Object.entries(data)) {
						if (val && typeof val === "object") {
							creds[provider] = val as StoredCredential;
						}
					}
				}
			} catch {
				// Ignore JSON read errors
			}
		}
	}

	// Fallback to readStoredCredential for wellKnown providers only when not in an isolated test directory
	if (!process.env["PI_CODING_AGENT_DIR"] && !customAuthPath) {
		const wellKnown = [
			"openai-codex",
			"github-copilot",
			"openai",
			"deepseek",
			"gemini",
			"anthropic",
		];
		for (const provider of wellKnown) {
			if (!creds[provider]) {
				try {
					const stored = readStoredCredential(provider);
					if (stored) creds[provider] = stored as StoredCredential;
				} catch {
					// Ignore
				}
			}
		}
	}

	return creds;
}

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	sourceProvider?: SearchProviderName;
}

/**
 * DuckDuckGo keyless HTML search (Last-resort free scraper).
 */
export async function searchDuckDuckGo(
	query: string,
	maxResults: number = DEFAULTS.maxSearchResults,
): Promise<SearchResult[]> {
	const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const res = await fetch(searchUrl, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		},
	});

	if (!res.ok) throw new Error(`DuckDuckGo search failed: ${res.statusText}`);
	const html = await res.text();

	// DDG returns 202 + a bot-challenge form when it detects automated access.
	if (html.includes("anomaly.js") || html.includes("cc=botnet")) {
		throw new Error(
			"DuckDuckGo returned a bot challenge (202). " +
				"Try adding a BRAVE_API_KEY or TAVILY_API_KEY to ~/.pi/research.json for reliable search.",
		);
	}

	const dom = new JSDOM(html);
	const results: SearchResult[] = [];

	const resultNodes = dom.window.document.querySelectorAll(".result");
	for (const node of Array.from(resultNodes).slice(0, maxResults)) {
		const anchor = node.querySelector<HTMLAnchorElement>(".result__title .result__a");
		const snippetNode = node.querySelector(".result__snippet");

		if (!anchor || !snippetNode) continue;

		let realUrl = "";
		try {
			const redirectHref = anchor.getAttribute("href") || "";
			const parsed = new URL(redirectHref, "https://html.duckduckgo.com");
			realUrl = parsed.searchParams.get("uddg") ?? redirectHref;
		} catch {
			realUrl = anchor.href || "";
		}

		if (!realUrl) continue;

		results.push({
			title: anchor.textContent?.trim() || "",
			url: realUrl,
			snippet: snippetNode.textContent?.trim() || "",
			sourceProvider: "duckduckgo",
		});
	}

	return results;
}

/**
 * Tavily Search API (LLM-optimized search with source citations).
 */
export async function searchTavily(
	query: string,
	apiKey: string,
	searchDepth: ResearchConfig["tavilySearchDepth"] = DEFAULTS.tavilySearchDepth,
	maxResults: number = DEFAULTS.maxSearchResults,
): Promise<SearchResult[]> {
	const res = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			query,
			search_depth: searchDepth,
			max_results: maxResults,
			include_answer: false,
		}),
	});

	if (!res.ok) throw new Error(`Tavily search failed (${res.status}): ${res.statusText}`);
	const data = (await res.json()) as {
		results?: Array<{ title: string; url: string; content: string }>;
	};

	const items = data.results || [];
	return items.map((r) => ({
		title: r.title,
		url: r.url,
		snippet: r.content,
		sourceProvider: "tavily",
	}));
}

/**
 * Brave Search API (Independent web index, 2,000 queries/mo free tier).
 */
export async function searchBrave(
	query: string,
	apiKey: string,
	maxResults: number = DEFAULTS.maxSearchResults,
): Promise<SearchResult[]> {
	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(Math.min(Math.max(maxResults, 1), 20)));

	const res = await fetch(url.toString(), {
		headers: {
			"X-Subscription-Token": apiKey,
			Accept: "application/json",
		},
	});

	if (!res.ok) throw new Error(`Brave search failed (${res.status}): ${res.statusText}`);
	const data = (await res.json()) as {
		web?: {
			results?: Array<{ title: string; url: string; description?: string }>;
		};
	};

	const items = data.web?.results || [];
	return items.slice(0, maxResults).map((r) => ({
		title: r.title,
		url: r.url,
		snippet: r.description || "",
		sourceProvider: "brave",
	}));
}

/**
 * Curated public SearXNG instances that support JSON API (format=json)
 * and have acceptable latency and uptime.
 */
export const DEFAULT_PUBLIC_SEARXNG_INSTANCES: string[] = [
	"https://search.banke.cloud",
	"https://searx.be",
	"https://search.ononoki.org",
	"https://searxng.site",
	"https://search.sapti.me",
	"https://searx.tiekoetter.com",
	"https://paulgo.io",
	"https://priv.au",
];

export interface SearxngOptions {
	customPool?: string[];
	disablePublicPool?: boolean;
	enableSearxSpacePool?: boolean;
	timeoutMs?: number;
	maxPoolAttempts?: number;
}

let searxSpaceCache: { timestamp: number; instances: string[] } | null = null;

/**
 * Dynamically queries https://searx.space/data/instances.json for active, high-uptime
 * public SearXNG instances. Results are cached in-memory for 1 hour.
 */
export async function fetchSearxSpaceInstances(timeoutMs: number = 3000): Promise<string[]> {
	const now = Date.now();
	if (searxSpaceCache && now - searxSpaceCache.timestamp < 60 * 60 * 1000) {
		return searxSpaceCache.instances;
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const res = await fetch("https://searx.space/data/instances.json", {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (compatible; pi-coding-agent/1.0; +https://github.com/earendil-works)",
				Accept: "application/json",
			},
			signal: controller.signal,
		});

		if (!res.ok) return [];
		const data = (await res.json()) as any;
		if (!data?.instances || typeof data.instances !== "object") return [];

		const candidates = Object.entries(data.instances)
			.filter(
				([_, info]: [string, any]) =>
					info?.network_type === "normal" && info?.http?.status_code === 200,
			)
			.map(([url]) => (url.endsWith("/") ? url.slice(0, -1) : url));

		searxSpaceCache = {
			timestamp: now,
			instances: candidates,
		};
		return candidates;
	} catch {
		return [];
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Provider-level circuit breaker to prevent repeated delays on persistently failing/blocked engines.
 */
export interface ProviderHealth {
	name: SearchProviderName;
	failureCount: number;
	lastFailureTime: number;
	lastError?: string;
}

const providerHealthMap = new Map<SearchProviderName, ProviderHealth>();

export function resetProviderHealthState(): void {
	providerHealthMap.clear();
}

export function getProviderHealthState(): Record<string, ProviderHealth> {
	const result: Record<string, ProviderHealth> = {};
	for (const [k, v] of providerHealthMap.entries()) {
		result[k] = { ...v };
	}
	return result;
}

interface SearxngInstanceState {
	url: string;
	failureCount: number;
	lastFailureTime: number;
	lastResponseTimeMs?: number;
}

const instanceHealthMap = new Map<string, SearxngInstanceState>();
let preferredSearxngInstance: string | null = null;

/**
 * Resets the in-memory pool health and preferred instance tracking (useful for tests).
 */
export function resetSearxngPoolState(): void {
	instanceHealthMap.clear();
	preferredSearxngInstance = null;
	searxSpaceCache = null;
}

/**
 * Returns current pool health metrics for diagnostics.
 */
export function getSearxngPoolState(): {
	preferred: string | null;
	health: Record<string, SearxngInstanceState>;
} {
	const health: Record<string, SearxngInstanceState> = {};
	for (const [url, state] of instanceHealthMap.entries()) {
		health[url] = { ...state };
	}
	return { preferred: preferredSearxngInstance, health };
}

/**
 * Queries a single SearXNG instance.
 * Attempts JSON API first for speed. If the operator disabled JSON (403/non-JSON)
 * or rate-limited the JSON endpoint (429), transparently falls back to HTML
 * scraping mode on the same instance using standard browser headers and JSDOM parsing.
 */
export async function querySingleSearXNGInstance(
	baseUrl: string,
	query: string,
	maxResults: number,
	timeoutMs: number = 2500,
): Promise<SearchResult[]> {
	const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

	// 1. First, attempt format=json
	try {
		const jsonUrl = new URL("search", normalizedBase);
		jsonUrl.searchParams.set("q", query);
		jsonUrl.searchParams.set("format", "json");

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		try {
			const res = await fetch(jsonUrl.toString(), {
				headers: {
					Accept: "application/json",
					"User-Agent":
						"Mozilla/5.0 (compatible; pi-coding-agent/1.0; +https://github.com/earendil-works)",
				},
				signal: controller.signal,
			});

			const contentType = res.headers?.get
				? res.headers.get("content-type") || ""
				: "application/json";
			if (res.ok && contentType.includes("json")) {
				const data = (await res.json()) as {
					results?: Array<{ title?: string; url?: string; content?: string }>;
				};

				const items = data.results || [];
				if (items.length > 0) {
					return items.slice(0, maxResults).map((r) => ({
						title: r.title || "",
						url: r.url || "",
						snippet: r.content || "",
						sourceProvider: "searxng" as const,
					}));
				}
			}
		} finally {
			clearTimeout(timer);
		}
	} catch {
		// Fall through to HTML mode
	}

	// 2. HTML Fallback: Query standard web UI with browser headers and parse DOM
	const htmlUrl = new URL("search", normalizedBase);
	htmlUrl.searchParams.set("q", query);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const res = await fetch(htmlUrl.toString(), {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.5",
			},
			signal: controller.signal,
		});

		if (!res.ok) {
			throw new Error(`SearXNG HTTP error (${res.status}): ${res.statusText}`);
		}

		const html = await res.text();
		if (
			html.includes('endpoint="index"') ||
			html.includes('<meta name="endpoint" content="index">')
		) {
			throw new Error("SearXNG returned index homepage instead of search results");
		}
		if (html.includes("cf-browser-verification") || html.includes("Verifying your browser")) {
			throw new Error("SearXNG returned Cloudflare challenge");
		}

		const dom = new JSDOM(html);
		const doc = dom.window.document;
		const articles = doc.querySelectorAll("article.result, .result, .result-default");
		const results: SearchResult[] = [];

		for (const art of Array.from(articles).slice(0, maxResults)) {
			const titleAnchor = art.querySelector<HTMLAnchorElement>("h3 a, h4 a, .result_title a");
			const contentEl = art.querySelector(".content, .result_content, p");

			if (titleAnchor) {
				const title = titleAnchor.textContent?.trim() || "";
				const href = titleAnchor.getAttribute("href") || "";
				const snippet = contentEl?.textContent?.trim() || "";

				if (title && href) {
					results.push({
						title,
						url: href,
						snippet,
						sourceProvider: "searxng",
					});
				}
			}
		}

		if (results.length > 0) {
			return results;
		}

		throw new Error("SearXNG HTML search returned 0 parseable results");
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Queries public SearXNG instances using circuit-breaker rotation.
 * Automatically tries the healthiest/fastest instance and rotates on failure.
 */
export async function searchSearXNGPool(
	query: string,
	maxResults: number = DEFAULTS.maxSearchResults,
	options?: SearxngOptions,
): Promise<SearchResult[]> {
	let basePool =
		options?.customPool && options.customPool.length > 0
			? options.customPool
			: DEFAULT_PUBLIC_SEARXNG_INSTANCES;

	if (options?.enableSearxSpacePool) {
		try {
			const dynamicInstances = await fetchSearxSpaceInstances(options.timeoutMs ?? 2500);
			if (dynamicInstances.length > 0) {
				basePool = Array.from(new Set([...basePool, ...dynamicInstances]));
			}
		} catch {
			// Fall back to basePool
		}
	}

	const pool = basePool;
	const maxAttempts = options?.maxPoolAttempts ?? 3;
	const timeoutMs = options?.timeoutMs ?? 2500;
	const cooldownMs = 10 * 60 * 1000; // 10 minutes

	const now = Date.now();
	const candidates = [...pool].sort((a, b) => {
		// 1. Preferred instance from current session goes first
		if (a === preferredSearxngInstance) return -1;
		if (b === preferredSearxngInstance) return 1;

		const healthA = instanceHealthMap.get(a);
		const healthB = instanceHealthMap.get(b);

		const onCooldownA = healthA && now - healthA.lastFailureTime < cooldownMs;
		const onCooldownB = healthB && now - healthB.lastFailureTime < cooldownMs;

		if (!onCooldownA && onCooldownB) return -1;
		if (onCooldownA && !onCooldownB) return 1;

		return (healthA?.failureCount || 0) - (healthB?.failureCount || 0);
	});

	const errors: string[] = [];
	let attempts = 0;

	for (const instanceUrl of candidates) {
		if (attempts >= maxAttempts) break;
		attempts++;

		const startTime = Date.now();
		try {
			const results = await querySingleSearXNGInstance(
				instanceUrl,
				query,
				maxResults,
				timeoutMs,
			);
			preferredSearxngInstance = instanceUrl;
			instanceHealthMap.set(instanceUrl, {
				url: instanceUrl,
				failureCount: 0,
				lastFailureTime: 0,
				lastResponseTimeMs: Date.now() - startTime,
			});
			return results;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`${instanceUrl} (${msg})`);

			const current = instanceHealthMap.get(instanceUrl) || {
				url: instanceUrl,
				failureCount: 0,
				lastFailureTime: 0,
			};
			current.failureCount += 1;
			current.lastFailureTime = Date.now();
			instanceHealthMap.set(instanceUrl, current);

			if (preferredSearxngInstance === instanceUrl) {
				preferredSearxngInstance = null;
			}
		}
	}

	throw new Error(
		`Public SearXNG pool exhausted after ${attempts} attempts: ${errors.join("; ")}`,
	);
}

/**
 * SearXNG Meta-Search API (Self-hosted instance or dynamic public instance pool fallback).
 */
export async function searchSearXNG(
	query: string,
	baseUrl?: string,
	maxResults: number = DEFAULTS.maxSearchResults,
	options?: SearxngOptions,
): Promise<SearchResult[]> {
	// If baseUrl is provided (e.g. self-hosted instance from config.SEARXNG_URL), try it first
	if (baseUrl) {
		try {
			return await querySingleSearXNGInstance(
				baseUrl,
				query,
				maxResults,
				options?.timeoutMs ?? 5000,
			);
		} catch (err) {
			if (options?.disablePublicPool) {
				throw err;
			}
			console.warn(
				`[pi.Research] Configured SEARXNG_URL (${baseUrl}) failed: ${err instanceof Error ? err.message : String(err)}. Falling back to public pool...`,
			);
		}
	}

	if (options?.disablePublicPool) {
		throw new Error("SearXNG failed: no SEARXNG_URL configured and public pool is disabled");
	}

	return await searchSearXNGPool(query, maxResults, options);
}

/**
 * Jina Search API (s.jina.ai - returns clean, markdown-friendly search items).
 */
export async function searchJina(
	query: string,
	apiKey?: string,
	maxResults: number = DEFAULTS.maxSearchResults,
): Promise<SearchResult[]> {
	const url = `https://s.jina.ai/${encodeURIComponent(query)}`;
	const headers: Record<string, string> = {
		Accept: "application/json",
	};
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	const res = await fetch(url, { headers });
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(
			`Jina search failed (${res.status}): ${body.slice(0, 200) || res.statusText}`,
		);
	}

	const data = (await res.json()) as {
		data?: Array<{
			title?: string;
			url?: string;
			description?: string;
			content?: string;
		}>;
	};

	const items = data.data || [];
	return items.slice(0, maxResults).map((r) => ({
		title: r.title || "",
		url: r.url || "",
		snippet: r.description || (r.content ? r.content.slice(0, 300) : ""),
		sourceProvider: "jina",
	}));
}

/**
 * Cascading resilient web search orchestrator.
 *
 * Tries providers in priority order. If one fails or is rate-limited,
 * logs a diagnostic warning and immediately cascades to the next tier.
 */
/**
 * LLM Grounding & Parametric Knowledge Fallback (Last Resort).
 *
 * Piggybacks on whatever LLM provider is active or configured:
 * 1. Gemini Google Grounding: If GEMINI_API_KEY is present, runs live Google Search grounding.
 * 2. OpenAI Knowledge Synthesis: If OPENAI_API_KEY is present, queries OpenAI for synthesized factual docs.
 * 3. Ollama: If OLLAMA_HOST is present, queries local model.
 */
export async function searchLlm(
	query: string,
	config: ResearchConfig,
	maxResults: number = DEFAULTS.maxSearchResults,
): Promise<SearchResult[]> {
	const piCreds = getPiAuthCredentials();

	// 1. Explicit Gemini API key in config
	const explicitGeminiKey = config.GEMINI_API_KEY;
	if (explicitGeminiKey) {
		try {
			const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${explicitGeminiKey}`;
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [
						{
							role: "user",
							parts: [
								{
									text: `Search for documentation and factual information about: ${query}`,
								},
							],
						},
					],
					tools: [{ google_search: {} }],
				}),
			});

			if (res.ok) {
				const data = (await res.json()) as any;
				const candidate = data.candidates?.[0];
				const chunks = candidate?.groundingMetadata?.groundingChunks || [];
				const answerText = candidate?.content?.parts?.[0]?.text || "";

				if (chunks.length > 0) {
					return chunks.slice(0, maxResults).map((chunk: any) => ({
						title: chunk.web?.title || `Google Grounded Search: ${query}`,
						url: chunk.web?.uri || "https://google.com/search",
						snippet:
							answerText.slice(0, 300) ||
							"Grounded result from Google Search via Gemini",
						sourceProvider: "llm" as const,
					}));
				}

				if (answerText) {
					return [
						{
							title: `Gemini Synthesis: ${query}`,
							url: "https://ai.google.dev",
							snippet: answerText.slice(0, 500),
							sourceProvider: "llm" as const,
						},
					];
				}
			}
		} catch (e) {
			console.warn("[pi.Research] Gemini LLM grounding attempt failed:", e);
		}
	}

	// 2. Explicit OpenAI API key in config
	const explicitOpenAiKey = config.OPENAI_API_KEY;
	if (explicitOpenAiKey) {
		try {
			const res = await fetch("https://api.openai.com/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${explicitOpenAiKey}`,
				},
				body: JSON.stringify({
					model: "gpt-4o-mini",
					messages: [
						{
							role: "system",
							content:
								"You are a technical documentation assistant. Provide a concise, factual summary of the requested topic, and cite real official documentation URLs where possible.",
						},
						{
							role: "user",
							content: query,
						},
					],
					temperature: 0.1,
				}),
			});

			if (res.ok) {
				const data = (await res.json()) as any;
				const text = data.choices?.[0]?.message?.content || "";
				if (text) {
					return [
						{
							title: `OpenAI Knowledge Synthesis: ${query}`,
							url: "https://platform.openai.com/docs",
							snippet: text.slice(0, 500),
							sourceProvider: "llm" as const,
						},
					];
				}
			}
		} catch (e) {
			console.warn("[pi.Research] OpenAI LLM synthesis attempt failed:", e);
		}
	}

	// 3. ChatGPT / Codex subscription (OAuth token in ~/.pi/agent/auth.json via /login)
	const codexCred =
		piCreds["openai-codex"] ||
		(piCreds["openai"]?.type === "oauth" ? piCreds["openai"] : undefined);
	if (codexCred?.access) {
		try {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				Authorization: `Bearer ${codexCred.access}`,
				"User-Agent": "pi-coding-agent",
			};
			if (codexCred.account) {
				headers["ChatGPT-Account-ID"] = codexCred.account;
			}

			const res = await fetch("https://chatgpt.com/backend-api/codex/responses", {
				method: "POST",
				headers,
				body: JSON.stringify({
					model: "gpt-4o",
					tools: [{ type: "web_search" }],
					input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
				}),
			});

			if (res.ok) {
				const data = (await res.json()) as any;
				const text = data.output?.[0]?.content?.[0]?.text || data.text || "";
				const citations = data.sources || data.citations || [];

				if (citations.length > 0) {
					return citations.slice(0, maxResults).map((c: any) => ({
						title: c.title || `ChatGPT Search: ${query}`,
						url: c.url || "https://chatgpt.com",
						snippet: c.snippet || text.slice(0, 300),
						sourceProvider: "llm" as const,
					}));
				}

				if (text) {
					return [
						{
							title: `ChatGPT Subscription Search: ${query}`,
							url: "https://chatgpt.com",
							snippet: text.slice(0, 500),
							sourceProvider: "llm" as const,
						},
					];
				}
			}
		} catch (e) {
			console.warn("[pi.Research] ChatGPT Codex subscription search attempt failed:", e);
		}
	}

	// 4. GitHub Copilot subscription (OAuth token in ~/.pi/agent/auth.json via /login)
	const copilotCred = piCreds["github-copilot"];
	if (copilotCred?.access) {
		try {
			const res = await fetch("https://api.githubcopilot.com/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${copilotCred.access}`,
					"Editor-Version": "pi/1.0.0",
				},
				body: JSON.stringify({
					model: "gpt-4o",
					messages: [
						{
							role: "system",
							content:
								"You are a technical documentation assistant. Provide a concise, factual summary of the requested topic and cite official documentation URLs where known.",
						},
						{
							role: "user",
							content: query,
						},
					],
					temperature: 0.1,
				}),
			});

			if (res.ok) {
				const data = (await res.json()) as any;
				const text = data.choices?.[0]?.message?.content || "";
				if (text) {
					return [
						{
							title: `GitHub Copilot Knowledge Synthesis: ${query}`,
							url: "https://github.com/features/copilot",
							snippet: text.slice(0, 500),
							sourceProvider: "llm" as const,
						},
					];
				}
			}
		} catch (e) {
			console.warn("[pi.Research] GitHub Copilot subscription synthesis attempt failed:", e);
		}
	}

	// 5. DeepSeek (from Pi auth)
	const deepseekKey = piCreds["deepseek"]?.key;
	if (deepseekKey) {
		try {
			const res = await fetch("https://api.deepseek.com/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${deepseekKey}`,
				},
				body: JSON.stringify({
					model: "deepseek-chat",
					messages: [
						{
							role: "system",
							content:
								"You are a technical research assistant. Provide a concise factual summary with official documentation links.",
						},
						{ role: "user", content: query },
					],
				}),
			});

			if (res.ok) {
				const data = (await res.json()) as any;
				const text = data.choices?.[0]?.message?.content || "";
				if (text) {
					return [
						{
							title: `DeepSeek Synthesis: ${query}`,
							url: "https://api.deepseek.com",
							snippet: text.slice(0, 500),
							sourceProvider: "llm" as const,
						},
					];
				}
			}
		} catch (e) {
			console.warn("[pi.Research] DeepSeek synthesis attempt failed:", e);
		}
	}

	// 6. Gemini from Env or Pi Auth
	const ambientGeminiKey = process.env["GEMINI_API_KEY"] || piCreds["gemini"]?.key;
	if (ambientGeminiKey) {
		try {
			const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${ambientGeminiKey}`;
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [
						{
							role: "user",
							parts: [
								{
									text: `Search for documentation and factual information about: ${query}`,
								},
							],
						},
					],
					tools: [{ google_search: {} }],
				}),
			});

			if (res.ok) {
				const data = (await res.json()) as any;
				const candidate = data.candidates?.[0];
				const chunks = candidate?.groundingMetadata?.groundingChunks || [];
				const answerText = candidate?.content?.parts?.[0]?.text || "";

				if (chunks.length > 0) {
					return chunks.slice(0, maxResults).map((chunk: any) => ({
						title: chunk.web?.title || `Google Grounded Search: ${query}`,
						url: chunk.web?.uri || "https://google.com/search",
						snippet:
							answerText.slice(0, 300) ||
							"Grounded result from Google Search via Gemini",
						sourceProvider: "llm" as const,
					}));
				}

				if (answerText) {
					return [
						{
							title: `Gemini Synthesis: ${query}`,
							url: "https://ai.google.dev",
							snippet: answerText.slice(0, 500),
							sourceProvider: "llm" as const,
						},
					];
				}
			}
		} catch (e) {
			console.warn("[pi.Research] Gemini LLM grounding attempt failed:", e);
		}
	}

	// 5. OpenAI API Key (Config, Env, or Pi auth)
	const openaiKey =
		config.OPENAI_API_KEY || process.env["OPENAI_API_KEY"] || piCreds["openai"]?.key;
	if (openaiKey) {
		try {
			const res = await fetch("https://api.openai.com/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${openaiKey}`,
				},
				body: JSON.stringify({
					model: "gpt-4o-mini",
					messages: [
						{
							role: "system",
							content:
								"You are a technical documentation assistant. Provide a concise, factual summary of the requested topic, and cite real official documentation URLs where possible.",
						},
						{
							role: "user",
							content: query,
						},
					],
					temperature: 0.1,
				}),
			});

			if (res.ok) {
				const data = (await res.json()) as any;
				const text = data.choices?.[0]?.message?.content || "";
				if (text) {
					return [
						{
							title: `OpenAI Knowledge Synthesis: ${query}`,
							url: "https://platform.openai.com/docs",
							snippet: text.slice(0, 500),
							sourceProvider: "llm" as const,
						},
					];
				}
			}
		} catch (e) {
			console.warn("[pi.Research] OpenAI LLM synthesis attempt failed:", e);
		}
	}

	// 6. Local Ollama
	const ollamaHost = config.OLLAMA_HOST || process.env["OLLAMA_HOST"];
	if (ollamaHost) {
		try {
			const normalizedHost = ollamaHost.endsWith("/") ? ollamaHost.slice(0, -1) : ollamaHost;
			const res = await fetch(`${normalizedHost}/api/generate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "llama3",
					prompt: `Summarize official technical documentation and facts for: ${query}. Include official URLs.`,
					stream: false,
				}),
			});

			if (res.ok) {
				const data = (await res.json()) as any;
				if (data.response) {
					return [
						{
							title: `Ollama Local Synthesis: ${query}`,
							url: "http://localhost:11434",
							snippet: data.response.slice(0, 500),
							sourceProvider: "llm" as const,
						},
					];
				}
			}
		} catch (e) {
			console.warn("[pi.Research] Ollama LLM synthesis attempt failed:", e);
		}
	}

	// 7. Parametric In-Session Knowledge (Ultimate fallback for any active Pi model)
	return [
		{
			title: `Active Model Knowledge Synthesis: ${query}`,
			url: "https://pi.research/knowledge-synthesis",
			snippet: `[Live web search was unavailable across all configured search engines. Falling back to the active Pi model subscription's internal parametric knowledge base for: ${query}]`,
			sourceProvider: "llm" as const,
		},
	];
}

/**
 * Cascading resilient web search orchestrator.
 *
 * Tries providers in priority order. If one fails or is rate-limited,
 * logs a diagnostic warning and immediately cascades to the next tier,
 * with the active LLM as the ultimate backstop.
 */
export async function searchWeb(query: string, config: ResearchConfig): Promise<SearchResult[]> {
	const maxResults = config.maxSearchResults ?? DEFAULTS.maxSearchResults;

	// Determine candidate order:
	// Custom preference takes precedence; otherwise automatic smart fallback cascade.
	let candidateProviders: SearchProviderName[];
	if (config.searchProviders && config.searchProviders.length > 0) {
		candidateProviders = config.searchProviders;
	} else {
		candidateProviders = [];
		if (config.TAVILY_API_KEY) candidateProviders.push("tavily");
		if (config.BRAVE_API_KEY) candidateProviders.push("brave");
		if (config.SEARXNG_URL || config.disablePublicSearxngPool !== true) {
			candidateProviders.push("searxng");
		}
		candidateProviders.push("jina");
		candidateProviders.push("duckduckgo");
		if (config.allowLlmFallback !== false) {
			candidateProviders.push("llm");
		}
	}

	const diagnostics: string[] = [];
	const now = Date.now();
	const cooldownMs = config.providerCooldownMs ?? DEFAULTS.providerCooldownMs;

	for (const provider of candidateProviders) {
		// Check provider-level circuit breaker:
		// If a provider failed recently (e.g. DDG 202 bot challenge, Jina AS7018 block, SearXNG 429),
		// skip it immediately to avoid 5-8s unnecessary lag on every subsequent query,
		// UNLESS all candidate providers are on cooldown (in which case we try the oldest failed one as last resort).
		const health = providerHealthMap.get(provider);
		const onCooldown = health && now - health.lastFailureTime < cooldownMs;

		if (onCooldown) {
			const hasAlternative = candidateProviders.some((p) => {
				const h = providerHealthMap.get(p);
				return !h || now - h.lastFailureTime >= cooldownMs;
			});
			if (hasAlternative) {
				const remainingSec = Math.round(
					(cooldownMs - (now - health.lastFailureTime)) / 1000,
				);
				diagnostics.push(
					`${provider}: skipped (circuit breaker cooldown for ${remainingSec}s due to: ${health.lastError?.slice(0, 80)})`,
				);
				continue;
			}
		}

		try {
			let results: SearchResult[] = [];
			switch (provider) {
				case "tavily": {
					if (!config.TAVILY_API_KEY) {
						diagnostics.push("tavily: skipped (no TAVILY_API_KEY configured)");
						continue;
					}
					results = await searchTavily(
						query,
						config.TAVILY_API_KEY,
						config.tavilySearchDepth ?? DEFAULTS.tavilySearchDepth,
						maxResults,
					);
					break;
				}
				case "brave": {
					if (!config.BRAVE_API_KEY) {
						diagnostics.push("brave: skipped (no BRAVE_API_KEY configured)");
						continue;
					}
					results = await searchBrave(query, config.BRAVE_API_KEY, maxResults);
					break;
				}
				case "searxng": {
					if (!config.SEARXNG_URL && config.disablePublicSearxngPool) {
						diagnostics.push(
							"searxng: skipped (no SEARXNG_URL and public pool disabled)",
						);
						continue;
					}
					results = await searchSearXNG(query, config.SEARXNG_URL, maxResults, {
						customPool: config.searxngPool,
						disablePublicPool: config.disablePublicSearxngPool,
						enableSearxSpacePool: config.enableSearxSpacePool,
					});
					break;
				}
				case "jina": {
					results = await searchJina(query, config.JINA_API_KEY, maxResults);
					break;
				}
				case "duckduckgo": {
					results = await searchDuckDuckGo(query, maxResults);
					break;
				}
				case "llm": {
					results = await searchLlm(query, config, maxResults);
					break;
				}
			}

			if (results && results.length > 0) {
				// Reset provider health on success
				providerHealthMap.set(provider, {
					name: provider,
					failureCount: 0,
					lastFailureTime: 0,
				});
				return results;
			}

			diagnostics.push(`${provider}: returned 0 results`);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			diagnostics.push(`${provider}: ${msg}`);
			console.warn(
				`[pi.Research] Provider '${provider}' failed: ${msg}. Cascading to next provider...`,
			);

			// Record failure in circuit breaker
			const current = providerHealthMap.get(provider) || {
				name: provider,
				failureCount: 0,
				lastFailureTime: 0,
			};
			current.failureCount += 1;
			current.lastFailureTime = Date.now();
			current.lastError = msg;
			providerHealthMap.set(provider, current);
		}
	}

	throw new Error(
		`All search providers failed for query "${query}":\n  - ${diagnostics.join("\n  - ")}`,
	);
}
