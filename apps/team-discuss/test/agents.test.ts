import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import {
	AGENTS,
	type AgentId,
	agentSummary,
	isAgentInstalled,
	runTurn,
	suggestedModels,
	thinkingLevels,
	type TurnRequest,
	unavailableReason,
} from "../src/core/agents.ts";
import { type FakeAgents, installFakeAgents } from "./support/fake-agents.ts";

let fake: FakeAgents;
before(() => {
	fake = installFakeAgents();
});
after(() => fake.restore());

const settings = { model: "m-1", thinking: "high", instructions: "INSTRUCTIONS", message: "MESSAGE" };

function participant(agent: AgentId, extra: Partial<TurnRequest> = {}): TurnRequest {
	return { ...settings, cwd: fake.dir, agent, kind: "participant", webSearch: false, ...extra } as TurnRequest;
}

function moderator(agent: AgentId, extra: Partial<TurnRequest> = {}): TurnRequest {
	return { ...settings, cwd: fake.dir, agent, kind: "moderator", ...extra } as TurnRequest;
}

const line = (event: object) => JSON.stringify(event);

const PI_EVENTS = [
	line({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }], usage: { cost: { total: 0.25 }, totalTokens: 100 } } }),
	line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello from pi" }], usage: { cost: { total: 0.5 }, totalTokens: 200 } } }),
];

const CLAUDE_EVENTS = [
	line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }),
	line({
		type: "result",
		result: "Hello from Claude",
		session_id: "claude-session",
		total_cost_usd: 0.5,
		usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
	}),
];

const CODEX_EVENTS = [
	line({ type: "thread.started", thread_id: "codex-thread" }),
	line({ type: "item.started", item: { type: "command_execution" } }),
	line({ type: "item.completed", item: { type: "agent_message", text: "Let me check." } }),
	line({ type: "item.completed", item: { type: "agent_message", text: "Hello from Codex" } }),
	line({ type: "turn.completed", usage: { input_tokens: 30, output_tokens: 7 } }),
];

const CODEX_FEATURES = `${[
	"apps                                     stable             true",
	"shell_tool                               stable             true",
	"unified_exec                             stable             true",
	"view_image                               stable             true",
	"collaboration_modes                      removed            true",
	"code_mode                                under development  false",
].join("\n")}\n`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function onlyCall() {
	const calls = fake.calls();
	assert.equal(calls.length, 1, `expected one CLI call, got ${calls.length}`);
	return calls[0]!;
}

describe("pi", () => {
	test("a participant runs with read tools only and no MCP; the message goes on stdin", async () => {
		fake.script({ stdout: PI_EVENTS });
		const progress: string[] = [];
		const out = await runTurn(participant("pi"), undefined, (status) => progress.push(status));

		const call = onlyCall();
		assert.equal(call.agent, "pi");
		assert.match(out.sessionId, UUID);
		assert.deepEqual(call.argv, [
			"--mode", "json", "-p",
			"--session-id", out.sessionId,
			"--model", "m-1",
			"--thinking", "high",
			"--tools", "read,grep,find,ls", "--exclude-tools", "mcp__*", "--no-mcp",
			"--append-system-prompt", "INSTRUCTIONS",
		]);
		assert.equal(call.stdin, "MESSAGE");
		assert.equal(call.cwd, fs.realpathSync(fake.dir));
		assert.deepEqual(out, { reply: "Hello from pi", sessionId: out.sessionId, costUsd: 0.75, tokens: 300 });
		assert.deepEqual(progress, ["using read (1 tool calls so far)"]);
	});

	test("the moderator runs with no tools and no MCP", async () => {
		fake.script({ stdout: PI_EVENTS });
		const out = await runTurn(moderator("pi"));
		assert.deepEqual(onlyCall().argv, [
			"--mode", "json", "-p",
			"--session-id", out.sessionId,
			"--model", "m-1",
			"--thinking", "high",
			"--no-tools", "--no-mcp",
			"--append-system-prompt", "INSTRUCTIONS",
		]);
	});

	test("resumes the given session", async () => {
		fake.script({ stdout: PI_EVENTS });
		const out = await runTurn(participant("pi", { sessionId: "pi-session" }));
		const argv = onlyCall().argv;
		assert.deepEqual(argv.slice(argv.indexOf("--session-id"), argv.indexOf("--session-id") + 2), ["--session-id", "pi-session"]);
		assert.equal(out.sessionId, "pi-session");
	});

	test("TEAM_DISCUSS_PI_BIN picks the pi binary", async () => {
		fake.script({ stdout: PI_EVENTS });
		process.env.TEAM_DISCUSS_PI_BIN = fake.addCommand("my-pi");
		try {
			await runTurn(participant("pi"));
			assert.equal(onlyCall().agent, "my-pi");
		} finally {
			delete process.env.TEAM_DISCUSS_PI_BIN;
		}
	});

	test("an error reported by the model fails the turn", async () => {
		fake.script({ stdout: [line({ type: "message_end", message: { role: "assistant", content: [], errorMessage: "overloaded" } })] });
		await assert.rejects(runTurn(participant("pi")), /^Error: pi: overloaded$/);
	});
});

