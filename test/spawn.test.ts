import { test } from "node:test";
import assert from "node:assert";
import { spawnResearchAgent } from "../src/spawn.js";

test("spawnResearchAgent - forwards agentModel to agentOptions when configured", async () => {
	let capturedOptions: any = null;

	const mockPi: any = {
		spawnAgent: async (options: any) => {
			capturedOptions = options;
			return {
				content:
					"### ANSWER\nSynthesized answer.\n\n### SOURCES\n- [Doc](https://example.com)",
			};
		},
	};

	const output = await spawnResearchAgent(mockPi, "how to use react", {
		agentModel: "gpt-4o-mini",
		agentTemperature: 0.2,
	});

	assert.ok(output.includes("### ANSWER"));
	assert.ok(capturedOptions, "spawnAgent should have been called");
	assert.strictEqual(capturedOptions.model, "gpt-4o-mini");
	assert.strictEqual(capturedOptions.temperature, 0.2);
	assert.strictEqual(capturedOptions.messages[0].role, "user");
	assert.ok(capturedOptions.messages[0].content.includes("how to use react"));
});

test("spawnResearchAgent - omits model from agentOptions when agentModel is undefined", async () => {
	let capturedOptions: any = null;

	const mockPi: any = {
		spawnAgent: async (options: any) => {
			capturedOptions = options;
			return {
				content:
					"### ANSWER\nSynthesized answer.\n\n### SOURCES\n- [Doc](https://example.com)",
			};
		},
	};

	await spawnResearchAgent(mockPi, "test query", {});

	assert.ok(capturedOptions);
	assert.strictEqual(capturedOptions.model, undefined);
});

test("spawnResearchAgent - returns UNCERTAIN on timeout", async () => {
	let pendingTimer: NodeJS.Timeout | undefined;
	const mockPi: any = {
		spawnAgent: async () => {
			await new Promise((resolve) => {
				pendingTimer = setTimeout(resolve, 80);
			});
			return { content: "Too late" };
		},
	};

	try {
		const output = await spawnResearchAgent(mockPi, "query", {
			agentTimeoutMs: 20, // 20ms timeout
		});

		assert.ok(output.includes("### UNCERTAIN"));
		assert.ok(output.includes("timed out"));
	} finally {
		if (pendingTimer) clearTimeout(pendingTimer);
	}
});
