/**
 * Puts fake pi, claude and codex CLIs (fake-cli.ts) on PATH for a test file.
 * PATH is set to the fake folder alone, so a test can never start a real
 * agent and spend tokens.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FakeCall, FakeScript } from "./fake-cli.ts";

export type { FakeCall, FakeScript };

const FAKE_CLI = path.join(import.meta.dirname, "fake-cli.ts");
const ENV_KEYS = ["PATH", "FAKE_AGENT_LOG", "FAKE_AGENT_SCRIPT", "TEAM_DISCUSS_PI_BIN", "CODEX_HOME"] as const;

export interface FakeAgents {
	/** A temp folder for the test's own files (cwd, CODEX_HOME…); removed by restore(). */
	dir: string;
	/** How every fake call behaves from now on; also clears the call log. */
	script(script: FakeScript): void;
	/** Calls made since the last script(). */
	calls(): FakeCall[];
	/** Add another fake command, e.g. a custom pi binary; returns its path. */
	addCommand(name: string): string;
	/** Undo the environment changes and delete the temp folder. */
	restore(): void;
}

export function installFakeAgents(): FakeAgents {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-discuss-test-"));
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin);
	const log = path.join(dir, "calls.jsonl");
	const scriptFile = path.join(dir, "script.json");

	const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	process.env.PATH = bin;
	process.env.FAKE_AGENT_LOG = log;
	process.env.FAKE_AGENT_SCRIPT = scriptFile;
	delete process.env.TEAM_DISCUSS_PI_BIN;

	const addCommand = (name: string) => {
		const file = path.join(bin, name);
		fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" ${name} "$@"\n`, { mode: 0o755 });
		return file;
	};
	for (const name of ["pi", "claude", "codex"]) addCommand(name);

	return {
		dir,
		script(script) {
			fs.writeFileSync(scriptFile, JSON.stringify(script));
			fs.rmSync(log, { force: true });
		},
		calls() {
			if (!fs.existsSync(log)) return [];
			return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeCall);
		},
		addCommand,
		restore() {
			for (const key of ENV_KEYS) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}
