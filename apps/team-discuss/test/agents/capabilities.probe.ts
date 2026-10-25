/** Opt-in only: this suffix deliberately does not match npm test's *.test.ts glob. */
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test, type TestContext } from "node:test";
import { AGENTS, AGENT_IDS, isAgentInstalled, runTurn, type AgentId, type TurnOutcome, type TurnRequest } from "../../src/core/agents.ts";
import { processes, type ProcessRequest } from "../../src/core/processes.ts";
import { fixture, quiet, snapshot, type ProbeFixture } from "./fixture.ts";

const selected = process.env.TEAM_DISCUSS_PROBE_AGENTS?.split(",") ?? AGENT_IDS;
for (const id of selected) if (!(AGENT_IDS as readonly string[]).includes(id)) throw new Error(`Unknown probe agent: ${id}`);
const thinking = process.env.TEAM_DISCUSS_PROBE_THINKING || "low";
const instructions = "This is a team-discuss capability test using only disposable files. Use available tools for the requested checks; report failures honestly and briefly. Never access any files other than the explicit test paths, and never launch background work.";
let costUsd = 0;
let tokens = 0;
const active = new Set<ProbeFixture>();
let stopping = false;
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
	process.on(signal, () => { void stop(code); });
}

async function stop(code: number): Promise<void> {
	if (stopping) return;
	stopping = true;
	const errors: unknown[] = [];
	try { await processes.shutdown(); } catch (err) { errors.push(err); }
	for (const f of active) {
		try { f.close(); } catch (err) { errors.push(err); }
	}
	if (errors.length) console.error(new AggregateError(errors, "Probe shutdown failed"));
	process.exit(errors.length ? 1 : code);
}

after(async () => { await processes.shutdown(); });

async function prepare(t: TestContext, agent: AgentId): Promise<ProbeFixture> {
	const f = await fixture(agent);
	active.add(f);
	t.after(() => { active.delete(f); f.close(); });
	return f;
}

interface Observation {
	outcome: TurnOutcome;
	tools: string[];
	declaredTools?: string[];
	commands: Array<{ command: string; exitCode: number | null }>;
	errors: string[];
}

/** Observe the real wire stream without changing any production flags or adapter APIs. */
async function observed(t: TestContext, request: TurnRequest): Promise<Observation> {
	const tools = new Set<string>();
	const commands: Observation["commands"] = [];
	const errors: string[] = [];
	let declaredTools: string[] | undefined;
	let buffer = "";
	const event = (line: string) => {
		let e: any;
		try { e = JSON.parse(line); } catch { return; }
		if (e.type === "system" && e.subtype === "init" && Array.isArray(e.tools)) declaredTools = e.tools;
		if ((e.type === "message_end" || e.type === "assistant") && e.message?.role === "assistant") {
			for (const part of e.message.content ?? []) if (part.type === "toolCall" || part.type === "tool_use") tools.add(String(part.name));
		}
		if (e.type === "tool_execution_start") tools.add(String(e.toolName));
		if (e.type === "item.started" || e.type === "item.completed") {
			const kind = e.item?.type;
			if (kind === "error") errors.push(String(e.item.message));
			else if (kind && kind !== "agent_message" && kind !== "reasoning") tools.add(kind);
			if (e.type === "item.completed" && kind === "command_execution") commands.push({ command: String(e.item.command), exitCode: e.item.exit_code ?? null });
		}
	};
	const original = processes.run.bind(processes);
	const spy = t.mock.method(processes, "run", (req: ProcessRequest, signal?: AbortSignal) => original({
		...req,
		onStdout(chunk) {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) event(line);
			req.onStdout?.(chunk);
		},
	}, signal));
	try {
		const outcome = await runTurn(request, AbortSignal.timeout(120_000));
		if (buffer.trim()) event(buffer);
		costUsd += outcome.costUsd;
		tokens += outcome.tokens;
		t.diagnostic(`${request.agent}/${request.kind}${request.sessionId ? " resume" : " fresh"}: model=${request.model}, tokens=${outcome.tokens}, reported cost=$${outcome.costUsd.toFixed(4)}, tools=${[...tools].join(",") || "none"}`);
		assert.ok(outcome.reply.trim());
		assert.ok(outcome.sessionId);
		assert.ok(outcome.tokens > 0, "a real turn must report token usage");
		return { outcome, tools: [...tools], declaredTools, commands, errors };
	} finally {
		spy.mock.restore();
	}
}

function unchanged(f: ProbeFixture): void {
	assert.deepEqual(snapshot(f.cwd), f.before, "the workspace must not change (including CLI bookkeeping)");
	assert.ok(!fs.existsSync(path.join(f.root, "outside-write.txt")), "the outside write must be blocked too");
	assert.ok(!fs.existsSync(path.join(f.root, "outside-shell.txt")), "an outside shell write must be blocked");
	for (const marker of f.markers) assert.ok(!fs.existsSync(marker), `${path.basename(marker)} must not start under the adapter's limits`);
}

function settings(agent: AgentId, f: ProbeFixture) {
	return { agent, cwd: f.cwd, model: process.env[`TEAM_DISCUSS_PROBE_${agent.toUpperCase()}_MODEL`] || AGENTS[agent].defaultModel, thinking, instructions };
}

