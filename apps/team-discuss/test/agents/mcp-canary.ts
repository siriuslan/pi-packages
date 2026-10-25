/** Harmless stdio MCP fixture. Writes only its startup/call markers. */
import * as fs from "node:fs";
import * as readline from "node:readline";

const [marker] = process.argv.slice(2);
if (!marker) throw new Error("A canary marker path is required");
fs.appendFileSync(marker, "started\n", { mode: 0o600 });
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.id === undefined) return;
	let result: unknown;
	if (request.method === "initialize") {
		result = { protocolVersion: request.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "team-discuss-canary", version: "1.0.0" } };
	} else if (request.method === "tools/list") {
		result = { tools: [{ name: "canary", description: "Harmless team-discuss test canary", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] };
	} else if (request.method === "tools/call") {
		fs.appendFileSync(marker, "called\n");
		result = { content: [{ type: "text", text: "CANARY CALLED" }] };
	} else if (request.method === "ping") {
		result = {};
	} else {
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })}\n`);
		return;
	}
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
input.on("close", () => process.exit(0));
