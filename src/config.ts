/**
 * Configuration loaded from ~/.pi/research.json
 * All fields are optional — the extension works zero-config by default.
 */
export type SearchProviderName = "tavily" | "brave" | "searxng" | "jina" | "duckduckgo" | "llm";

export interface ResearchConfig {
	// ── Provider keys & endpoints ──────────────────────────────────────────────
	/** Tavily Search API key. When present, used as an authorized provider. */
	TAVILY_API_KEY?: string;
	/** Brave Search API key (2,000 free queries/month). */
	BRAVE_API_KEY?: string;
	/** Jina API key. Optional: provides higher rate limits for Jina Reader / Jina Search. */
	JINA_API_KEY?: string;
	/** SearXNG instance base URL (e.g. "http://localhost:8080"). */
	SEARXNG_URL?: string;
	/** Custom list of public SearXNG instances for pool fallback. */
	searxngPool?: string[];
	/** Whether to disable querying the public SearXNG instance pool when SEARXNG_URL is not provided. Default: false */
	disablePublicSearxngPool?: boolean;
	/** Whether to dynamically query searx.space for active public instances. Default: false */
	enableSearxSpacePool?: boolean;
	/** GitHub personal access token for unthrottled API access (optional). */
	GITHUB_TOKEN?: string;
	/** Cooldown duration in milliseconds to temporarily bypass failing search providers. Default: 900000 (15m) */
	providerCooldownMs?: number;

	// ── LLM fallback credentials (Last resort) ─────────────────────────────────
	/** Gemini API key (supports native Google Search Grounding). */
	GEMINI_API_KEY?: string;
	/** OpenAI API key for fallback knowledge synthesis. */
	OPENAI_API_KEY?: string;
	/** Local Ollama host (e.g. "http://localhost:11434"). */
	OLLAMA_HOST?: string;
	/** Whether to use the LLM as the ultimate fallback when all search engines fail. Default: true */
	allowLlmFallback?: boolean;

	// ── Provider routing ───────────────────────────────────────────────────────
	/**
	 * Optional custom order or subset of search providers to try.
	 * If omitted, the default resilient cascade is used:
	 * [tavily (if keyed), brave (if keyed), searxng (if configured), jina, duckduckgo, llm]
	 */
	searchProviders?: SearchProviderName[];

	// ── Search tuning ──────────────────────────────────────────────────────────
	/** Maximum number of search results to return per query. Default: 5 */
	maxSearchResults?: number;
	/**
	 * Tavily search depth. "basic" is cheaper/faster; "advanced" is more thorough.
	 * Default: "basic"
	 */
	tavilySearchDepth?: "basic" | "advanced";

	// ── Extraction tuning ──────────────────────────────────────────────────────
	/**
	 * Maximum characters returned from read_page_markdown before the rest is
	 * cached and a cache_id is returned. Default: 15000
	 */
	maxChars?: number;
	/**
	 * Maximum context lines returned by search_cache, including surrounding context.
	 * Default: 200
	 */
	cacheMaxResultLines?: number;
	/**
	 * How long a cached page entry lives before being evicted, in milliseconds.
	 * Default: 1800000 (30 minutes)
	 */
	cacheTtlMs?: number;

	// ── Agent tuning ───────────────────────────────────────────────────────────
	/**
	 * Optional model name to use for the research subagent (e.g. "gpt-4o-mini", "claude-3-5-haiku").
	 * If omitted, defaults to the active parent session model.
	 */
	agentModel?: string;
	/**
	 * Hard wall-clock timeout for the research subagent, in milliseconds.
	 * Default: 60000 (60 seconds)
	 */
	agentTimeoutMs?: number;
	/**
	 * Maximum tokens the research subagent may generate.
	 * Default: 4000
	 */
	agentMaxTokens?: number;
	/**
	 * Sampling temperature for the research subagent (0 = deterministic).
	 * Default: 0.1
	 */
	agentTemperature?: number;
}

// ── Defaults ─────────────────────────────────────────────────────────────────
// Centralising all defaults here makes them easy to find, document, and test.

export const DEFAULTS = {
	maxSearchResults: 5,
	tavilySearchDepth: "basic" as const,
	allowLlmFallback: true,
	disablePublicSearxngPool: false,
	enableSearxSpacePool: false,
	providerCooldownMs: 15 * 60 * 1000, // 15 minutes
	maxChars: 15_000,
	cacheMaxResultLines: 200,
	cacheTtlMs: 30 * 60 * 1000, // 30 minutes
	agentTimeoutMs: 60_000, // 60 seconds
	agentMaxTokens: 4_000,
	agentTemperature: 0.1,
} satisfies Required<
	Omit<
		ResearchConfig,
		| "TAVILY_API_KEY"
		| "BRAVE_API_KEY"
		| "JINA_API_KEY"
		| "GITHUB_TOKEN"
		| "SEARXNG_URL"
		| "searxngPool"
		| "GEMINI_API_KEY"
		| "OPENAI_API_KEY"
		| "OLLAMA_HOST"
		| "searchProviders"
		| "agentModel"
	>
>;
