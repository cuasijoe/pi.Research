import { test } from "node:test";
import assert from "node:assert";
import {
	extractPage,
	extractWithGitHub,
	extractWithJina,
	extractWithReadability,
} from "../../src/providers/extract.js";

// --- extractWithGitHub ---

test("extractWithGitHub - returns null for non-github URLs", async () => {
	const result = await extractWithGitHub("https://example.com/some/article");
	assert.strictEqual(result, null);
});

test("extractWithGitHub - extracts raw.githubusercontent.com URLs directly", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const urlStr = String(input);
			assert.strictEqual(urlStr, "https://raw.githubusercontent.com/owner/repo/main/doc.md");
			return {
				ok: true,
				status: 200,
				text: async () => "# Direct Raw Markdown\nContent here.",
			} as unknown as Response;
		}) as any;

		const result = await extractWithGitHub(
			"https://raw.githubusercontent.com/owner/repo/main/doc.md",
		);
		assert.ok(result);
		assert.strictEqual(result.source, "github");
		assert.strictEqual(result.title, "doc.md");
		assert.ok(result.markdown.includes("Direct Raw Markdown"));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("extractWithGitHub - converts github.com blob URLs to raw content", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(input);
			assert.strictEqual(
				urlStr,
				"https://raw.githubusercontent.com/facebook/react/main/packages/react/README.md",
			);
			const headers = (init?.headers || {}) as Record<string, string>;
			assert.strictEqual(headers["Authorization"], "Bearer test-gh-token");

			return {
				ok: true,
				status: 200,
				text: async () => "# React Package\nDocumentation content.",
			} as unknown as Response;
		}) as any;

		const result = await extractWithGitHub(
			"https://github.com/facebook/react/blob/main/packages/react/README.md",
			"test-gh-token",
		);
		assert.ok(result);
		assert.strictEqual(result.source, "github");
		assert.strictEqual(result.title, "packages/react/README.md");
		assert.ok(result.markdown.includes("Documentation content."));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("extractWithGitHub - extracts issue details via GitHub API", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const urlStr = String(input);
			assert.strictEqual(urlStr, "https://api.github.com/repos/nodejs/node/issues/50000");

			return {
				ok: true,
				status: 200,
				json: async () => ({
					number: 50000,
					title: "Memory leak in stream pipeline",
					state: "open",
					html_url: "https://github.com/nodejs/node/issues/50000",
					user: { login: "testdev" },
					body: "Steps to reproduce: stream.pipeline with large buffers...",
				}),
			} as unknown as Response;
		}) as any;

		const result = await extractWithGitHub("https://github.com/nodejs/node/issues/50000");
		assert.ok(result);
		assert.strictEqual(result.source, "github");
		assert.strictEqual(result.title, "Memory leak in stream pipeline");
		assert.ok(result.markdown.includes("# Issue #50000: Memory leak in stream pipeline"));
		assert.ok(result.markdown.includes("**Status:** open"));
		assert.ok(result.markdown.includes("@testdev"));
		assert.ok(result.markdown.includes("Steps to reproduce"));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("extractWithGitHub - extracts PR details via GitHub API", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const urlStr = String(input);
			assert.strictEqual(urlStr, "https://api.github.com/repos/nodejs/node/issues/50123");

			return {
				ok: true,
				status: 200,
				json: async () => ({
					number: 50123,
					title: "Fix stream buffer leak",
					state: "closed",
					html_url: "https://github.com/nodejs/node/pull/50123",
					user: { login: "core-dev" },
					body: "This PR closes #50000 by clearing buffers on finish.",
				}),
			} as unknown as Response;
		}) as any;

		const result = await extractWithGitHub("https://github.com/nodejs/node/pull/50123");
		assert.ok(result);
		assert.strictEqual(result.source, "github");
		assert.ok(result.markdown.includes("# Pull Request #50123: Fix stream buffer leak"));
		assert.ok(result.markdown.includes("**Status:** closed"));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("extractWithGitHub - extracts repo root README", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const urlStr = String(input);
			assert.strictEqual(
				urlStr,
				"https://api.github.com/repos/earendil-works/pi-research/readme",
			);

			return {
				ok: true,
				status: 200,
				text: async () => "# pi.Research\nRepository README content.",
			} as unknown as Response;
		}) as any;

		const result = await extractWithGitHub("https://github.com/earendil-works/pi-research");
		assert.ok(result);
		assert.strictEqual(result.source, "github");
		assert.strictEqual(result.title, "earendil-works/pi-research README");
		assert.ok(result.markdown.includes("Repository README content."));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("extractWithGitHub - returns null on fetch failure to allow fallback", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async () => {
			return { ok: false, status: 404 } as unknown as Response;
		}) as any;

		const result = await extractWithGitHub(
			"https://github.com/owner/nonexistent/blob/main/doc.md",
		);
		assert.strictEqual(result, null);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