describe("Claude Code", () => {
	test("a project participant gets read tools only, auto-approved, and no MCP servers", async () => {
		fake.script({ stdout: CLAUDE_EVENTS });
		const progress: string[] = [];
		const out = await runTurn(participant("claude"), undefined, (status) => progress.push(status));

		const call = onlyCall();
		assert.match(call.argv[5] ?? "", UUID);
		assert.deepEqual(call.argv.with(5, "<id>"), [
			"-p",
			"--output-format", "stream-json", "--verbose",
			"--session-id", "<id>",
			"--model", "m-1",
			"--effort", "high",
			"--tools", "Read,Grep,Glob", "--allowed-tools", "Read,Grep,Glob",
			"--strict-mcp-config",
			"--append-system-prompt", "INSTRUCTIONS",
		]);
		assert.equal(call.stdin, "MESSAGE");
		assert.deepEqual(out, { reply: "Hello from Claude", sessionId: "claude-session", costUsd: 0.5, tokens: 18 });
		assert.deepEqual(progress, ["using Read (1 tool calls so far)"]);
	});

	test("a role participant with web search also gets WebSearch and WebFetch", async () => {
		fake.script({ stdout: CLAUDE_EVENTS });
		await runTurn(participant("claude", { webSearch: true }));
		const argv = onlyCall().argv;
		const tools = "Read,Grep,Glob,WebSearch,WebFetch";
		assert.deepEqual(argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 4), ["--tools", tools, "--allowed-tools", tools]);
	});

	test("the moderator runs with no tools and no MCP servers", async () => {
		fake.script({ stdout: CLAUDE_EVENTS });
		await runTurn(moderator("claude"));
		const argv = onlyCall().argv;
		assert.deepEqual(argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 3), ["--tools", "", "--strict-mcp-config"]);
		assert.ok(!argv.includes("--allowed-tools"));
	});

	test("resumes the given session", async () => {
		fake.script({ stdout: CLAUDE_EVENTS });
		await runTurn(participant("claude", { sessionId: "claude-session" }));
		const argv = onlyCall().argv;
		assert.deepEqual(argv.slice(4, 6), ["--resume", "claude-session"]);
		assert.ok(!argv.includes("--session-id"));
	});

	test("an error result fails the turn", async () => {
		fake.script({ stdout: [line({ type: "result", is_error: true, result: "rate limited", session_id: "s" })] });
		await assert.rejects(runTurn(participant("claude")), /^Error: Claude Code: rate limited$/);
	});
});

