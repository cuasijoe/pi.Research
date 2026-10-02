export interface Tool {
	name: string;
	description: string;
	parameters: {
		type: string;
		properties: Record<string, unknown>;
		required: string[];
	};
	execute: (args: any) => Promise<string>;
}
import { searchWeb } from "../providers/search.js";
import { extractPage } from "../providers/extract.js";
import type { ResearchConfig } from "../config.js";
import { DEFAULTS } from "../config.js";

const CONTEXT_LINES = 3; // Lines of context around each cache match (grep -C 3 equivalent)

interface CacheEntry {
	markdown: string;
	expiresAt: number;
}

// TTL-bounded cache — entries expire based on config.cacheTtlMs (default: 30 minutes).
const pageCache = new Map<string, CacheEntry>();

function sweepExpiredEntries() {
	const now = Date.now();
	for (const [key, entry] of pageCache) {
		if (now > entry.expiresAt) pageCache.delete(key);
	}
}

function setCacheEntry(markdown: string, ttlMs: number): string {
	sweepExpiredEntries();
	const cacheId = crypto.randomUUID();
	pageCache.set(cacheId, { markdown, expiresAt: Date.now() + ttlMs });
	return cacheId;
}

export function getCacheEntry(cacheId: string): string | undefined {
	const entry = pageCache.get(cacheId);
	if (!entry) return undefined;
	if (Date.now() > entry.expiresAt) {
		pageCache.delete(cacheId);
		return undefined;
	}
	return entry.markdown;
}

export interface MarkdownChunk {
	header: string;
	content: string;
	index: number;
}

/**
 * Splits Markdown text into semantic sections using markdown headers (# to ####).
 * If a section exceeds maxChunkChars, subdivides by paragraphs.
 */
