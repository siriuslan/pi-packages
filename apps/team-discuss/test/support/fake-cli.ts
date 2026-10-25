/**
 * Stand-in for the pi, claude and codex CLIs in tests; installed under those
 * names by installFakeAgents() (fake-agents.ts), which passes the name as the
 * first argument. Each call is appended to $FAKE_AGENT_LOG as one JSON line,
 * and the call behaves as the script in $FAKE_AGENT_SCRIPT says.
 */

import * as fs from "node:fs";

export interface FakeScript {
	/** Lines printed on stdout for a turn (usually JSON events). */
	stdout?: string[];
	stderr?: string;
	exitCode?: number;
	/** Never finish the turn: wait to be killed. */
	hang?: boolean;
	/** Output of `codex features list`; exit code 1 when absent. */
	featuresList?: string;
	/** Output of `pi --list-models`; exit code 1 when absent. */
	listModels?: string;
}

export interface FakeCall {
	agent: string;
	argv: string[];
	stdin: string;
	cwd: string;
}

const [agent = "", ...argv] = process.argv.slice(2);
const scriptFile = process.env.FAKE_AGENT_SCRIPT;
const script: FakeScript = scriptFile && fs.existsSync(scriptFile) ? JSON.parse(fs.readFileSync(scriptFile, "utf8")) : {};

const isQuery = argv[0] === "features" || argv.includes("--list-models");
// Queries are run without input; reading stdin there would wait forever.
const stdin = isQuery ? "" : fs.readFileSync(0, "utf8");
const call: FakeCall = { agent, argv, stdin, cwd: process.cwd() };
if (process.env.FAKE_AGENT_LOG) fs.appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify(call)}\n`);

if (argv[0] === "features") answer(script.featuresList);
else if (argv.includes("--list-models")) answer(script.listModels);
else if (script.hang) setInterval(() => {}, 60_000);
else {
	for (const line of script.stdout ?? []) process.stdout.write(`${line}\n`);
	if (script.stderr) process.stderr.write(script.stderr);
	process.exitCode = script.exitCode ?? 0;
}

function answer(output: string | undefined): void {
	if (output === undefined) process.exitCode = 1;
	else process.stdout.write(output);
}