// The feature list is cached once read successfully, so the failure case runs first.
describe("Codex", () => {
	test("if its feature list can't be read, a participant turn fails before Codex starts", async () => {
		fake.script({ stdout: CODEX_EVENTS }); // no featuresList: `codex features list` exits 1
		await assert.rejects(runTurn(participant("codex")), /Codex's limits can't be applied/);
		assert.deepEqual(onlyCall().argv, ["features", "list"]);
	});

	test("the moderator seat is refused before anything starts", async () => {
		fake.script({ stdout: CODEX_EVENTS, featuresList: CODEX_FEATURES });
		await assert.rejects(runTurn(moderator("codex")), /no mode without tools/);
		assert.equal(fake.calls().length, 0);
	});

	test("a participant runs sandboxed read-only, without user config, with unlisted features off", async () => {
		fake.script({ stdout: CODEX_EVENTS, featuresList: CODEX_FEATURES });
		const progress: string[] = [];
		const out = await runTurn(participant("codex"), undefined, (status) => progress.push(status));

		const exec = fake.calls().find((c) => c.argv[0] === "exec");
		assert.ok(exec);
		assert.deepEqual(exec.argv, [
			"exec", "--json", "--skip-git-repo-check", "-m", "m-1",
			"--ignore-user-config",
			"-c", 'model_reasoning_effort="high"',
			"-c", 'sandbox_mode="read-only"',
			"-c", 'approval_policy="never"',
			"-c", 'web_search="disabled"',
			// apps and code_mode aren't on the allowlist; removed features are left alone
			"--disable", "apps", "--disable", "code_mode",
			"-c", 'developer_instructions="INSTRUCTIONS"',
			"-",
		]);
		assert.equal(exec.stdin, "MESSAGE");
		assert.deepEqual(out, { reply: "Hello from Codex", sessionId: "codex-thread", costUsd: 0, tokens: 37 });
		assert.deepEqual(progress, ["using command_execution (1 tool calls so far)"]);
	});

	test("a role participant with web search gets live search", async () => {
		fake.script({ stdout: CODEX_EVENTS, featuresList: CODEX_FEATURES });
		await runTurn(participant("codex", { webSearch: true }));
		assert.ok(onlyCall().argv.includes('web_search="live"'));
	});

	test("resuming keeps the session and doesn't resend the instructions", async () => {
		fake.script({ stdout: CODEX_EVENTS, featuresList: CODEX_FEATURES });
		await runTurn(participant("codex", { sessionId: "codex-thread" }));
		const argv = onlyCall().argv;
		assert.deepEqual(argv.slice(0, 3), ["exec", "resume", "codex-thread"]);
		assert.ok(argv.includes("--ignore-user-config"));
		assert.ok(!argv.some((a) => a.startsWith("developer_instructions=")));
	});

	test("a failed turn surfaces the readable part of Codex's error", async () => {
		const error = JSON.stringify({ error: { message: "quota exceeded" } });
		fake.script({ stdout: [line({ type: "turn.failed", error: { message: error } })], featuresList: CODEX_FEATURES });
		await assert.rejects(runTurn(participant("codex")), /^Error: Codex: quota exceeded$/);
	});
});

describe("failed turns", () => {
	test("a non-zero exit reports the end of stderr", async () => {
		fake.script({ stdout: [], stderr: "boom", exitCode: 3 });
		await assert.rejects(runTurn(participant("pi")), /^Error: pi exited with code 3: boom$/);
	});

	test("no reply fails the turn", async () => {
		fake.script({ stdout: [line({ type: "message_end", message: { role: "assistant", content: [] } })] });
		await assert.rejects(runTurn(participant("pi")), /produced no reply/);
	});

	test("a CLI that can't be started fails the turn", async () => {
		process.env.TEAM_DISCUSS_PI_BIN = path.join(fake.dir, "missing-pi");
		try {
			await assert.rejects(runTurn(participant("pi")), /^Error: Could not start pi/);
		} finally {
			delete process.env.TEAM_DISCUSS_PI_BIN;
		}
	});

	test("aborting stops the CLI and fails the turn", async () => {
		fake.script({ hang: true });
		const abort = new AbortController();
		const turn = runTurn(participant("pi"), abort.signal);
		while (fake.calls().length === 0) await new Promise((r) => setTimeout(r, 10));
		abort.abort();
		await assert.rejects(turn, /aborted/);
	});

	test("an already aborted turn never starts the CLI", async () => {
		fake.script({ stdout: PI_EVENTS });
		await assert.rejects(runTurn(participant("pi"), AbortSignal.abort()), /aborted/);
		assert.equal(fake.calls().length, 0);
	});
});

