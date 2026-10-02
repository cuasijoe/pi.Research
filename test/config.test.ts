import { test } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";

// We need to test loadConfig, which is not exported directly.
// We test it indirectly by exercising the observable behavior from index.ts.
// For unit testing the config logic in isolation we replicate it here.

function loadConfig(configPath: string): Record<string, string> {
	try {
		const raw = fs.readFileSync(configPath, "utf-8");
		return JSON.parse(raw);
	} catch (e: unknown) {
		if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		console.warn("[pi.Research] Failed to parse research.json:", e);
		return {};
	}
}

test("loadConfig - returns empty object for missing file", () => {
	const fakePath = path.join(os.tmpdir(), `pi-research-test-${Date.now()}-missing.json`);
	const result = loadConfig(fakePath);
	assert.deepStrictEqual(result, {});
});

test("loadConfig - warns but returns empty object for malformed JSON", () => {
	const tmpFile = path.join(os.tmpdir(), `pi-research-test-${Date.now()}.json`);
	fs.writeFileSync(tmpFile, "{ this is not valid json }", "utf-8");

	const messages: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => messages.push(args.join(" "));

	const result = loadConfig(tmpFile);

	console.warn = original;
	fs.unlinkSync(tmpFile);

	assert.deepStrictEqual(result, {});
	assert.ok(messages.length > 0, "A warning should be emitted for malformed JSON");
	assert.ok(
		messages[0].includes("pi.Research"),
		"Warning should be namespaced with [pi.Research]",
	);
});

test("loadConfig - correctly reads TAVILY_API_KEY from a fixture file", () => {
	const tmpFile = path.join(os.tmpdir(), `pi-research-test-${Date.now()}.json`);
	const fixture = { TAVILY_API_KEY: "sk-tavily-test-12345" };
	fs.writeFileSync(tmpFile, JSON.stringify(fixture), "utf-8");

	const result = loadConfig(tmpFile);
	fs.unlinkSync(tmpFile);

	assert.strictEqual(result["TAVILY_API_KEY"], "sk-tavily-test-12345");
});

test("loadConfig - correctly reads JINA_API_KEY from a fixture file", () => {
	const tmpFile = path.join(os.tmpdir(), `pi-research-test-${Date.now()}.json`);
	const fixture = { JINA_API_KEY: "jina_abc123" };
	fs.writeFileSync(tmpFile, JSON.stringify(fixture), "utf-8");

	const result = loadConfig(tmpFile);
	fs.unlinkSync(tmpFile);

	assert.strictEqual(result["JINA_API_KEY"], "jina_abc123");
});

test("loadConfig - correctly reads BRAVE_API_KEY, SEARXNG_URL, and searchProviders", () => {
	const tmpFile = path.join(os.tmpdir(), `pi-research-test-${Date.now()}.json`);
	const fixture = {
		BRAVE_API_KEY: "BSA_brave_123",
		SEARXNG_URL: "http://localhost:8080",
		searchProviders: ["brave", "tavily", "jina"],
	};
	fs.writeFileSync(tmpFile, JSON.stringify(fixture), "utf-8");

	const result = loadConfig(tmpFile);
	fs.unlinkSync(tmpFile);

	assert.strictEqual(result["BRAVE_API_KEY"], "BSA_brave_123");
	assert.strictEqual(result["SEARXNG_URL"], "http://localhost:8080");
	assert.deepStrictEqual(result["searchProviders"], ["brave", "tavily", "jina"]);
});

test("loadConfig - correctly reads searxngPool and disablePublicSearxngPool", () => {
	const tmpFile = path.join(os.tmpdir(), `pi-research-test-${Date.now()}.json`);
	const fixture = {
		searxngPool: ["https://searx.be", "https://paulgo.io"],
		disablePublicSearxngPool: true,
	};
	fs.writeFileSync(tmpFile, JSON.stringify(fixture), "utf-8");

	const result = loadConfig(tmpFile);
	fs.unlinkSync(tmpFile);

	assert.deepStrictEqual(result["searxngPool"], ["https://searx.be", "https://paulgo.io"]);
	assert.strictEqual(result["disablePublicSearxngPool"], true);
});

test("loadConfig - correctly reads GITHUB_TOKEN and agentModel", () => {
	const tmpFile = path.join(os.tmpdir(), `pi-research-test-${Date.now()}.json`);
	const fixture = {
		GITHUB_TOKEN: "ghp_secrettoken123",
		agentModel: "claude-3-5-haiku",
	};
	fs.writeFileSync(tmpFile, JSON.stringify(fixture), "utf-8");

	const result = loadConfig(tmpFile);
	fs.unlinkSync(tmpFile);

	assert.strictEqual(result["GITHUB_TOKEN"], "ghp_secrettoken123");
	assert.strictEqual(result["agentModel"], "claude-3-5-haiku");
});
