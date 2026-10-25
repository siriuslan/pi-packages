/** A disposable app host: exercises the shutdown pattern without a real UI. */
import * as path from "node:path";
import { Processes } from "../../src/core/processes.ts";
import type { TreeReady } from "./process-tree.ts";

const [mode = "signal", ...treeArgs] = process.argv.slice(2);
const runner = new Processes({ graceMs: 100 });
let buffer = "";
let ready = false;
let quitting = false;

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(signal, () => { void quit(); });
}

const work = runner.run({
	command: process.execPath,
	args: [path.join(import.meta.dirname, "process-tree.ts"), "hang", ...treeArgs],
	onStdout(chunk) {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (ready || !line.startsWith("{")) continue;
			const message = JSON.parse(line) as TreeReady;
			if (message.type !== "ready") continue;
			ready = true;
			process.stdout.write(`${JSON.stringify(message)}\n`, () => {
				if (mode === "exit") process.exit(23); // only the synchronous fallback can run
				if (mode === "quit") void quit();
			});
		}
	},
});
void work.catch((err: unknown) => {
	if (!(err instanceof Error && err.name === "AbortError")) {
		console.error(err);
		process.exitCode = 1;
	}
});

async function quit(): Promise<void> {
	if (quitting) return;
	quitting = true;
	try {
		await runner.shutdown();
		process.stdout.write("CLEANUP FINISHED\n", () => process.exit(0));
	} catch (err) {
		console.error(err);
		process.exit(1);
	}
}