describe("which agent may take which seat", () => {
	test("only pi's seat limits have passed the real-agent probes so far", async () => {
		assert.equal(await unavailableReason("pi", "participant"), undefined);
		assert.equal(await unavailableReason("pi", "moderator"), undefined);
		for (const kind of ["participant", "moderator"] as const) {
			assert.match((await unavailableReason("claude", kind)) ?? "", /isn't verified|aren't verified/);
		}
	});

	test("Codex can't be the moderator", async () => {
		assert.match((await unavailableReason("codex", "moderator")) ?? "", /no mode without tools/);
	});

	test("Codex participants aren't offered until their limits are verified", async () => {
		assert.match((await unavailableReason("codex", "participant")) ?? "", /aren't verified/);
	});

	test("an agent that isn't installed isn't offered", async () => {
		process.env.TEAM_DISCUSS_PI_BIN = path.join(fake.dir, "missing-pi");
		try {
			assert.equal(isAgentInstalled("pi"), false);
			assert.match((await unavailableReason("pi", "participant")) ?? "", /isn't installed/);
		} finally {
			delete process.env.TEAM_DISCUSS_PI_BIN;
		}
	});

	test("installed means found on PATH, for pi too", () => {
		for (const agent of ["pi", "claude", "codex"] as const) assert.equal(isAgentInstalled(agent), true);
		const savedPath = process.env.PATH;
		process.env.PATH = path.join(fake.dir, "nothing-here");
		try {
			for (const agent of ["pi", "claude", "codex"] as const) assert.equal(isAgentInstalled(agent), false);
		} finally {
			process.env.PATH = savedPath;
		}
	});
});

// The pi model list is cached once read successfully, so the failure case runs first.
describe("models and thinking levels", () => {
	test("pi offers only its default when `pi --list-models` fails", async () => {
		fake.script({}); // no listModels: exits 1
		assert.deepEqual(await suggestedModels("pi"), [AGENTS.pi.defaultModel]);
	});

	test("pi offers the models `pi --list-models` reports, default first", async () => {
		const table = [
			"provider   model              context  max-out  thinking  images",
			"anthropic  claude-opus-5-5    1M       128K     yes       yes",
			"openai     gpt-9              400K     128K     yes       yes",
			"",
		].join("\n");
		fake.script({ listModels: table });
		assert.deepEqual(await suggestedModels("pi"), ["anthropic/claude-opus-5-5", "openai/gpt-9"]);
	});

	test("Codex offers the visible models from its cache, and their thinking levels", async () => {
		const codexHome = path.join(fake.dir, "codex-home");
		fs.mkdirSync(codexHome, { recursive: true });
		fs.writeFileSync(
			path.join(codexHome, "models_cache.json"),
			JSON.stringify({ models: [{ slug: "gpt-a", supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }] }, { slug: "secret", visibility: "hide" }] }),
		);
		process.env.CODEX_HOME = codexHome;
		try {
			assert.deepEqual(await suggestedModels("codex"), [AGENTS.codex.defaultModel, "gpt-a"]);
			assert.deepEqual(thinkingLevels("codex", "gpt-a"), ["xhigh", "low"]);
		} finally {
			delete process.env.CODEX_HOME;
		}
	});

	test("Claude Code's models and thinking levels start with the defaults", async () => {
		assert.deepEqual(await suggestedModels("claude"), ["opus", "sonnet", "fable", "haiku"]);
		assert.deepEqual(thinkingLevels("claude", "opus"), ["xhigh", "low", "medium", "high", "max"]);
	});

	test("agentSummary names agent, model and thinking", () => {
		assert.equal(agentSummary({ agent: "claude", model: "opus", thinking: "xhigh" }), "Claude Code · opus · xhigh");
	});
});
