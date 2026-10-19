/**
 * Agent adapters — run one participant turn on a supported agent CLI
 * (pi, Claude Code, Codex) and hide how each one differs: flags, how sessions
 * are created and resumed, read-only and web-search settings, and the shape of
 * its JSON event stream.
 *
 * Callers see one operation, runTurn(): give it the participant's settings,
 * its fixed instructions and this turn's message; get back the reply and the
 * session id to pass next time.
 */

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type AgentId = "pi" | "claude" | "codex";
export const AGENT_IDS: readonly AgentId[] = ["pi", "claude", "codex"];

export interface AgentInfo {
	id: AgentId;
	label: string;
	defaultModel: string;
	defaultThinking: string;
	/** Can this agent search the web (used for role participants)? */
	webSearch: boolean;
	/** Does this agent report a dollar cost? (Codex on a ChatGPT plan reports tokens only.) */
	reportsCost: boolean;
}

export const AGENTS: Record<AgentId, AgentInfo> = {
	pi: { id: "pi", label: "pi", defaultModel: "anthropic/claude-opus-5-5", defaultThinking: "xhigh", webSearch: false, reportsCost: true },
	claude: { id: "claude", label: "Claude Code", defaultModel: "opus", defaultThinking: "xhigh", webSearch: true, reportsCost: true },
	codex: { id: "codex", label: "Codex", defaultModel: "gpt-5.6-terra", defaultThinking: "xhigh", webSearch: true, reportsCost: false },
};

export function isAgentId(value: unknown): value is AgentId {
	return typeof value === "string" && (AGENT_IDS as readonly string[]).includes(value);
}

/** "Claude Code · opus · xhigh" */
export function agentSummary(s: { agent: AgentId; model: string; thinking: string }): string {
	return `${AGENTS[s.agent].label} · ${s.model} · ${s.thinking}`;
}

