/**
 * POSIX process lifetimes. Every command gets its own process group; finishing
 * means the group has been cleaned up, not just that the direct child exited.
 * No caller needs to know pids, send signals or keep a second cleanup timer.
 */

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface ProcessRequest {
	command: string;
	args: readonly string[];
	cwd?: string;
	/** Written to stdin, then stdin is closed (including when input is absent). */
	input?: string;
	/** UTF-8 chunks, not lines. No output is delivered after cancellation. */
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
	/** Optional running-time limit, followed by the usual group cleanup. */
	timeoutMs?: number;
}

export interface ProcessOutcome {
	code: number | null;
	signal: NodeJS.Signals | null;
}

/**
 * Owns commands for one application lifetime. Use the shared `processes` in
 * production; separate instances allow short grace periods in tests.
 * Signal/quit handlers belong to the app: await shutdown(), release the
 * discussion lock, then exit. Only the synchronous exit fallback lives here.
 */
export class Processes {
	private readonly graceMs: number;
	private readonly running = new Map<AbortController, Promise<ProcessOutcome>>();
	private shuttingDown?: Promise<void>;

	constructor({ graceMs = 5000 }: { graceMs?: number } = {}) {
		if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error("The cleanup grace period must be non-negative and finite");
		this.graceMs = graceMs;
	}

	/**
	 * Run without a shell, streaming output. Resolves even for a non-zero exit
	 * (the caller interprets it). Rejects on a spawn, I/O, callback, timeout or
	 * cleanup error, or with AbortError when cancelled, even during cleanup.
	 * In every case, cleanup precedes settlement. An already-aborted request
	 * and a request after shutdown never spawn anything.
	 */
	async run(req: ProcessRequest, signal?: AbortSignal): Promise<ProcessOutcome> {
		if (this.shuttingDown) throw new Error("Processes have been shut down");
		if (signal?.aborted) throw aborted();
		if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("team-discuss requires macOS or Linux");

		const stop = new AbortController();
		const onAbort = () => stop.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const work = runChild(req, stop.signal, this.graceMs);
		this.running.set(stop, work);
		try {
			return await work;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.running.delete(stop);
		}
	}

	/**
	 * Refuse new commands, stop all current ones in parallel, and await their
	 * cleanup. Safe to call repeatedly. Cancellation is expected; other errors
	 * from commands still running are reported together after all have settled.
	 */
	shutdown(): Promise<void> {
		// Defer the work so the shutdown flag is set before abort listeners run.
		this.shuttingDown ??= Promise.resolve().then(async () => {
			const work = [...this.running.values()];
			for (const stop of this.running.keys()) stop.abort();
			const results = await Promise.allSettled(work);
			const errors = results.flatMap((r) => r.status === "rejected" && !isAborted(r.reason) ? [r.reason] : []);
			if (errors.length) throw new AggregateError(errors, "Some processes failed during shutdown");
		});
		return this.shuttingDown;
	}
}

export const processes = new Processes();

// Also includes groups whose cleanup failed, so an unexpected exit can try
// again. Never signal just the child pid: it may have exited before its tools.
const groups = new Set<number>();
process.once("exit", () => {
	for (const pgid of groups) {
		try {
			signalGroup(pgid, "SIGKILL");
		} catch {
			// exit handlers cannot wait or recover. Normal shutdown reports errors.
		}
	}
});

async function runChild(req: ProcessRequest, signal: AbortSignal, graceMs: number): Promise<ProcessOutcome> {
	const child = spawn(req.command, req.args, { cwd: req.cwd, detached: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
	const pgid = child.pid;
	if (pgid !== undefined) groups.add(pgid);

	let failure: Error | undefined;
	let outcome: ProcessOutcome = { code: null, signal: null };
	let end!: () => void;
	const ended = new Promise<void>((resolve) => { end = resolve; });
	const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	const fail = (err: unknown) => {
		failure ??= err instanceof Error ? err : new Error(String(err));
		end();
	};
	const deliver = (callback: ((chunk: string) => void) | undefined, chunk: string) => {
		if (signal.aborted || failure) return;
		try {
			callback?.(chunk);
		} catch (err) {
			fail(err);
		}
	};

	child.stdout.setEncoding("utf8").on("data", (chunk: string) => deliver(req.onStdout, chunk));
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => deliver(req.onStderr, chunk));
	child.stdout.on("error", fail);
	child.stderr.on("error", fail);
	child.stdin.on("error", (err: NodeJS.ErrnoException) => {
		// Early exits commonly close stdin before reading it; the exit status
		// tells the caller why. Other I/O failures still stop the command.
		if (err.code !== "EPIPE") fail(err);
	});
	child.once("error", fail);
	// Do not wait for "close" to start cleanup. A grandchild can inherit the
	// pipes and hold them open indefinitely after the direct child exits.
	child.once("exit", (code, exitSignal) => {
		outcome = { code, signal: exitSignal };
		end();
	});
	signal.addEventListener("abort", end, { once: true });
	if (signal.aborted) end();
	const timeout = req.timeoutMs === undefined ? undefined : setTimeout(() => fail(new Error(`${req.command} timed out after ${req.timeoutMs} ms`)), req.timeoutMs);

	let cleaned = false;
	try {
		child.stdin.end(req.input);
		await ended;
		if (timeout) clearTimeout(timeout);
		if (pgid !== undefined) {
			await cleanGroup(pgid, graceMs);
			// Cleanup is complete even if pipe draining later fails. Retaining a
			// dead pgid would let the exit fallback signal an unrelated reused id.
			groups.delete(pgid);
		}
		// Drain final buffered output, but don't hang if an escaped descendant
		// (outside our group) has inherited a pipe. Such a turn fails closed.
		await drain(closed);
		cleaned = true;
		if (signal.aborted) throw aborted();
		if (failure) throw failure;
		return outcome;
	} finally {
		if (timeout) clearTimeout(timeout);
		signal.removeEventListener("abort", end);
		if (!cleaned) {
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
			child.unref();
		}
	}
}

/** Normal EOF is immediate after cleanup; escaped pipe holders get at most 1 s. */
async function drain(closed: Promise<void>): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			closed,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Pipes stayed open after process-group cleanup; a descendant may have escaped")), 1000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** SIGTERM, a bounded grace period, then SIGKILL even if the leader is gone. */
async function cleanGroup(pgid: number, graceMs: number): Promise<void> {
	if (!signalGroup(pgid, "SIGTERM")) return;
	const deadline = performance.now() + graceMs;
	while (signalGroup(pgid, 0)) {
		const remaining = deadline - performance.now();
		if (remaining <= 0) {
			signalGroup(pgid, "SIGKILL");
			// Do not wait for kill(-pgid, 0) to become false after SIGKILL:
			// on Linux an orphan's zombie can remain until its reaper runs.
			return;
		}
		await delay(Math.min(25, remaining));
	}
}

/** False only when certainly absent. Permission failures on a probe mean held. */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
	try {
		process.kill(-pgid, signal);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		// macOS can briefly report EPERM while a signalled group is exiting.
		// Uncertainty is not absence; keep waiting, but never mask a failed kill.
		if (signal === 0 && code === "EPERM") return true;
		throw new Error(`Could not send ${signal} to process group ${pgid}`, { cause: err });
	}
}

function aborted(): Error {
	const err = new Error("Process was aborted");
	err.name = "AbortError";
	return err;
}

function isAborted(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}
