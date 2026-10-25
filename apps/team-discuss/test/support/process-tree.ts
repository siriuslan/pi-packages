/** A fake agent with a tool child. The child inherits pipes and ignores TERM. */
import { spawn } from "node:child_process";
import * as fs from "node:fs";

export interface TreeReady {
	type: "ready";
	pid: number;
	leafPid: number;
}

const [mode = "hang", metadataFile] = process.argv.slice(2);
const late = `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "UNCOMMITTED LATE REPLY" }] } })}\n`;

if (mode === "leaf" || mode === "cooperative-leaf") {
	process.on("SIGTERM", () => {
		process.stdout.write(mode === "cooperative-leaf" ? "tool stopped\n" : late);
		if (mode === "cooperative-leaf") process.exit(0);
	});
	setInterval(() => {}, 60_000);
	process.send?.("ready");
} else {
	const leaf = spawn(process.execPath, [import.meta.filename, mode === "exit-cooperative" ? "cooperative-leaf" : "leaf"], {
		detached: mode === "escape",
		stdio: ["ignore", process.stdout, process.stderr, "ipc"],
	});
	leaf.on("error", (err) => { throw err; });
	leaf.once("message", () => {
		const ready: TreeReady = { type: "ready", pid: process.pid, leafPid: leaf.pid! };
		if (metadataFile) fs.writeFileSync(metadataFile, JSON.stringify(ready));
		process.stdout.write(`${JSON.stringify(ready)}\n`);
		if (mode === "exit" || mode === "fail" || mode === "escape" || mode === "exit-cooperative") {
			const reply = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "FINISHED" }], usage: { totalTokens: 7 } } };
			process.stdout.write(`${JSON.stringify(reply)}\n`, () => process.exit(mode === "fail" ? 7 : 0));
		}
	});
	if (mode === "stubborn") process.on("SIGTERM", () => process.stdout.write(late));
}
