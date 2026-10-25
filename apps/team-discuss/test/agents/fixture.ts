/** Disposable configuration and credentials for real-agent probes, never user config edits. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentId } from "../../src/core/agents.ts";
import { processes } from "../../src/core/processes.ts";

const CANARY = path.join(import.meta.dirname, "mcp-canary.ts");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export async function quiet(command: string, args: string[], cwd?: string, input?: string): Promise<string> {
	let stdout = "";
	let stderr = "";
	const outcome = await processes.run({ command, args, cwd, input, timeoutMs: 120_000,
		onStdout(chunk) { stdout += chunk; }, onStderr(chunk) { stderr = (stderr + chunk).slice(-2000); },
	});
	if (outcome.code !== 0 || outcome.signal) throw new Error(`${path.basename(command)} failed (${outcome.signal ?? outcome.code}): ${stderr}`);
	return stdout;
}

function write(file: string, contents: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, contents, { mode: 0o600 });
}

function copyIfPresent(source: string, destination: string): void {
	if (fs.existsSync(source)) write(destination, fs.readFileSync(source, "utf8"));
}

/** File contents and relative names, not timestamps, so even unrelated writes fail a probe. */
export function snapshot(dir: string): Record<string, string> {
	const entries: Record<string, string> = {};
	function walk(folder: string): void {
		for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const file = path.join(folder, entry.name);
			const name = path.relative(dir, file);
			const mode = (fs.lstatSync(file).mode & 0o777).toString(8);
			if (entry.isDirectory()) { entries[`${name}/`] = `directory:${mode}`; walk(file); }
			else if (entry.isSymbolicLink()) entries[name] = `symlink:${fs.readlinkSync(file)}`;
			else entries[name] = `${mode}:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
		}
	}
	walk(dir);
	return entries;
}

export interface ProbeFixture {
	root: string;
	cwd: string;
	secret: string;
	markers: string[];
	/** Baseline before any controls or agent turns; never absorb startup writes. */
	readonly before: Readonly<Record<string, string>>;
	/** Positive controls must start each configured server before marker absence can mean anything. */
	checkCanaries(model: string): Promise<void>;
	clearMarkers(): void;
	close(): void;
}

/** Changes only this test process's environment; probes in the file must run serially. */
export async function fixture(agent: AgentId): Promise<ProbeFixture> {
	const home = os.homedir();
	const sourcePi = process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi/agent");
	const sourceCodex = process.env.CODEX_HOME || path.join(home, ".codex");
	const sourceClaude = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
	const protectedFiles = [path.join(home, ".claude.json"), path.join(sourceClaude, "settings.json"), path.join(sourcePi, "settings.json"), path.join(sourcePi, "mcp.json"), path.join(sourceCodex, "config.toml")];
	const digest = (file: string) => fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : undefined;
	const originalConfig = protectedFiles.map(digest);
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "team-discuss-probe-")));
	fs.chmodSync(root, 0o700);
	const cwd = path.join(root, "workspace");
	fs.mkdirSync(cwd, { mode: 0o700 });
	const secret = `FILE_SECRET_${crypto.randomBytes(16).toString("hex")}`;
	write(path.join(cwd, "readable.txt"), secret);
	const markers = [path.join(root, "user-mcp-started"), path.join(root, "project-mcp-started")];
	const server = (marker: string) => ({ command: process.execPath, args: [CANARY, marker] });
	const servers = { user_canary: server(markers[0]!) };
	const projectServers = { project_canary: server(markers[1]!) };
	const env: Record<string, string | undefined> = {
		PI_CODING_AGENT_DIR: path.join(root, "pi"), PI_CODING_AGENT_SESSION_DIR: undefined,
		PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
		CLAUDE_CONFIG_DIR: path.join(root, "claude"), CODEX_HOME: path.join(root, "codex"),
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
	};
	const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	const close = () => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
		for (const [i, file] of protectedFiles.entries()) {
			if (digest(file) !== originalConfig[i]) throw new Error(`Real configuration changed during the probe: ${file}. Not restoring it automatically: another process may own the change.`);
		}
	};
	try {
		if (agent === "pi") {
			for (const file of ["auth.json", "models.json", "models-store.json"]) copyIfPresent(path.join(sourcePi, file), path.join(env.PI_CODING_AGENT_DIR!, file));
			const extensions: unknown = JSON.parse(process.env.TEAM_DISCUSS_PROBE_PI_EXTENSIONS || "[]");
			if (!Array.isArray(extensions) || extensions.some((e) => typeof e !== "string" || !path.isAbsolute(e))) throw new Error("TEAM_DISCUSS_PROBE_PI_EXTENSIONS must be a JSON array of absolute extension paths");
			write(path.join(env.PI_CODING_AGENT_DIR!, "settings.json"), json({ extensions, defaultProjectTrust: "always", cacheWarming: "off" }));
			write(path.join(env.PI_CODING_AGENT_DIR!, "mcp.json"), json({ mcpServers: servers }));
			write(path.join(cwd, ".pi/mcp.json"), json({ mcpServers: projectServers }));
			// mcp shell commands require a saved project-trust decision (settings alone aren't enough).
			write(path.join(env.PI_CODING_AGENT_DIR!, "trust.json"), json({ [cwd]: true }));
		} else if (agent === "claude") {
			const credentials = process.env.TEAM_DISCUSS_PROBE_CLAUDE_CREDENTIALS || path.join(sourceClaude, ".credentials.json");
			copyIfPresent(credentials, path.join(env.CLAUDE_CONFIG_DIR!, ".credentials.json"));
			if (!fs.existsSync(path.join(env.CLAUDE_CONFIG_DIR!, ".credentials.json")) && !process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN && process.platform === "darwin") {
				// Default macOS Claude login lives in Keychain. Keep it off stdout and argv.
				const credentials = await quiet("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
				JSON.parse(credentials); // fail before writing anything if this isn't the expected JSON
				write(path.join(env.CLAUDE_CONFIG_DIR!, ".credentials.json"), credentials);
			}
			write(path.join(env.CLAUDE_CONFIG_DIR!, ".claude.json"), json({ hasCompletedOnboarding: true, mcpServers: servers,
				projects: { [cwd]: { hasTrustDialogAccepted: true, enabledMcpjsonServers: ["project_canary"] } },
			}));
			write(path.join(cwd, ".mcp.json"), json({ mcpServers: projectServers }));
			write(path.join(cwd, ".claude/settings.json"), json({ enableAllProjectMcpServers: true }));
		} else {
			for (const file of ["auth.json", "models_cache.json"]) copyIfPresent(path.join(sourceCodex, file), path.join(env.CODEX_HOME!, file));
			const config = (name: string, marker: string) => `[mcp_servers.${name}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([CANARY, marker])}\n`;
			write(path.join(env.CODEX_HOME!, "config.toml"), `[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n${config("user_canary", markers[0]!)}\n`);
			write(path.join(cwd, ".codex/config.toml"), config("project_canary", markers[1]!));
		}
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		return {
			root, cwd, secret, markers, before: snapshot(cwd), close,
			clearMarkers() { for (const marker of markers) fs.rmSync(marker, { force: true }); },
			async checkCanaries(model) {
				if (agent === "pi") await quiet(process.env.TEAM_DISCUSS_PI_BIN || "pi", ["mcp", "list", "--json"], cwd);
				else if (agent === "claude") {
					const configFile = path.join(env.CLAUDE_CONFIG_DIR!, ".claude.json");
					const originalConfig = fs.readFileSync(configFile, "utf8");
					try {
						await quiet("claude", ["mcp", "get", "user_canary"], cwd);
						await quiet("claude", ["mcp", "get", "project_canary"], cwd);
					} finally {
						// Controls can migrate the legacy project approval from our
						// temporary .claude.json into workspace settings.local.json.
						// Restore BOTH sides so the adapter still tests fresh startup.
						// A signal handler may already have removed the private root.
						if (fs.existsSync(root)) {
							write(configFile, originalConfig);
							fs.rmSync(path.join(cwd, ".claude/settings.local.json"), { force: true });
						}
					}
				} else {
					await quiet("codex", ["exec", "--json", "--skip-git-repo-check", "-m", model, "-s", "read-only", "-c", 'approval_policy="never"', "-c", 'model_reasoning_effort="low"', "-"], cwd, "Reply CONTROL_OK without calling tools.");
				}
				for (const marker of markers) if (!fs.existsSync(marker)) throw new Error(`Positive control did not start ${path.basename(marker)}; an absent canary would be inconclusive`);
			},
		};
	} catch (err) {
		close();
		throw err;
	}
}