// --- extractWithJina ---

test("extractWithJina - fetches via r.jina.ai with image stripping", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(input);
			assert.strictEqual(urlStr, "https://r.jina.ai/https://example.com/page");
			const headers = (init?.headers || {}) as Record<string, string>;
			assert.strictEqual(headers["X-Retain-Images"], "none");
			assert.strictEqual(headers["Authorization"], "Bearer my-jina-key");

			return {
				ok: true,
				status: 200,
				text: async () => "# Jina Extracted Content\nClean page text.",
			} as unknown as Response;
		}) as any;

		const result = await extractWithJina("https://example.com/page", "my-jina-key");
		assert.strictEqual(result.source, "jina");
		assert.ok(result.markdown.includes("Jina Extracted Content"));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("extractWithJina - works without API key for free public tier", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const headers = (init?.headers || {}) as Record<string, string>;
			assert.strictEqual(headers["Authorization"], undefined);

			return {
				ok: true,
				status: 200,
				text: async () => "# Free Tier Jina Content",
			} as unknown as Response;
		}) as any;

		const result = await extractWithJina("https://example.com/page");
		assert.strictEqual(result.source, "jina");
		assert.ok(result.markdown.includes("Free Tier Jina Content"));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

// --- extractPage cascading flow ---

test("extractPage - intercepts github.com URLs natively", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const urlStr = String(input);
			if (urlStr.includes("api.github.com")) {
				return {
					ok: true,
					status: 200,
					text: async () => "# Native GitHub Readme",
				} as unknown as Response;
			}
			return { ok: false, status: 500 } as unknown as Response;
		}) as any;

		const result = await extractPage("https://github.com/org/repo", {});
		assert.strictEqual(result.source, "github");
		assert.ok(result.markdown.includes("Native GitHub Readme"));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("extractPage - falls back to free Jina Reader when Readability fetch fails with 403", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const urlStr = String(input);
			// Local fetch to example.com is blocked by Cloudflare (403)
			if (urlStr === "https://cloudflare-protected.com") {
				return {
					ok: false,
					status: 403,
					statusText: "Forbidden",
				} as unknown as Response;
			}
			// Cascading fallback to r.jina.ai succeeds
			if (urlStr.startsWith("https://r.jina.ai/")) {
				return {
					ok: true,
					status: 200,
					text: async () =>
						"# Bypassed via Jina Reader\nProtected content read successfully.",
				} as unknown as Response;
			}
			return { ok: false, status: 500 } as unknown as Response;
		}) as any;

		const result = await extractPage("https://cloudflare-protected.com", {});
		assert.strictEqual(result.source, "jina");
		assert.ok(result.markdown.includes("Bypassed via Jina Reader"));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("extractPage - throws composite error when both Readability and Jina Reader fail", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async () => {
			return {
				ok: false,
				status: 500,
				statusText: "Internal Server Error",
			} as unknown as Response;
		}) as any;

		await assert.rejects(
			async () => {
				await extractPage("https://completely-broken.com", {});
			},
			(err: Error) => {
				assert.ok(err.message.includes("Page extraction failed across all providers"));
				assert.ok(err.message.includes("Readability"));
				assert.ok(err.message.includes("Jina Reader"));
				return true;
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
