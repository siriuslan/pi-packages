import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { AGENT_IDS } from "../src/core/agents.ts";
import { fixture, snapshot } from "./agents/fixture.ts";

/** Fake credentials only. No CLI runs, Keychain reads or actual home-directory access. */
function sourceHome(t: TestContext): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-discuss-probe-unit-"));
	const env: Record<string, string | undefined> = {
		HOME: root, PI_CODING_AGENT_DIR: path.join(root, ".pi/agent"),
		CLAUDE_CONFIG_DIR: path.join(root, ".claude"), CODEX_HOME: path.join(root, ".codex"),
		TEAM_DISCUSS_PROBE_PI_EXTENSIONS: undefined, TEAM_DISCUSS_PROBE_CLAUDE_CREDENTIALS: undefined,
	};
	const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	for (const [name, value] of Object.entries({
		".pi/agent/auth.json": { anthropic: { type: "api_key", key: "NOT-A-REAL-CREDENTIAL" } },
		".pi/agent/settings.json": { defaultModel: "original" },
		".claude/.credentials.json": { claudeAiOauth: { accessToken: "NOT-A-REAL-CREDENTIAL" } },
		".claude/settings.json": {},
		".claude.json": { hasCompletedOnboarding: true },
		".codex/auth.json": { OPENAI_API_KEY: "NOT-A-REAL-CREDENTIAL" },
		".codex/config.toml": "original = true",
	})) {
		const file = path.join(root, name);
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
	}
	t.after(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
	});
	return root;
}

for (const agent of AGENT_IDS) {
	test(`${agent} probe copies fake credentials privately, restores env and removes its home`, async (t) => {
		const home = sourceHome(t);
		const key = agent === "pi" ? "PI_CODING_AGENT_DIR" : agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
		const source = process.env[key]!;
		const file = agent === "claude" ? ".credentials.json" : "auth.json";
		const original = fs.readFileSync(path.join(source, file), "utf8");
		const f = await fixture(agent);
		try {
			assert.ok(f.root !== home);
			assert.equal(fs.statSync(f.root).mode & 0o777, 0o700);
			assert.deepEqual(snapshot(f.cwd), f.before);
			assert.equal(fs.readFileSync(path.join(f.cwd, "readable.txt"), "utf8"), f.secret);
			assert.ok(f.markers.every((marker) => !fs.existsSync(marker)));
			const copied = path.join(process.env[key]!, file);
			assert.equal(fs.statSync(copied).mode & 0o777, 0o600);
			assert.equal(fs.readFileSync(copied, "utf8"), original);
			fs.writeFileSync(copied, "changed copy");
			assert.equal(fs.readFileSync(path.join(source, file), "utf8"), original);
		} finally {
			f.close();
		}
		assert.equal(process.env[key], source);
		assert.ok(!fs.existsSync(f.root));
	});
}

test("Claude canary controls restore legacy approvals and the original workspace", async (t) => {
	const home = sourceHome(t);
	const originalPath = process.env.PATH;
	t.after(() => { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; });
	const f = await fixture("claude");
	try {
		const configFile = path.join(process.env.CLAUDE_CONFIG_DIR!, ".claude.json");
		const original = fs.readFileSync(configFile, "utf8");
		const bin = path.join(home, "bin");
		const script = path.join(home, "fake-mcp-control.cjs");
		fs.mkdirSync(bin);
		fs.writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const name = process.argv.at(-1);
const servers = name === 'user_canary' ? config.mcpServers : JSON.parse(fs.readFileSync('.mcp.json', 'utf8')).mcpServers;
fs.appendFileSync(servers[name].args[1], 'started\\n');
fs.writeFileSync('.claude/settings.local.json', JSON.stringify({enabledMcpjsonServers: ['project_canary']}));
delete config.projects[process.cwd()].enabledMcpjsonServers;
fs.writeFileSync(file, JSON.stringify(config));
`);
		fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
		process.env.PATH = bin; // no real agent CLI is reachable
		await f.checkCanaries("fake-model");
		assert.ok(f.markers.every((marker) => fs.existsSync(marker)));
		assert.deepEqual(snapshot(f.cwd), f.before);
		assert.equal(fs.readFileSync(configFile, "utf8"), original);
		assert.deepEqual(JSON.parse(original).projects[f.cwd].enabledMcpjsonServers, ["project_canary"]);
		f.clearMarkers();
		assert.ok(f.markers.every((marker) => !fs.existsSync(marker)));
	} finally { f.close(); }
});

test("probe snapshots notice contents, permissions, empty directories and symlinks", async (t) => {
	sourceHome(t);
	const f = await fixture("pi");
	try {
		fs.chmodSync(path.join(f.cwd, "readable.txt"), 0o400);
		assert.notDeepEqual(snapshot(f.cwd), f.before);
		fs.chmodSync(path.join(f.cwd, "readable.txt"), 0o600);
		assert.deepEqual(snapshot(f.cwd), f.before);
		fs.mkdirSync(path.join(f.cwd, "empty"));
		assert.notDeepEqual(snapshot(f.cwd), f.before);
		fs.rmdirSync(path.join(f.cwd, "empty"));
		fs.symlinkSync("readable.txt", path.join(f.cwd, "link"));
		assert.notDeepEqual(snapshot(f.cwd), f.before);
		fs.unlinkSync(path.join(f.cwd, "link"));
		fs.appendFileSync(path.join(f.cwd, "readable.txt"), "changed");
		assert.notDeepEqual(snapshot(f.cwd), f.before);
	} finally { f.close(); }
});

test("invalid provider extension settings fail without changing the source environment", async (t) => {
	sourceHome(t);
	const original = process.env.PI_CODING_AGENT_DIR;
	process.env.TEAM_DISCUSS_PROBE_PI_EXTENSIONS = '["relative/extension.ts"]';
	await assert.rejects(fixture("pi"), /absolute extension paths/);
	assert.equal(process.env.PI_CODING_AGENT_DIR, original);
});

test("a source config change is reported but never overwritten during cleanup", async (t) => {
	const home = sourceHome(t);
	const f = await fixture("pi");
	const file = path.join(home, ".pi/agent/settings.json");
	fs.writeFileSync(file, "user's concurrent edit");
	assert.throws(() => f.close(), /Real configuration changed/);
	assert.equal(fs.readFileSync(file, "utf8"), "user's concurrent edit");
	assert.equal(process.env.PI_CODING_AGENT_DIR, path.join(home, ".pi/agent"));
	assert.ok(!fs.existsSync(f.root));
});
