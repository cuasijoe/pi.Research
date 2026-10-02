import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import type { ResearchConfig } from "../config.js";

export interface ExtractResult {
	title: string;
	markdown: string;
	source: "readability" | "jina" | "github";
}

function buildGitHubHeaders(token?: string, accept?: string): Record<string, string> {
	const headers: Record<string, string> = {
		"User-Agent": "Mozilla/5.0 (compatible; pi.Research/1.0)",
	};
	if (token) headers["Authorization"] = `Bearer ${token}`;
	if (accept) headers["Accept"] = accept;
	return headers;
}

/**
 * Native GitHub extraction to avoid heavy web UI scraping.
 * Handles blob/file URLs, issues/pulls, and repository READMEs directly.
 */
export async function extractWithGitHub(
	url: string,
	token?: string,
): Promise<ExtractResult | null> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}

	if (parsed.hostname !== "github.com" && parsed.hostname !== "raw.githubusercontent.com") {
		return null;
	}

	// 1. Raw GitHub content URL directly
	if (parsed.hostname === "raw.githubusercontent.com") {
		const res = await fetch(url, {
			headers: buildGitHubHeaders(token, "text/plain"),
		});
		if (!res.ok) return null;
		const markdown = await res.text();
		const fileName = parsed.pathname.split("/").pop() || "GitHub File";
		return {
			title: fileName,
			markdown,
			source: "github",
		};
	}

	const parts = parsed.pathname.split("/").filter(Boolean);
	if (parts.length < 2) return null;

	const [owner, repo] = parts;

	// 2. Blob / File URL: https://github.com/:owner/:repo/blob/:branch/...path
	if (parts.length >= 4 && parts[2] === "blob") {
		const branch = parts[3];
		const filePath = parts.slice(4).join("/");
		const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
		const res = await fetch(rawUrl, {
			headers: buildGitHubHeaders(token),
		});
		if (res.ok) {
			const markdown = await res.text();
			return {
				title: filePath || `${owner}/${repo}`,
				markdown,
				source: "github",
			};
		}
	}

	// 3. Issue or Pull Request: https://github.com/:owner/:repo/(issues|pull)/:id
	if (parts.length >= 4 && (parts[2] === "issues" || parts[2] === "pull")) {
		const id = parts[3];
		const apiUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${id}`;
		const res = await fetch(apiUrl, {
			headers: buildGitHubHeaders(token, "application/vnd.github.v3+json"),
		});

		if (res.ok) {
			const data = (await res.json()) as any;
			const typeLabel = parts[2] === "pull" ? "Pull Request" : "Issue";
			const title = `${typeLabel} #${data.number}: ${data.title}`;
			const metadata = `**Status:** ${data.state} | **Author:** @${data.user?.login || "unknown"} | **URL:** ${data.html_url}`;
			const body = data.body || "No description provided.";
			return {
				title: data.title || `${owner}/${repo} #${id}`,
				markdown: `# ${title}\n${metadata}\n\n${body}`,
				source: "github",
			};
		}
	}

	// 4. Repository Root: https://github.com/:owner/:repo
	if (parts.length === 2) {
		const readmeUrl = `https://api.github.com/repos/${owner}/${repo}/readme`;
		const res = await fetch(readmeUrl, {
			headers: buildGitHubHeaders(token, "application/vnd.github.raw"),
		});

		if (res.ok) {
			const markdown = await res.text();
			return {
				title: `${owner}/${repo} README`,
				markdown,
				source: "github",
			};
		}

		// Fallback: try raw HEAD README
		const headRawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`;
		const headRes = await fetch(headRawUrl, {
			headers: buildGitHubHeaders(token),
		});
		if (headRes.ok) {
			const markdown = await headRes.text();
			return {
				title: `${owner}/${repo} README`,
				markdown,
				source: "github",
			};
		}
	}

	return null;
}

export async function extractWithReadability(url: string): Promise<ExtractResult> {
	const res = await fetch(url, {
		headers: {
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
		},
	});

	if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${res.statusText}`);
	const html = await res.text();

	const dom = new JSDOM(html, { url });
	const reader = new Readability(dom.window.document);
	const article = reader.parse();

	if (!article) {
		throw new Error(
			"Readability could not parse the page — content may be empty or JS-rendered.",
		);
	}

	const turndownService = new TurndownService();
	// Observation Masking: strip images before LLM sees the content
	turndownService.remove("img");
	const markdown = turndownService.turndown(article.content);

	return {
		title: article.title,
		markdown,
		source: "readability",
	};
}

export async function extractWithJina(url: string, apiKey?: string): Promise<ExtractResult> {
	const headers: Record<string, string> = {
		"X-Retain-Images": "none", // Observation Masking: strip images server-side
		"User-Agent": "Mozilla/5.0 (compatible; pi.Research/1.0)",
	};
	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
	}

	const res = await fetch(`https://r.jina.ai/${url}`, { headers });
	if (!res.ok) throw new Error(`Jina Reader failed (${res.status}): ${res.statusText}`);
	const markdown = await res.text();

	return {
		title: url,
		markdown,
		source: "jina",
	};
}

export async function extractPage(url: string, config: ResearchConfig): Promise<ExtractResult> {
	// 1. Try Native GitHub Extraction for github.com URLs
	try {
		const ghResult = await extractWithGitHub(
			url,
			config.GITHUB_TOKEN || process.env["GITHUB_TOKEN"],
		);
		if (ghResult) return ghResult;
	} catch (e) {
		console.warn("[pi.Research] GitHub native extraction failed, falling back:", e);
	}

	// 2. Jina is tried first when API key is provided because it handles JS-rendered pages with quota
	if (config.JINA_API_KEY) {
		try {
			return await extractWithJina(url, config.JINA_API_KEY);
		} catch (e) {
			console.warn(
				"[pi.Research] Authenticated Jina extraction failed, falling back to local Readability:",
				e,
			);
		}
	}

	// 3. Try standard local Readability extraction
	try {
		return await extractWithReadability(url);
	} catch (readabilityError) {
		// 4. Cascading Fallback: If local fetch / Readability fails (e.g. 403, 429, JS-rendered, or bot challenge),
		// fall back to free-tier Jina Reader (r.jina.ai) even without an API key!
		try {
			console.warn(
				`[pi.Research] Readability extraction failed for ${url} (${readabilityError instanceof Error ? readabilityError.message : String(readabilityError)}). Falling back to Jina Reader...`,
			);
			return await extractWithJina(url, config.JINA_API_KEY);
		} catch (jinaError) {
			throw new Error(
				`Page extraction failed across all providers for ${url}:\n` +
					`  - Readability: ${readabilityError instanceof Error ? readabilityError.message : String(readabilityError)}\n` +
					`  - Jina Reader: ${jinaError instanceof Error ? jinaError.message : String(jinaError)}`,
			);
		}
	}
}
