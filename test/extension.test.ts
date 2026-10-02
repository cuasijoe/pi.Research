import { test } from "node:test";
import assert from "node:assert";
import registerExtension from "../src/index.js";

test("registerExtension - registers research tool with safe onUpdate wrapper", async () => {
	let registeredTool: any = null;
	const mockPi: any = {
		registerTool: (tool: any) => {
			registeredTool = tool;
		},
		spawnAgent: async (options: any) => {
			return {
				content: "### ANSWER\nTest answer\n\n### SOURCES\n- [Test](https://example.com)",
			};
		},
	};

	registerExtension(mockPi);
	assert.ok(registeredTool, "tool should be registered");
	assert.strictEqual(registeredTool.name, "research");

	// Test calling execute with onUpdate callback
	const updates: any[] = [];
	const mockOnUpdate = (partialResult: any) => {
		updates.push(partialResult);
		// Simulate Pi TUI getTextOutput behavior
		assert.ok(
			Array.isArray(partialResult.content),
			"partialResult.content must be an array to prevent Pi filter crash",
		);
		assert.strictEqual(partialResult.content[0].type, "text");
	};

	const result = await registeredTool.execute(
		"call_123",
		{ query: "test query" },
		undefined,
		mockOnUpdate,
	);

	assert.ok(result);
	assert.ok(Array.isArray(result.content));
	assert.strictEqual(result.content[0].type, "text");
	assert.ok(result.content[0].text.includes("### ANSWER"));
});