/** Is the agent's CLI available? pi is always available (it runs this extension). */
export function isAgentInstalled(id: AgentId): boolean {
	if (id === "pi") return true;
	return (process.env.PATH ?? "").split(path.delimiter).some((dir) => {
		try {
			fs.accessSync(path.join(dir, id), fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

interface CodexModel {
	slug: string;
	visibility?: string;
	supported_reasoning_levels?: Array<{ effort: string } | string>;
}

function codexModels(): CodexModel[] {
	try {
		const cache = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codex", "models_cache.json"), "utf8"));
		return Array.isArray(cache.models) ? cache.models : [];
	} catch {
		return [];
	}
}

/**
 * Models to offer for an agent, default first. For pi, pass the session's
 * model registry. The user can always type a model that isn't listed.
 */
export function suggestedModels(id: AgentId, piRegistry?: { getAvailable(): Array<{ provider: string; id: string }> }): string[] {
	let models: string[] = [];
	if (id === "pi") {
		try {
			models = piRegistry?.getAvailable().map((m) => `${m.provider}/${m.id}`) ?? [];
		} catch {
			// fall back to the default only
		}
	} else if (id === "claude") {
		models = ["opus", "sonnet", "fable", "haiku"];
	} else {
		models = codexModels().filter((m) => m.visibility !== "hide").map((m) => m.slug);
	}
	return [...new Set([AGENTS[id].defaultModel, ...models])];
}

/** Thinking / effort levels the agent accepts for `model`, default first. */
export function thinkingLevels(id: AgentId, model: string): string[] {
	let levels: string[] = {
		pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		claude: ["low", "medium", "high", "xhigh", "max"],
		codex: ["low", "medium", "high", "xhigh", "max"],
	}[id];
	if (id === "codex") {
		const supported = codexModels().find((m) => m.slug === model)?.supported_reasoning_levels;
		if (supported?.length) levels = supported.map((l) => (typeof l === "string" ? l : l.effort));
	}
	const def = AGENTS[id].defaultThinking;
	return levels.includes(def) ? [def, ...levels.filter((l) => l !== def)] : levels;
}

// ---------------------------------------------------------------------------
// Running a turn
// ---------------------------------------------------------------------------

export interface TurnRequest {
	agent: AgentId;
	cwd: string;
	/** Session to resume; undefined starts a new one. */
	sessionId?: string;
	model: string;
	thinking: string;
	/** Fixed participant instructions (system-level), the same on every turn. */
	instructions: string;
	message: string;
	webSearch: boolean;
}

export interface TurnOutcome {
	reply: string;
	/** Pass this as `sessionId` on the participant's next turn. */
	sessionId: string;
	/** 0 when the agent doesn't report cost (see AgentInfo.reportsCost). */
	costUsd: number;
	tokens: number;
}

/** What an adapter accumulates while reading the CLI's JSON events. */
interface TurnState {
	reply: string;
	sessionId?: string;
	costUsd: number;
	tokens: number;
	error?: string;
	/** Report tools the agent is using, for progress display. */
	usedTools(names: string[]): void;
}

interface Adapter {
	/** The process to start. `sessionId` is returned when the adapter picks it up front. */
	invocation(req: TurnRequest): { command: string; args: string[]; stdin?: string; sessionId?: string };
	/** Fold one parsed JSON line from stdout into the turn state. */
	onEvent(event: any, turn: TurnState): void;
}

/** Same pi binary/runtime as the current process, so participants run the same pi version. */
function piCommand(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

const pi: Adapter = {
	invocation(req) {
		const sessionId = req.sessionId ?? crypto.randomUUID();
		const args = [
			"--mode", "json", "-p",
			"--session-id", sessionId,
			"--model", req.model,
			"--thinking", req.thinking,
			"--tools", "read,grep,find,ls",
			"--append-system-prompt", req.instructions,
			"--", req.message,
		];
		return { ...piCommand(args), sessionId };
	},
	onEvent(event, turn) {
		if (event.type !== "message_end" || event.message?.role !== "assistant") return;
		const msg = event.message;
		turn.costUsd += msg.usage?.cost?.total ?? 0;
		turn.tokens += msg.usage?.totalTokens ?? 0;
		if (msg.errorMessage) turn.error = msg.errorMessage;
		const parts: any[] = Array.isArray(msg.content) ? msg.content : [];
		const text = parts.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
		if (text) turn.reply = text;
		turn.usedTools(parts.filter((c) => c.type === "toolCall").map((c) => c.name));
	},
};

const claude: Adapter = {
	invocation(req) {
		const tools = ["Read", "Grep", "Glob", ...(req.webSearch ? ["WebSearch", "WebFetch"] : [])].join(",");
		const sessionId = req.sessionId ?? crypto.randomUUID();
		const args = [
			"-p",
			"--output-format", "stream-json", "--verbose",
			...(req.sessionId ? ["--resume", sessionId] : ["--session-id", sessionId]),
			"--model", req.model,
			"--effort", req.thinking,
			"--tools", tools,
			"--allowed-tools", tools,
			"--strict-mcp-config",
			"--append-system-prompt", req.instructions,
		];
		return { command: "claude", args, stdin: req.message, sessionId };
	},
	onEvent(event, turn) {
		if (event.type === "assistant") {
			const parts: any[] = Array.isArray(event.message?.content) ? event.message.content : [];
			turn.usedTools(parts.filter((c) => c.type === "tool_use").map((c) => c.name));
		} else if (event.type === "result") {
			const u = event.usage ?? {};
			turn.tokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
			turn.costUsd += event.total_cost_usd ?? 0;
			if (event.session_id) turn.sessionId = event.session_id;
			if (event.is_error) turn.error = String(event.result ?? event.subtype ?? "Claude Code reported an error");
			else turn.reply = String(event.result ?? "").trim();
		}
	},
};

/** Codex `-c key=value` takes TOML values; a JSON string is a valid TOML basic string. */
const toml = (s: string) => JSON.stringify(s);

const codex: Adapter = {
	invocation(req) {
		const settings = [
			"-c", `model_reasoning_effort=${toml(req.thinking)}`,
			"-c", `sandbox_mode=${toml("read-only")}`,
			"-c", `approval_policy=${toml("never")}`,
			"-c", `web_search=${toml(req.webSearch ? "live" : "disabled")}`,
		];
		// Codex has no "append to system prompt" flag. Developer instructions given when the
		// session is created stay with it (they are ignored on resume), so send them only then.
		const args = req.sessionId
			? ["exec", "resume", req.sessionId, "--json", "--skip-git-repo-check", "-m", req.model, ...settings, "-"]
			: ["exec", "--json", "--skip-git-repo-check", "-m", req.model, ...settings, "-c", `developer_instructions=${toml(req.instructions)}`, "-"];
		return { command: "codex", args, stdin: req.message, sessionId: req.sessionId };
	},
	onEvent(event, turn) {
		if (event.type === "thread.started" && event.thread_id) turn.sessionId = event.thread_id;
		else if (event.type === "item.started" && event.item?.type && event.item.type !== "agent_message" && event.item.type !== "reasoning") {
			turn.usedTools([event.item.type]);
		} else if (event.type === "item.completed" && event.item?.type === "agent_message") {
			// Codex may post interim messages ("I'll check X…"); the last one is the reply.
			const text = String(event.item.text ?? "").trim();
			if (text) turn.reply = text;
		} else if (event.type === "turn.completed") {
			turn.tokens += (event.usage?.input_tokens ?? 0) + (event.usage?.output_tokens ?? 0);
		} else if (event.type === "turn.failed") {
			turn.error = extractCodexError(event.error?.message);
		}
	},
};

/** Codex wraps API errors as JSON inside the message string; surface the readable part. */
function extractCodexError(message: unknown): string {
	const text = String(message ?? "Codex turn failed");
	try {
		return JSON.parse(text)?.error?.message ?? text;
	} catch {
		return text;
	}
}

const ADAPTERS: Record<AgentId, Adapter> = { pi, claude, codex };

/**
 * Run one turn and return the participant's final reply.
 * Throws if the agent fails, is aborted, or produces no reply.
 * `onProgress` receives short status lines (e.g. tools being used).
 */
export function runTurn(req: TurnRequest, signal?: AbortSignal, onProgress?: (status: string) => void): Promise<TurnOutcome> {
	const adapter = ADAPTERS[req.agent];
	const { command, args, stdin, sessionId } = adapter.invocation(req);
	let toolCalls = 0;
	const turn: TurnState = {
		reply: "",
		sessionId,
		costUsd: 0,
		tokens: 0,
		usedTools(names) {
			if (!names.length) return;
			toolCalls += names.length;
			onProgress?.(`using ${names.join(", ")} (${toolCalls} tool calls so far)`);
		},
	};

	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, { cwd: req.cwd, shell: false, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		let buffer = "";
		let stderr = "";
		let aborted = false;
		let settled = false;
		const finish = (fn: () => void) => {
			if (!settled) {
				settled = true;
				fn();
			}
		};

		const onLine = (line: string) => {
			if (!line.trim().startsWith("{")) return; // CLIs may print non-JSON warnings
			try {
				adapter.onEvent(JSON.parse(line), turn);
			} catch {
				// ignore malformed lines
			}
		};

		if (stdin !== undefined) proc.stdin?.end(stdin);
		proc.stdout?.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) onLine(line);
		});
		proc.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
		proc.on("error", (err) =>
			finish(() => reject(new Error(`Could not start ${AGENTS[req.agent].label} (${command}): ${err.message}`))),
		);
		proc.on("close", (code) => {
			if (buffer.trim()) onLine(buffer);
			finish(() => {
				const label = AGENTS[req.agent].label;
				if (aborted) return reject(new Error("Participant turn was aborted"));
				if (turn.error) return reject(new Error(`${label}: ${turn.error}`));
				if (code !== 0) return reject(new Error(`${label} exited with code ${code}: ${stderr.trim().slice(-2000)}`));
				if (!turn.reply) return reject(new Error(`${label} produced no reply`));
				if (!turn.sessionId) return reject(new Error(`${label} did not report a session id`));
				resolve({ reply: turn.reply, sessionId: turn.sessionId, costUsd: turn.costUsd, tokens: turn.tokens });
			});
		});

		if (signal) {
			const kill = () => {
				aborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => proc.exitCode === null && proc.kill("SIGKILL"), 5000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}
