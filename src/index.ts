import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnResearchAgent } from "./spawn.js";
import { validateResearchOutput } from "./utils.js";
import type { ResearchConfig } from "./config.js";
import fs from "fs";
import path from "path";
import os from "os";

// Fix #8: Distinguish between "file not found" and "parse error"
function loadConfig(): ResearchConfig {
	const configPath = path.join(os.homedir(), ".pi", "research.json");
	try {
		const raw = fs.readFileSync(configPath, "utf-8");
		return JSON.parse(raw) as ResearchConfig;
	} catch (e: unknown) {
		// ENOENT is expected — the user simply hasn't configured a key yet
		if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		// Any other error (e.g. SyntaxError) should be loud, not silent
		console.warn("[pi.Research] Failed to parse ~/.pi/research.json:", e);
		return {};
	}
}

export default function registerExtension(pi: ExtensionAPI) {
	const config = loadConfig();

	pi.registerTool({
		name: "research",
		description:
			"Spawns a sandboxed subagent to perform web research. Use this to find documentation, error explanations, or API references. It operates in isolation and returns a distilled markdown response (ANSWER + SOURCES).",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "The research query to investigate",
				},
			},
			required: ["query"],
		},
		execute: async (
			toolCallIdOrArgs: any,
			maybeParams?: any,
			signal?: AbortSignal,
			onUpdate?: (partial: any) => void,
		) => {
			let query = "";
			let actualSignal = signal;
			let actualOnUpdate = onUpdate;

			if (typeof toolCallIdOrArgs === "string") {
				query = maybeParams?.query ?? "";
			} else if (toolCallIdOrArgs && typeof toolCallIdOrArgs === "object") {
				query = toolCallIdOrArgs.query ?? "";
				if (maybeParams && typeof maybeParams.addEventListener === "function") {
					actualSignal = maybeParams;
				}
				if (typeof signal === "function") {
					actualOnUpdate = signal as any;
				}
			}

			const onProgress = (update: any) => {
				if (typeof actualOnUpdate === "function") {
					try {
						const text =
							typeof update === "string"
								? update
								: (update?.content?.[0]?.text ?? String(update ?? ""));
						actualOnUpdate({
							content: [{ type: "text" as const, text }],
						});
					} catch {
						/* ignore */
					}
				}
			};

			const rawOutput = await spawnResearchAgent(pi, query, config, actualSignal, onProgress);

			const validation = validateResearchOutput(rawOutput);
			const telemetry = (pi as any).telemetry;
			if (!validation.valid) {
				telemetry?.track("research_failed", {
					query,
					reason: validation.reason,
				});
			} else if (validation.isPartial) {
				telemetry?.track("research_partial", {
					query,
					reason: validation.reason,
				});
			} else {
				telemetry?.track("research_success", { query });
			}

			return {
				content: [{ type: "text" as const, text: rawOutput }],
			};
		},
	} as any);
}
