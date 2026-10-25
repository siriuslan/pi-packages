import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runTurn, type TurnRequest } from "../src/core/agents.ts";
import { Processes, type ProcessRequest } from "../src/core/processes.ts";
import { installFakeAgents } from "./support/fake-agents.ts";
import type { TreeReady } from "./support/process-tree.ts";

const TREE = path.join(import.meta.dirname, "support/process-tree.ts");
const OWNER = path.join(import.meta.dirname, "support/process-owner.ts");
const GRACE = 100;
const options = { timeout: 10_000 };

function runner(t: TestContext, graceMs = GRACE): Processes {
	const manager = new Processes({ graceMs });
	t.after(() => manager.shutdown());
	return manager;
}

/** Includes zombie handling for Linux environments whose PID 1 reaps slowly. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw err;
	}
	if (process.platform === "linux") {
		try {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw err;
		}
	}
	return true;
}

async function until(predicate: () => boolean, message: string): Promise<void> {
	const deadline = performance.now() + 5000;
	while (!predicate()) {
		if (performance.now() >= deadline) throw new Error(`Timed out: ${message}`);
		await delay(10);
	}
}

function kill(pid: number): void {
	try { process.kill(pid, "SIGKILL"); } catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
	}
}

function emergencyCleanup(info: TreeReady | undefined): void {
	if (!info) return;
	kill(-info.pid);
	kill(info.leafPid); // also covers the intentionally escaped child
}

async function gone(info: TreeReady): Promise<void> {
	await until(() => !alive(info.pid) && !alive(info.leafPid), `process tree ${info.pid}/${info.leafPid} to stop`);
}

function tree(t: TestContext, manager: Processes, mode = "hang", extra: Partial<ProcessRequest> = {}, signal?: AbortSignal) {
	let info: TreeReady | undefined;
	let stdout = "";
	let buffer = "";
	let readyAt = 0;
	const work = manager.run({
		command: process.execPath,
		args: [TREE, mode],
		...extra,
		onStdout(chunk) {
			stdout += chunk;
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.startsWith("{")) continue;
				const event = JSON.parse(line) as TreeReady;
				if (event.type === "ready") {
					info = event;
					readyAt = performance.now();
				}
			}
			extra.onStdout?.(chunk);
		},
	}, signal);
	// Tests deliberately wait for readiness before observing the final result.
	void work.catch(() => {});
	t.after(() => emergencyCleanup(info));
	return {
		work,
		get stdout() { return stdout; },
		get readyAt() { return readyAt; },
		async ready(): Promise<TreeReady> {
			await until(() => info !== undefined, "fake agent readiness");
			return info!;
		},
	};
}

describe("managed commands", () => {
	test("passes literal arguments, cwd and large stdin without a shell", options, async (t) => {
		const manager = runner(t);
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "team-discuss process test-"));
		t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
		const input = "discussion 🙂\n".repeat(50_000);
		const literal = "$(touch UNEXPECTED); echo *";
		let stdout = "";
		let stderr = "";
		const out = await manager.run({
			command: process.execPath,
			args: ["-e", `const fs = require('node:fs'); process.stdout.write(JSON.stringify({input: fs.readFileSync(0, 'utf8'), cwd: process.cwd(), args: process.argv.slice(1)})); process.stderr.write('diagnostic'); process.exitCode = 4;`, "--", literal],
			cwd, input,
			onStdout(chunk) { stdout += chunk; },
			onStderr(chunk) { stderr += chunk; },
		});
		assert.deepEqual(out, { code: 4, signal: null });
		assert.deepEqual(JSON.parse(stdout), { input, cwd: fs.realpathSync(cwd), args: [literal] });
		assert.equal(stderr, "diagnostic");
		assert.deepEqual(fs.readdirSync(cwd), []);
	});

	test("decodes UTF-8 across chunks and drains large final output", options, async (t) => {
		const manager = runner(t);
		let stdout = "";
		const out = await manager.run({
			command: process.execPath,
			args: ["-e", `const b = Buffer.from('🙂'); process.stdout.write(b.subarray(0, 2)); setTimeout(() => { process.stdout.write(b.subarray(2)); process.stdout.end('tail'.repeat(300000)); }, 25);`],
			onStdout(chunk) { stdout += chunk; },
		});
		assert.equal(out.code, 0);
		assert.equal(stdout, `🙂${"tail".repeat(300_000)}`);
	});

	test("reports a signal exit instead of inventing an exit code", options, async (t) => {
		const out = await runner(t).run({ command: process.execPath, args: ["-e", "process.kill(process.pid, 'SIGTERM')"] });
		assert.deepEqual(out, { code: null, signal: "SIGTERM" });
	});

	test("a spawn failure settles and doesn't poison the next command", options, async (t) => {
		const manager = runner(t);
		await assert.rejects(manager.run({ command: "/nonexistent-team-discuss-command", args: [] }), { code: "ENOENT" });
		assert.equal((await manager.run({ command: process.execPath, args: ["-e", ""] })).code, 0);
	});

	test("an already-aborted request does not spawn, and successful runs remove listeners", options, async (t) => {
		const manager = runner(t);
		// If this command ever spawned, the failure would be ENOENT, not AbortError.
		await assert.rejects(manager.run({ command: "/nonexistent-team-discuss-command", args: [] }, AbortSignal.abort()), { name: "AbortError" });
		const abort = new AbortController();
		await manager.run({ command: process.execPath, args: ["-e", ""] }, abort.signal);
		assert.deepEqual(getEventListeners(abort.signal, "abort"), []);
		abort.abort(); // must not send a late signal to a finished/reused pid
	});
});

describe("process-group cleanup", () => {
	test("interrupt kills a SIGTERM-ignoring grandchild after the grace period", options, async (t) => {
		const manager = runner(t);
		const abort = new AbortController();
		const agent = tree(t, manager, "hang", {}, abort.signal);
		const info = await agent.ready();
		assert.ok(alive(info.pid) && alive(info.leafPid));
		const started = performance.now();
		abort.abort();
		await assert.rejects(agent.work, { name: "AbortError" });
		assert.ok(performance.now() - started >= GRACE - 5, "must allow the grace period before SIGKILL");
		assert.ok(!agent.stdout.includes("UNCOMMITTED LATE REPLY"), "output after interruption must be ignored");
		assert.deepEqual(getEventListeners(abort.signal, "abort"), []);
		await gone(info);
	});

	test("SIGKILL also stops a direct child that ignores SIGTERM", options, async (t) => {
		const manager = runner(t);
		const abort = new AbortController();
		const agent = tree(t, manager, "stubborn", {}, abort.signal);
		const info = await agent.ready();
		abort.abort();
		await assert.rejects(agent.work, { name: "AbortError" });
		await gone(info);
	});

	for (const [mode, code] of [["exit", 0], ["fail", 7]] as const) {
		test(`cleans descendants when the direct child exits first (code ${code})`, options, async (t) => {
			const agent = tree(t, runner(t), mode);
			const info = await agent.ready();
			assert.deepEqual(await agent.work, { code, signal: null });
			assert.ok(performance.now() - agent.readyAt >= GRACE - 5);
			assert.ok(agent.stdout.includes("FINISHED"));
			await gone(info);
		});
	}

	test("interrupt during natural cleanup still discards the completed result", options, async (t) => {
		const manager = runner(t, 500);
		const abort = new AbortController();
		const agent = tree(t, manager, "exit", {}, abort.signal);
		const info = await agent.ready();
		await until(() => !alive(info.pid), "the direct child to exit");
		assert.ok(alive(info.leafPid));
		abort.abort();
		await assert.rejects(agent.work, { name: "AbortError" });
		await gone(info);
	});

	test("a timeout cleans up the whole group before rejecting", options, async (t) => {
		const agent = tree(t, runner(t), "stubborn", { timeoutMs: 1500 });
		const info = await agent.ready();
		await assert.rejects(agent.work, /timed out after 1500 ms/);
		await gone(info);
	});

	test("an output callback failure cleans up before rejecting", options, async (t) => {
		const agent = tree(t, runner(t), "hang", { onStdout() { throw new Error("display failed"); } });
		const info = await agent.ready();
		await assert.rejects(agent.work, /display failed/);
		await gone(info);
	});

	test("an escaped pipe holder fails the turn instead of hanging forever", options, async (t) => {
		const agent = tree(t, runner(t), "escape");
		const info = await agent.ready();
		await assert.rejects(agent.work, /Pipes stayed open/);
		// It deliberately escaped our group: the test, not the manager, owns it.
		assert.ok(alive(info.leafPid));
		kill(info.leafPid);
		await gone(info);
	});

	test("an uncertain group probe is not mistaken for an empty group", options, async (t) => {
		const manager = runner(t);
		const abort = new AbortController();
		const agent = tree(t, manager, "hang", {}, abort.signal);
		const info = await agent.ready();
		const originalKill = process.kill;
		let probed = false;
		t.mock.method(process, "kill", (pid: number, signal: NodeJS.Signals | number = "SIGTERM") => {
			if (pid === -info.pid && signal === 0 && !probed) {
				probed = true;
				throw Object.assign(new Error("uncertain probe"), { code: "EPERM" });
			}
			return originalKill(pid, signal);
		});
		abort.abort();
		await assert.rejects(agent.work, { name: "AbortError" });
		assert.ok(probed);
		await gone(info);
	});

	test("shutdown reports a failed kill but still awaits other groups", options, async (t) => {
		const manager = new Processes({ graceMs: GRACE });
		const first = tree(t, manager);
		const second = tree(t, manager);
		const [firstInfo, secondInfo] = await Promise.all([first.ready(), second.ready()]);
		const originalKill = process.kill;
		t.mock.method(process, "kill", (pid: number, signal: NodeJS.Signals | number = "SIGTERM") => {
			if (pid === -firstInfo.pid && signal === "SIGTERM") {
				throw Object.assign(new Error("kill denied"), { code: "EPERM" });
			}
			return originalKill(pid, signal);
		});
		await assert.rejects(manager.shutdown(), (err: unknown) => err instanceof AggregateError && /Could not send SIGTERM/.test(String(err.errors[0])));
		await assert.rejects(first.work, /Could not send SIGTERM/);
		await assert.rejects(second.work, { name: "AbortError" });
		await gone(secondInfo);
		emergencyCleanup(firstInfo); // the OS kill was deliberately denied above
		await gone(firstInfo);
	});

	test("shutdown awaits every active group and immediately refuses new commands", options, async (t) => {
		const manager = runner(t);
		const first = tree(t, manager);
		const second = tree(t, manager);
		const infos = await Promise.all([first.ready(), second.ready()]);
		const stopping = manager.shutdown();
		assert.equal(stopping, manager.shutdown(), "shutdown must be idempotent");
		await assert.rejects(manager.run({ command: "/nonexistent-team-discuss-command", args: [] }), /shut down/);
		await stopping;
		await assert.rejects(first.work, { name: "AbortError" });
		await assert.rejects(second.work, { name: "AbortError" });
		await Promise.all(infos.map(gone));
	});
});

describe("app shutdown host", () => {
	for (const mode of ["quit", "SIGINT", "SIGTERM", "SIGHUP", "exit"] as const) {
		test(`${mode}: ${mode === "exit" ? "synchronous fallback" : "awaited shutdown"} stops descendants`, options, async (t) => {
			let info: TreeReady | undefined;
			let stdout = "";
			let stderr = "";
			const host = spawn(process.execPath, [OWNER, mode === "exit" || mode === "quit" ? mode : "signal"], { stdio: ["ignore", "pipe", "pipe"] });
			const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
				host.once("error", reject);
				host.once("close", (code, signal) => resolve({ code, signal }));
			});
			void exited.catch(() => {});
			host.stdout.setEncoding("utf8").on("data", (chunk: string) => {
				stdout += chunk;
				const line = stdout.split("\n")[0];
				if (!info && stdout.includes("\n") && line) info = JSON.parse(line) as TreeReady;
			});
			host.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
			t.after(async () => {
				if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
				emergencyCleanup(info);
				await exited;
			});
			await until(() => info !== undefined, `host readiness (${stderr})`);
			if (mode !== "exit" && mode !== "quit") host.kill(mode);
			assert.deepEqual(await exited, { code: mode === "exit" ? 23 : 0, signal: null }, stderr);
			assert.equal(stdout.includes("CLEANUP FINISHED"), mode !== "exit");
			await gone(info!);
		});
	}
});

function seat(cwd: string, extra: Partial<TurnRequest> = {}): TurnRequest {
	return { agent: "pi", cwd, model: "fake", thinking: "high", instructions: "test", message: "hello", kind: "participant", webSearch: false, ...extra } as TurnRequest;
}

const reply = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } });
const tool = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] } });

describe("adapter lifecycle integration", () => {
	test("large messages and a final unterminated JSON line survive the managed streams", options, async (t) => {
		const fake = installFakeAgents();
		t.after(() => fake.restore());
		fake.script({ stdout: ["warning", "{bad json", reply], omitFinalNewline: true });
		const message = "discussion\n".repeat(50_000);
		const out = await runTurn(seat(fake.dir, { message }));
		assert.equal(out.reply, "reply");
		assert.equal(fake.calls()[0]?.stdin, message);
	});

	test("a progress callback error rejects instead of silently leaving an agent running", options, async (t) => {
		const fake = installFakeAgents();
		t.after(() => fake.restore());
		fake.script({ stdout: [tool], hang: true });
		await assert.rejects(runTurn(seat(fake.dir), undefined, () => { throw new Error("display failed"); }), /display failed/);
		const call = fake.calls()[0]!;
		await until(() => !alive(call.pid), "failed turn to stop");
	});

	test("interruption returns no reply even if the CLI has already emitted one", options, async (t) => {
		const fake = installFakeAgents();
		t.after(() => fake.restore());
		fake.script({ stdout: [reply, tool], hang: true });
		const abort = new AbortController();
		await assert.rejects(runTurn(seat(fake.dir), abort.signal, () => abort.abort()), /Turn was aborted/);
		await until(() => !alive(fake.calls()[0]!.pid), "interrupted turn to stop");
	});

	test("a successful turn awaits cleanup even after the agent exits first", options, async (t) => {
		const fake = installFakeAgents();
		const metadata = path.join(fake.dir, "tree.json");
		const command = path.join(fake.dir, "tree-pi");
		fs.writeFileSync(command, `#!/bin/sh\nexec "${process.execPath}" "${TREE}" exit-cooperative "${metadata}"\n`, { mode: 0o755 });
		process.env.TEAM_DISCUSS_PI_BIN = command;
		t.after(() => {
			try {
				if (fs.existsSync(metadata)) emergencyCleanup(JSON.parse(fs.readFileSync(metadata, "utf8")) as TreeReady);
			} finally {
				fake.restore();
			}
		});
		assert.equal((await runTurn(seat(fake.dir))).reply, "FINISHED");
		await gone(JSON.parse(fs.readFileSync(metadata, "utf8")) as TreeReady);
	});
});