export function chunkMarkdownByHeaders(
	markdown: string,
	maxChunkChars: number = 2500,
): MarkdownChunk[] {
	const lines = markdown.split("\n");
	const chunks: MarkdownChunk[] = [];
	let currentHeader = "Introduction";
	let currentLines: string[] = [];

	const flush = () => {
		const text = currentLines.join("\n").trim();
		if (text.length > 0) {
			if (text.length > maxChunkChars) {
				// Subdivide large section by double newlines (paragraphs)
				const paragraphs = text.split(/\n\s*\n/);
				let subLines: string[] = [];
				let subIndex = 1;
				for (const p of paragraphs) {
					if (
						subLines.join("\n\n").length + p.length > maxChunkChars &&
						subLines.length > 0
					) {
						chunks.push({
							header: `${currentHeader} (Part ${subIndex++})`,
							content: subLines.join("\n\n"),
							index: chunks.length,
						});
						subLines = [];
					}
					subLines.push(p);
				}
				if (subLines.length > 0) {
					chunks.push({
						header:
							subIndex > 1 ? `${currentHeader} (Part ${subIndex})` : currentHeader,
						content: subLines.join("\n\n"),
						index: chunks.length,
					});
				}
			} else {
				chunks.push({
					header: currentHeader,
					content: text,
					index: chunks.length,
				});
			}
		}
		currentLines = [];
	};

	for (const line of lines) {
		const headerMatch = line.match(/^(#{1,4})\s+(.+)$/);
		if (headerMatch) {
			flush();
			currentHeader = line.trim();
		} else {
			currentLines.push(line);
		}
	}
	flush();

	return chunks;
}

/**
 * Fast, lightweight BM25 scoring heuristic for ranking markdown chunks against a query.
 */
export function rankChunksBM25(
	chunks: MarkdownChunk[],
	query: string,
): Array<MarkdownChunk & { score: number }> {
	if (!query || query.trim().length === 0 || chunks.length === 0) {
		return chunks.map((c) => ({ ...c, score: 0 }));
	}

	const tokenize = (text: string): string[] => {
		return text.toLowerCase().match(/\b[a-z0-9_-]{2,}\b/g) || [];
	};

	const queryTerms = tokenize(query);
	if (queryTerms.length === 0) {
		return chunks.map((c) => ({ ...c, score: 0 }));
	}

	const chunkTokens = chunks.map((c) => tokenize(`${c.header} ${c.content}`));
	const N = chunks.length;
	const avgdl = chunkTokens.reduce((sum, t) => sum + t.length, 0) / (N || 1);

	// Document frequency per query term
	const df: Record<string, number> = {};
	for (const term of queryTerms) {
		df[term] = chunkTokens.filter((tokens) => tokens.includes(term)).length;
	}

	const k1 = 1.5;
	const b = 0.75;

	const scored = chunks.map((chunk, i) => {
		const tokens = chunkTokens[i];
		const dl = tokens.length;
		let score = 0;

		// Count term frequencies in this chunk
		const tf: Record<string, number> = {};
		for (const token of tokens) {
			tf[token] = (tf[token] || 0) + 1;
		}

		for (const term of queryTerms) {
			const termDf = df[term] || 0;
			if (termDf === 0) continue;
			const termTf = tf[term] || 0;
			if (termTf === 0) continue;

			// BM25 IDF
			const idf = Math.log(1 + (N - termDf + 0.5) / (termDf + 0.5));
			// BM25 TF component
			const tfComponent =
				(termTf * (k1 + 1)) / (termTf + k1 * (1 - b + b * (dl / (avgdl || 1))));
			score += idf * tfComponent;
		}

		return { ...chunk, score };
	});

	return scored.sort((a, b) => b.score - a.score);
}

// Context-aware search — returns matches plus surrounding lines
function searchWithContext(doc: string, query: string, maxResultLines: number): string {
	const lines = doc.split("\n");
	const lowerQuery = query.toLowerCase();
	const matchIndices: number[] = [];

	lines.forEach((line, i) => {
		if (line.toLowerCase().includes(lowerQuery)) matchIndices.push(i);
	});

	if (matchIndices.length === 0) return "No matches found.";

	// Merge overlapping context windows
	const chunks: string[] = [];
	const collected = new Set<number>();
	for (const idx of matchIndices) {
		const start = Math.max(0, idx - CONTEXT_LINES);
		const end = Math.min(lines.length - 1, idx + CONTEXT_LINES);
		for (let i = start; i <= end; i++) collected.add(i);
	}

	const sortedIndices = [...collected].sort((a, b) => a - b);
	// Detect gaps between context windows and add separators
	let prev = -2;
	for (const i of sortedIndices) {
		if (i > prev + 1 && prev !== -2) chunks.push("...");
		chunks.push(lines[i]);
		prev = i;
	}

	// Cap total output to protect the LLM context window
	return chunks.slice(0, maxResultLines).join("\n");
}

export function getResearchTools(config: ResearchConfig): Tool[] {
	const maxChars = config.maxChars ?? DEFAULTS.maxChars;
	const cacheTtlMs = config.cacheTtlMs ?? DEFAULTS.cacheTtlMs;
	const cacheMaxResultLines = config.cacheMaxResultLines ?? DEFAULTS.cacheMaxResultLines;
	return [
		{
			name: "search_web",
			description:
				"Search the web for information. Returns deduplicated snippets with title, URL, and a short excerpt.",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "The search query",
					},
				},
				required: ["query"],
			},
			execute: async (args: { query: string }) => {
				try {
					const results = await searchWeb(args.query, config);
					return JSON.stringify(results, null, 2);
				} catch (e: unknown) {
					const message = e instanceof Error ? e.message : String(e);
					return `Search failed: ${message}`;
				}
			},
		},
		{
			name: "read_page_markdown",
			description:
				"Read a web page and convert it to clean markdown. If the page is very large, uses semantic chunking and BM25 re-ranking to extract the most relevant sections for your query, caching the full document. Use search_cache(cache_id, query) to find specific facts in the remainder.",
			parameters: {
				type: "object",
				properties: {
					url: {
						type: "string",
						description: "The URL to read",
					},
					query: {
						type: "string",
						description:
							"Optional search query or topic to focus semantic chunk extraction on",
					},
				},
				required: ["url"],
			},
			execute: async (args: { url: string; query?: string }) => {
				try {
					const result = await extractPage(args.url, config);

					if (result.markdown.length > maxChars) {
						const cacheId = setCacheEntry(result.markdown, cacheTtlMs);
						const chunks = chunkMarkdownByHeaders(result.markdown);

						if (args.query && args.query.trim().length > 0) {
							const ranked = rankChunksBM25(chunks, args.query);
							const topChunks = ranked.filter((c) => c.score > 0).slice(0, 3);

							if (topChunks.length > 0) {
								// Sort selected top chunks in original document order for natural readability
								const orderedChunks = [...topChunks].sort(
									(a, b) => a.index - b.index,
								);
								const extractedText = orderedChunks
									.map(
										(c) =>
											`${c.header.startsWith("#") ? c.header : `## ${c.header}`}\n\n${c.content}`,
									)
									.join("\n\n---\n\n");

								return (
									`--- TITLE: ${result.title} ---\n\n` +
									`[SEMANTIC EXTRACTION — Document has ${result.markdown.length.toLocaleString()} chars across ${chunks.length} sections. ` +
									`Top ${orderedChunks.length} relevant sections for "${args.query}" extracted below. ` +
									`Use search_cache with cache_id: "${cacheId}" to search the remainder.]\n\n` +
									extractedText
								);
							}
						}

						return (
							`--- TITLE: ${result.title} ---\n\n` +
							result.markdown.substring(0, maxChars) +
							`\n\n[DOCUMENT TRUNCATED — ${result.markdown.length.toLocaleString()} chars total. ` +
							`Use search_cache with cache_id: "${cacheId}" to find specific information.]`
						);
					}

					return `--- TITLE: ${result.title} ---\n\n${result.markdown}`;
				} catch (e: unknown) {
					const message = e instanceof Error ? e.message : String(e);
					return `Extraction failed: ${message}`;
				}
			},
		},
		{
			name: "search_cache",
			description:
				"Search for a keyword inside a previously fetched large document. Returns matching passages with surrounding context.",
			parameters: {
				type: "object",
				properties: {
					cache_id: {
						type: "string",
						description: "The cache_id returned by read_page_markdown",
					},
					query: {
						type: "string",
						description: "Keyword or phrase to search for in the cached document",
					},
				},
				required: ["cache_id", "query"],
			},
			execute: async (args: { cache_id: string; query: string }) => {
				const doc = getCacheEntry(args.cache_id);
				if (!doc)
					return `Error: Cache ID not found or has expired (TTL: ${cacheTtlMs / 60000} minutes).`;
				return searchWithContext(doc, args.query, cacheMaxResultLines);
			},
		},
	];
}
