import { test } from "node:test";
import assert from "node:assert";
import { validateResearchOutput } from "../src/utils.js";

// --- Happy path ---

test("validateResearchOutput - valid standard output", () => {
	const output = `
### ANSWER
The Next.js 15 migration guide states that caching defaults have changed. Previously fetch requests were cached by default; now they are uncached by default.

### CODE / COMMANDS
\`\`\`bash
npm install next@latest
\`\`\`

### SOURCES
- [Next.js Docs](https://nextjs.org/docs/app/building-your-application/upgrading/version-15)
  `;

	const result = validateResearchOutput(output);
	assert.strictEqual(result.valid, true);
	assert.strictEqual(result.isPartial, false);
	assert.strictEqual(result.reason, undefined);
});

// --- UNCERTAIN ---

test("validateResearchOutput - UNCERTAIN-only output", () => {
	const output = `
### UNCERTAIN
I could not find information about "foobar 2026 specs" on any authoritative source.
  `;

	const result = validateResearchOutput(output);
	assert.strictEqual(result.valid, true);
	assert.strictEqual(result.isPartial, true);
	assert.strictEqual(result.reason, "Agent returned UNCERTAIN");
});

test("validateResearchOutput - UNCERTAIN alongside ANSWER + SOURCES should still be valid", () => {
	// LLMs often emit all three blocks when partially confident
	const output = `
### ANSWER
React 19 includes the new \`use\` hook for async resources.

### SOURCES
- [React Blog](https://react.dev/blog/2024/04/25/react-19)

### UNCERTAIN
The exact release date for stable React 19 could not be confirmed.
  `;

	// UNCERTAIN alongside a valid answer — the response is valid but partial
	const result = validateResearchOutput(output);
	assert.strictEqual(result.valid, true);
	assert.strictEqual(result.isPartial, true);
	assert.strictEqual(result.reason, "Agent returned UNCERTAIN");
});

// --- Missing sections ---

test("validateResearchOutput - missing SOURCES", () => {
	const output = `
### ANSWER
I found the answer.
  `;

	const result = validateResearchOutput(output);
	assert.strictEqual(result.valid, false);
	assert.strictEqual(result.isPartial, true);
	assert.strictEqual(result.reason, "Missing required sections (ANSWER or SOURCES)");
});

test("validateResearchOutput - missing ANSWER", () => {
	const output = `
### SOURCES
- [Doc](http://example.com)
  `;

	const result = validateResearchOutput(output);
	assert.strictEqual(result.valid, false);
	assert.strictEqual(result.isPartial, true);
	assert.strictEqual(result.reason, "Missing required sections (ANSWER or SOURCES)");
});

// --- Fix #5: Empty section bodies ---

test("validateResearchOutput - ANSWER heading present but body is empty", () => {
	const output = `
### ANSWER

### SOURCES
- [Doc](http://example.com)
  `;

	const result = validateResearchOutput(output);
	assert.strictEqual(result.valid, false, "An empty ANSWER body should be invalid");
});

test("validateResearchOutput - SOURCES heading present but body is empty", () => {
	const output = `
### ANSWER
The answer is 42.

### SOURCES

  `;

	const result = validateResearchOutput(output);
	assert.strictEqual(result.valid, false, "An empty SOURCES body should be invalid");
});

// --- Edge cases ---

test("validateResearchOutput - empty string input", () => {
	const result = validateResearchOutput("");
	assert.strictEqual(result.valid, false);
	assert.strictEqual(result.isPartial, true);
	assert.strictEqual(result.reason, "Output is empty");
});

test("validateResearchOutput - case-sensitive heading matching (lowercase does NOT match)", () => {
	const output = `
### answer
Some content.

### sources
- [Doc](http://example.com)
  `;

	// The spec uses uppercase headings; lowercase should not satisfy the contract
	const result = validateResearchOutput(output);
	assert.strictEqual(result.valid, false);
});
