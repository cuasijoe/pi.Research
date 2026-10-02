import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getResearchTools } from "./tools/index.js";
import type { ResearchConfig } from "./config.js";
import fs from "fs";
import path from "path";
import os from "os";

function loadConfig(): ResearchConfig {
	const configPath = path.join(os.homedir(), ".pi", "research.json");
	try {
		const raw = fs.readFileSync(configPath, "utf-8");
		return JSON.parse(raw) as ResearchConfig;
	} catch {
		return {};
	}
}

export default function registerChildTools(pi: ExtensionAPI) {
	const config = loadConfig();
	const tools = getResearchTools(config);

	for (const tool of tools) {
		pi.registerTool({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as any,
			execute: async (toolCallIdOrArgs: any, maybeParams?: any) => {
				const params =
					typeof toolCallIdOrArgs === "string" && maybeParams
						? maybeParams
						: (toolCallIdOrArgs ?? {});
				const result = await tool.execute(params);
				return {
					content: [{ type: "text" as const, text: result }],
				};
			},
		} as any);
	}
}
