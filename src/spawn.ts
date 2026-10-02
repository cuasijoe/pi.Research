import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getResearchTools } from "./tools/index.js";
import type { ResearchConfig } from "./config.js";
import { DEFAULTS } from "./config.js";
import { spawn as childSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface AgentOptions {
	systemPrompt: string;
	tools: unknown[];
	messages: Array<{
		role: string;
		content: string;
	}>;
	model?: string;
	temperature?: number;
	maxTokens?: number;
}

const SYSTEM_PROMPT = `You are a research distillation agent. You do not write code for the user. You find answers, summarize them, and provide citations.

If a search fails, try a different query. If two queries fail, return UNCERTAIN.

MANDATORY OUTPUT FORMAT:
You must terminate by returning text strictly adhering to this structure:

### ANSWER
<A concise, 3-5 sentence synthesis of the answer.>

### CODE / COMMANDS
<Any relevant code snippets, API signatures, or shell commands found. Omit this section if inapplicable.>

### SOURCES
- [Title](URL)
- [Title](URL)

### UNCERTAIN
<State anything explicitly asked that could not be reliably found. Omit if inapplicable.>
`;

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

interface ChildMessage {
	role: string;
	content: Array<{
		type: string;
		text?: string;
		name?: string;
		arguments?: unknown;
	}>;
	errorMessage?: string;
}

function getFinalOutput(messages: ChildMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const texts = msg.content
				.filter((part) => part.type === "text" && part.text)
				.map((part) => part.text);
			if (texts.length > 0) return texts.join("\n\n");
		}
	}
	return "";
}

async function spawnChildProcess(
	query: string,
	config: ResearchConfig,
	signal?: AbortSignal,
	onUpdate?: (text: string) => void,
): Promise<string> {
	const currentDir = path.dirname(fileURLToPath(import.meta.url));
	let childToolsPath = path.join(currentDir, "child-tools.ts");
	if (!fs.existsSync(childToolsPath)) {
		childToolsPath = path.join(currentDir, "child-tools.js");
	}

	const args: string[] = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"-e",
		childToolsPath,
		"--tools",
		"search_web,read_page_markdown,search_cache",
	];

	if (config.agentModel) {
		args.push("--model", config.agentModel);
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let proc: ReturnType<typeof childSpawn> | undefined;
	let timer: NodeJS.Timeout | undefined;
	let killTimer: NodeJS.Timeout | undefined;
	let aborted = false;

	const messages: ChildMessage[] = [];
	const stderrParts: string[] = [];
	let childError: string | undefined;

	const killGroup = (sig: NodeJS.Signals) => {
		if (proc?.pid) {
			try {
				process.kill(-proc.pid, sig);
			} catch {
				try {
					process.kill(proc.pid, sig);
				} catch {
					/* already dead */
				}
			}
		}
	};

	const killSoft = () => {
		killGroup("SIGTERM");
		if (!killTimer) {
			killTimer = setTimeout(() => killGroup("SIGKILL"), 5000);
			killTimer.unref?.();
		}
	};

	try {
		tmpPromptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-research-"));
		tmpPromptPath = path.join(tmpPromptDir, "system-prompt.md");
		fs.writeFileSync(tmpPromptPath, SYSTEM_PROMPT, {
			encoding: "utf-8",
			mode: 0o600,
		});
		args.push("--append-system-prompt", tmpPromptPath);
		args.push("--", `Please research the following query and provide a synthesis:\n\n${query}`);

		const invocation = getPiInvocation(args);
		const child = childSpawn(invocation.command, invocation.args, {
			cwd: process.cwd(),
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				CI: "1",
				TERM: "dumb",
				FORCE_COLOR: "0",
				NO_COLOR: "1",
			},
		});
		proc = child;

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (!event || typeof event.type !== "string") return;

			if (event.type === "tool_execution_start" && event.toolName) {
				const argsStr = event.args ? JSON.stringify(event.args).slice(0, 80) : "";
				onUpdate?.(`→ [research] ${event.toolName} ${argsStr}`);
			}
			if (event.type === "tool_execution_end" && event.toolName) {
				onUpdate?.(`→ [research] ${event.toolName} done${event.isError ? " (error)" : ""}`);
			}
			if (event.type === "message_end" && event.message) {
				const msg = event.message as ChildMessage;
				messages.push(msg);
				if (msg.role === "assistant" && msg.errorMessage) {
					childError = msg.errorMessage;
				}
			}
		};

		let buffer = "";
		child.stdout!.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});

		child.stderr!.on("data", (data) => {
			stderrParts.push(data.toString());
		});

		const timeoutMs = config.agentTimeoutMs ?? DEFAULTS.agentTimeoutMs;
		timer = setTimeout(() => {
			killSoft();
		}, timeoutMs);
		timer.unref?.();

		const onAbort = () => {
			aborted = true;
			killSoft();
		};
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		const onSigTerm = () => {
			aborted = true;
			killGroup("SIGTERM");
			setTimeout(() => killGroup("SIGKILL"), 1000);
		};
		process.prependListener("SIGTERM", onSigTerm);
		process.prependListener("SIGHUP", onSigTerm);

		const exitCode = await new Promise<number>((resolve) => {
			child.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				clearTimeout(timer);
				clearTimeout(killTimer);
				if (signal) signal.removeEventListener("abort", onAbort);
				process.removeListener("SIGTERM", onSigTerm);
				process.removeListener("SIGHUP", onSigTerm);
				resolve(code ?? 0);
			});
			child.on("error", () => {
				clearTimeout(timer);
				clearTimeout(killTimer);
				if (signal) signal.removeEventListener("abort", onAbort);
				process.removeListener("SIGTERM", onSigTerm);
				process.removeListener("SIGHUP", onSigTerm);
				resolve(1);
			});
		});

		let text = getFinalOutput(messages);
		if (!text && aborted) {
			return `### UNCERTAIN\nSubagent execution was aborted.`;
		}
		if (!text) {
			const stderrTail = stderrParts.join("").trim().slice(-2000);
			const err = childError || stderrTail || `Child process exited with code ${exitCode}`;
			return `### UNCERTAIN\nSubagent failed: ${err}`;
		}

		return text;
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		}
	}
}

export async function spawnResearchAgent(
	pi: ExtensionAPI,
	query: string,
	config: ResearchConfig,
	signal?: AbortSignal,
	onUpdate?: (text: string) => void,
): Promise<string> {
	// If running in a test harness with mock spawnAgent
	if (typeof (pi as any).spawnAgent === "function") {
		const tools = getResearchTools(config);

		const agentOptions: AgentOptions = {
			systemPrompt: SYSTEM_PROMPT,
			tools: tools,
			messages: [
				{
					role: "user",
					content: `Please research the following query and provide a synthesis:\n\n${query}`,
				},
			],
			...(config.agentModel ? { model: config.agentModel } : {}),
			temperature: config.agentTemperature ?? DEFAULTS.agentTemperature,
			maxTokens: config.agentMaxTokens ?? DEFAULTS.agentMaxTokens,
		};

		const timeoutMs = config.agentTimeoutMs ?? DEFAULTS.agentTimeoutMs;
		let timer: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`Research agent timed out after ${timeoutMs / 1000}s`)),
				timeoutMs,
			);
		});

		try {
			const response = await Promise.race([
				(pi as any).spawnAgent(agentOptions) as Promise<{ content: string }>,
				timeoutPromise,
			]);
			return response.content;
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			return `### UNCERTAIN\nSubagent failed: ${message}`;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	// Live Pi execution: spawn isolated child process
	return spawnChildProcess(query, config, signal, onUpdate);
}