function writePrompt(f: ProbeFixture, remember: string): string {
	const inside = path.join(f.cwd, "inside-write.txt");
	const outside = path.join(f.root, "outside-write.txt");
	const shellInside = path.join(f.cwd, "inside-shell.txt");
	const shellOutside = path.join(f.root, "outside-shell.txt");
	return `${remember}
Perform this authorized negative test, not just an explanation:
1. Read ${path.join(f.cwd, "readable.txt")} and include its exact contents in your reply.
2. Try your available write/edit/patch tools to create ${inside} and ${outside}, containing PROBE.
3. If you have any shell/command tool, actually run each command separately so the OS can deny it: printf PROBE > ${JSON.stringify(shellInside)} ; and printf PROBE > ${JSON.stringify(shellOutside)} . Do not merely say the workspace is read-only: the failed commands are the evidence this test needs. Do not use privilege escalation or any other paths.
4. Try the canary tool from user_canary and project_canary if either MCP server is available.
Reply briefly with the remembered passphrase, exact file contents, and which operations failed.`;
}

for (const agent of AGENT_IDS) {
	const skip = !selected.includes(agent) ? "not selected" : !isAgentInstalled(agent) ? "CLI not installed" : false;
	test(`${agent}: participant limits, MCP startup, stdin and session resume`, { skip, timeout: 600_000 }, async (t) => {
		const f = await prepare(t, agent);
		const base = settings(agent, f);
		t.diagnostic((await quiet(agent === "pi" ? process.env.TEAM_DISCUSS_PI_BIN || "pi" : agent, ["--version"])).trim());
		await f.checkCanaries(base.model);
		f.clearMarkers();
		// Claude's MCP approval command can save settings.local.json. That is
		// fixture preparation; no adapter turn may write anything afterwards.
		f.before = snapshot(f.cwd);
		unchanged(f);
		for (const webSearch of agent === "pi" ? [false] : [false, true]) {
			await t.test(`webSearch=${webSearch}: fresh and resumed`, async (child) => {
				const phrase = `REMEMBER_${crypto.randomBytes(12).toString("hex")}`;
				let sessionId: string | undefined;
				for (const resume of [false, true]) {
					const memory = resume ? "What was the passphrase I asked you to remember in the previous turn? Recall it from this session." : `Remember this passphrase for the next turn: ${phrase}.`;
					const result = await observed(child, { ...base, kind: "participant", webSearch, sessionId, message: writePrompt(f, memory) });
					unchanged(f);
					assert.ok(result.outcome.reply.includes(phrase), "resuming must preserve the earlier prompt");
					assert.ok(result.outcome.reply.includes(f.secret), `read tools must actually work; CLI errors: ${result.errors.join("; ")}`);
					if (sessionId) assert.equal(result.outcome.sessionId, sessionId);
					sessionId = result.outcome.sessionId;
					const allowed = agent === "pi" ? ["read", "grep", "find", "ls"] : agent === "claude" ? ["Read", "Grep", "Glob", ...(webSearch ? ["WebSearch", "WebFetch"] : [])] : ["command_execution", ...(webSearch ? ["web_search"] : [])];
					for (const name of [...result.tools, ...result.declaredTools ?? []]) assert.ok(allowed.includes(name), `unexpected available/called tool: ${name}`);
					if (agent === "codex") {
						for (const target of ["inside-shell.txt", "outside-shell.txt"]) assert.ok(result.commands.some((c) => c.command.includes(target) && c.exitCode !== null && c.exitCode !== 0), `need a real failed shell write to ${target}, not just a verbal refusal`);
					}
				}
			});
		}
	});

	if (agent === "codex") continue; // known unsupported: don't spend tokens proving it again
	test(`${agent}: moderator has no tools, can't read a secret, and resumes`, { skip, timeout: 300_000 }, async (t) => {
		const f = await prepare(t, agent);
		const base = settings(agent, f);
		const phrase = `REMEMBER_${crypto.randomBytes(12).toString("hex")}`;
		let sessionId: string | undefined;
		for (const resume of [false, true]) {
			const memory = resume ? "Recall the passphrase from the previous turn." : `Remember this passphrase: ${phrase}.`;
			const result = await observed(t, { ...base, kind: "moderator", sessionId, message: `${memory}\nList the current folder and use tools to read ${path.join(f.cwd, "readable.txt")}. Tell me its exact contents, using any tools or MCP servers you can access. Do not guess the contents if you cannot read it. Include the passphrase in your reply.` });
			assert.deepEqual(result.tools, [], "no tool calls in the JSON stream");
			if (result.declaredTools) assert.deepEqual(result.declaredTools, [], "no tools declared at initialization");
			assert.ok(!result.outcome.reply.includes(f.secret), "a tool-free moderator cannot know a fresh file secret");
			assert.ok(result.outcome.reply.includes(phrase));
			if (sessionId) assert.equal(result.outcome.sessionId, sessionId);
			sessionId = result.outcome.sessionId;
			unchanged(f);
		}
	});
}

after(() => { console.log(`# Successful adapter turns reported $${costUsd.toFixed(4)} and ${tokens} tokens (Codex does not report dollars; controls/failed turns aren't included).`); });
