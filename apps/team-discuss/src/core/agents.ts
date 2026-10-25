/**
 * Agent adapters: run one turn of a seat on an agent CLI (pi, Claude Code or
 * Codex) and hide how each one differs: flags, how sessions are created and
 * resumed, the limits each kind of seat runs under, and the shape of the CLI's
 * JSON event stream. Also decides which agent may take which kind of seat.
 *
 * Callers see one operation, runTurn(): give it the seat's settings, its fixed
 * instructions and this turn's message; get back the reply and the session id
 * to pass next time.
 *
 * Ported from packages/discuss/src/agents.ts (8a774fc). Differences:
 * - pi is started from PATH, not by re-running the current process.
 * - Every turn runs under its seat kind's limits (DESIGN.md §6.1).
 * - The message goes to the CLI on stdin: Linux caps a single argument at
 *   128 KB, and a long discussion is bigger than that.
 */

import { execFile, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type AgentId = "pi" | "claude" | "codex";
export const AGENT_IDS: readonly AgentId[] = ["pi", "claude", "codex"];

/**
 * What a seat may do. Participants read but never change anything and can't
 * reach MCP servers; the moderator has no tools at all.
 */
export type SeatKind = "participant" | "moderator";

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

// ---------------------------------------------------------------------------
// Which agent may take which seat
// ---------------------------------------------------------------------------

/**
 * For each agent and seat kind: true if the agent may take that seat, or why
 * not (DESIGN.md §6.1). True means the seat's limits are enforced by the flags
 * in the adapters below. The limits are applied on every turn regardless; this
 * table only decides what is offered.
 */
const SEATS: Record<AgentId, Record<SeatKind, true | string>> = {
	pi: { participant: true, moderator: true },
	claude: { participant: true, moderator: true },
	codex: {
		participant: "Codex's read-only limits for participants aren't verified yet",
		moderator: "Codex can't be the moderator: it has no mode without tools",
	},
};

/** The command that starts an agent's CLI. pi's can be overridden with TEAM_DISCUSS_PI_BIN. */
function commandOf(id: AgentId): string {
	return id === "pi" ? process.env.TEAM_DISCUSS_PI_BIN || "pi" : id;
}

/** Is the agent's CLI on PATH (or, for a TEAM_DISCUSS_PI_BIN path, at that path)? */
export function isAgentInstalled(id: AgentId): boolean {
	const command = commandOf(id);
	const candidates = command.includes(path.sep)
		? [path.resolve(command)]
		: (process.env.PATH ?? "")
				.split(path.delimiter)
				.filter(Boolean)
				.map((dir) => path.join(dir, command));
	return candidates.some(isExecutableFile);
}

function isExecutableFile(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/**
 * Why `id` can't take a `kind` seat on this machine, or undefined if it can.
 * Setup offers only agents without a reason, and a discussion asks again
 * before every turn, because the machine may have changed since setup.
 */
export async function unavailableReason(id: AgentId, kind: SeatKind): Promise<string | undefined> {
	const policy = SEATS[id][kind];
	if (policy !== true) return policy;
	if (!isAgentInstalled(id)) return `${AGENTS[id].label} isn't installed: \`${commandOf(id)}\` wasn't found on PATH`;
	if (id === "codex") {
		try {
			await codexFeatures();
		} catch (err) {
			return `Codex's limits can't be applied: ${errorMessage(err)}`;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Models and thinking levels
// ---------------------------------------------------------------------------

/** Models to offer for an agent, default first. The user can always type a model that isn't listed. */
export async function suggestedModels(id: AgentId): Promise<string[]> {
	let models: string[];
	if (id === "pi") models = await piModels();
	else if (id === "claude") models = ["opus", "sonnet", "fable", "haiku"];
	else models = codexModels().filter((m) => m.visibility !== "hide").map((m) => m.slug);
	return [...new Set([AGENTS[id].defaultModel, ...models])];
}

let piModelList: Promise<string[]> | undefined;

/** "provider/model" for every model `pi --list-models` reports; [] if pi can't be run. Cached per process. */
function piModels(): Promise<string[]> {
	piModelList ??= runQuietly(commandOf("pi"), ["--list-models"]).then(parsePiModels, () => {
		piModelList = undefined; // try again next time
		return [];
	});
	return piModelList;
}

/** `pi --list-models` prints a table: a "provider model …" header, then one model per row. */
function parsePiModels(table: string): string[] {
	return table
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter((cols) => cols.length >= 2 && cols[0] !== "provider")
		.map((cols) => `${cols[0]}/${cols[1]}`);
}

interface CodexModel {
	slug: string;
	visibility?: string;
	supported_reasoning_levels?: Array<{ effort: string } | string>;
}

function codexHome(): string {
	return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function codexModels(): CodexModel[] {
	try {
		const cache = JSON.parse(fs.readFileSync(path.join(codexHome(), "models_cache.json"), "utf8"));
		return Array.isArray(cache.models) ? cache.models : [];
	} catch {
		return [];
	}
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
// Codex features
// ---------------------------------------------------------------------------

/**
 * The Codex features a participant keeps. Every other feature Codex knows is
 * turned off, so features added by future versions start out off. These are
 * what reading files needs: the shell (sandboxed read-only) and image viewing.
 * Provisional until the real-agent probes have checked them.
 */
const CODEX_PARTICIPANT_FEATURES = new Set(["shell_tool", "unified_exec", "unified_exec_tty", "shell_snapshot", "view_image"]);

interface CodexFeature {
	name: string;
	stage: string;
	enabled: boolean;
}

let codexFeatureList: Promise<CodexFeature[]> | undefined;

/** Every feature this Codex knows. Cached per process; throws if the list can't be read. */
function codexFeatures(): Promise<CodexFeature[]> {
	codexFeatureList ??= runQuietly("codex", ["features", "list"])
		.then(parseCodexFeatures)
		.catch((err) => {
			codexFeatureList = undefined; // try again next time
			throw err;
		});
	return codexFeatureList;
}

/**
 * `codex features list` prints "name  stage  true|false" per line; the stage
 * may contain spaces ("under development"). Anything else throws, so a
 * changed format fails closed instead of leaving features on.
 */
function parseCodexFeatures(text: string): CodexFeature[] {
	const lines = text.split("\n").filter((line) => line.trim());
	const features = lines.map((line) => {
		const match = /^(\S+)\s+(\S.*?)\s+(true|false)\s*$/.exec(line);
		if (!match) throw new Error(`unexpected line in \`codex features list\`: ${JSON.stringify(line)}`);
		return { name: match[1] ?? "", stage: match[2] ?? "", enabled: match[3] === "true" };
	});
	if (!features.length) throw new Error("`codex features list` printed nothing");
	return features;
}

// ---------------------------------------------------------------------------
// Running a turn
// ---------------------------------------------------------------------------

interface TurnSettings {
	agent: AgentId;
	cwd: string;
	/** Session to resume; undefined starts a new one. */
	sessionId?: string;
	model: string;
	thinking: string;
	/** Fixed seat instructions (system-level), the same on every turn. */
	instructions: string;
	message: string;
}

export type TurnRequest = TurnSettings &
	(
		| { kind: "participant"; /** Role participants may search the web when their agent can. */ webSearch: boolean }
		| { kind: "moderator" }
	);

export interface TurnOutcome {
	reply: string;
	/** Pass this as `sessionId` on the seat's next turn. */
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

interface Invocation {
	command: string;
	args: string[];
	/** Set when the adapter picks the session id up front. */
	sessionId?: string;
}

interface Adapter {
	/**
	 * The process to start for this turn, with the seat kind's limits applied.
	 * Throws if the limits can't be applied: then the turn must not run.
	 */
	invocation(req: TurnRequest): Promise<Invocation>;
	/** Fold one parsed JSON line from stdout into the turn state. */
	onEvent(event: any, turn: TurnState): void;
}

const pi: Adapter = {
	async invocation(req) {
		const sessionId = req.sessionId ?? crypto.randomUUID();
		// --tools is an allowlist, but it keeps MCP tools unless excluded by name;
		// --no-mcp also stops pi's built-in MCP support from starting its servers.
		const limits =
			req.kind === "participant"
				? ["--tools", "read,grep,find,ls", "--exclude-tools", "mcp__*", "--no-mcp"]
				: ["--no-tools", "--no-mcp"];
		const args = [
			"--mode", "json", "-p",
			"--session-id", sessionId,
			"--model", req.model,
			"--thinking", req.thinking,
			...limits,
			"--append-system-prompt", req.instructions,
		];
		return { command: commandOf("pi"), args, sessionId };
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
	async invocation(req) {
		const sessionId = req.sessionId ?? crypto.randomUUID();
		let limits: string[];
		if (req.kind === "participant") {
			const tools = ["Read", "Grep", "Glob", ...(req.webSearch ? ["WebSearch", "WebFetch"] : [])].join(",");
			limits = ["--tools", tools, "--allowed-tools", tools];
		} else {
			limits = ["--tools", ""];
		}
		const args = [
			"-p",
			"--output-format", "stream-json", "--verbose",
			...(req.sessionId ? ["--resume", sessionId] : ["--session-id", sessionId]),
			"--model", req.model,
			"--effort", req.thinking,
			...limits,
			"--strict-mcp-config",
			"--append-system-prompt", req.instructions,
		];
		return { command: "claude", args, sessionId };
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
	async invocation(req) {
		if (req.kind === "moderator") throw new Error("Codex can't run a moderator seat: it has no mode without tools");
		let features: CodexFeature[];
		try {
			features = await codexFeatures();
		} catch (err) {
			throw new Error(`Codex's limits can't be applied: ${errorMessage(err)}`);
		}
		const disable = features
			.filter((f) => f.stage !== "removed" && !CODEX_PARTICIPANT_FEATURES.has(f.name))
			.flatMap((f) => ["--disable", f.name]);
		const settings = [
			"--ignore-user-config", // no user MCP servers, plugins or hooks; auth still comes from CODEX_HOME
			"-c", `model_reasoning_effort=${toml(req.thinking)}`,
			"-c", `sandbox_mode=${toml("read-only")}`,
			"-c", `approval_policy=${toml("never")}`,
			"-c", `web_search=${toml(req.webSearch ? "live" : "disabled")}`,
			...disable,
		];
		// Codex has no "append to system prompt" flag. Developer instructions given when the
		// session is created stay with it (they are ignored on resume), so send them only then.
		const args = req.sessionId
			? ["exec", "resume", req.sessionId, "--json", "--skip-git-repo-check", "-m", req.model, ...settings, "-"]
			: ["exec", "--json", "--skip-git-repo-check", "-m", req.model, ...settings, "-c", `developer_instructions=${toml(req.instructions)}`, "-"];
		return { command: "codex", args, sessionId: req.sessionId };
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
 * Run one turn of a seat and return its final reply. The seat kind's limits
 * are always applied; if they can't be, the turn fails before anything starts.
 * Throws if the agent fails, is aborted, or produces no reply or session id.
 * `onProgress` receives short status lines (e.g. tools being used).
 *
 * Whether this agent should take this seat at all is a separate question:
 * see unavailableReason().
 */
export async function runTurn(req: TurnRequest, signal?: AbortSignal, onProgress?: (status: string) => void): Promise<TurnOutcome> {
	const adapter = ADAPTERS[req.agent];
	const { command, args, sessionId } = await adapter.invocation(req);
	const label = AGENTS[req.agent].label;
	if (signal?.aborted) throw new Error("Turn was aborted");

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
		const proc = spawn(command, args, { cwd: req.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
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

		// The CLI may exit before reading all of stdin; its exit status says why.
		proc.stdin?.on("error", () => {});
		proc.stdin?.end(req.message);
		proc.stdout?.on("data", (chunk) => {
			if (aborted) return;
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) onLine(line);
		});
		proc.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
		proc.on("error", (err) => finish(() => reject(new Error(`Could not start ${label} (${command}): ${err.message}`))));
		proc.on("close", (code) => {
			if (buffer.trim() && !aborted) onLine(buffer);
			finish(() => {
				if (aborted) return reject(new Error("Turn was aborted"));
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
				setTimeout(() => proc.exitCode === null && proc.kill("SIGKILL"), 5000).unref();
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}

// ---------------------------------------------------------------------------

/** Run a short command and return its stdout; rejects on a non-zero exit or after 15 s. */
function runQuietly(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
	});
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
