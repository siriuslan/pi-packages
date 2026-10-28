import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { AGENTS } from "../src/agents.ts";
import { createDiscussion, isSettled, loadDiscussion, recordTurn, saveDiscussion, unseenText } from "../src/discussion.ts";
import { HAPPY_PHRASE } from "../src/protocol.ts";

type ToolContext = Parameters<ToolDefinition["execute"]>[4];

/** Exercise registered tools with real temporary records, but never invoke a real agent CLI. */
function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "discuss-tools-test-"));
	const originalScript = process.argv[1];
	const envKeys = ["DISCUSS_TEST_CAPTURE", "DISCUSS_TEST_TRANSCRIPT", "DISCUSS_TEST_FAIL"];
	const previousEnv = envKeys.map((key) => [key, process.env[key]] as const);
	t.after(() => {
		if (originalScript === undefined) delete process.argv[1];
		else process.argv[1] = originalScript;
		for (const [key, value] of previousEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
	});

	const settings = { agent: "pi" as const, model: AGENTS.pi.defaultModel, thinking: AGENTS.pi.defaultThinking };
	const d = createDiscussion(root, { topic: "Which contract should we use?" }, [
		{ name: "owner", ...settings },
		{ name: "other", ...settings },
	]);
	const capturePath = path.join(root, "capture.json");
	process.argv[1] = fileURLToPath(new URL("./support/fake-pi.mjs", import.meta.url));
	process.env.DISCUSS_TEST_CAPTURE = capturePath;
	process.env.DISCUSS_TEST_TRANSCRIPT = d.docPath;
	delete process.env.DISCUSS_TEST_FAIL;

	const tools = new Map<string, ToolDefinition>();
	extension({
		registerCommand() {},
		registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
	} as unknown as ExtensionAPI);

	return {
		root,
		d,
		capturePath,
		transcript: () => fs.readFileSync(d.docPath, "utf8"),
		capture: () => JSON.parse(fs.readFileSync(capturePath, "utf8")) as { argv: string[]; transcript: string },
		call(name: string, params: Record<string, unknown>, context: Partial<ToolContext> = {}) {
			const tool = tools.get(name);
			assert.ok(tool, `${name} is registered`);
			return tool.execute("test-call", { discussionId: d.id, ...params }, undefined, undefined, { cwd: root, hasUI: false, ...context } as ToolContext);
		},
	};
}

for (const speaker of [undefined, "human"]) {
	test(`discuss_post keeps ${speaker ?? "default"} input attributed to Human`, async (t) => {
		const f = fixture(t);
		const text = "@other, here is my answer.\n\nKeep  this spacing.";
		await f.call("discuss_post", { text, ...(speaker ? { speaker } : {}) });
		assert.ok(f.transcript().endsWith(`[Human]\n\n${text}\n`));
		assert.doesNotMatch(f.transcript(), /\[Moderator\]/);
		assert.equal(fs.existsSync(f.capturePath), false);
	});
}

test("moderator questions are public, correctly attributed and reactivate the mentioned owner", async (t) => {
	const f = fixture(t);
	const owner = f.d.participants[0]!;
	recordTurn(f.root, f.d, owner, HAPPY_PHRASE, { sessionId: "owner-session", costUsd: 0, tokens: 0 });
	assert.equal(isSettled(f.d, owner), true);
	const text = "@owner, what does the implementation in your folder guarantee?";
	await f.call("discuss_post", { text, speaker: "moderator" });
	assert.ok(f.transcript().endsWith(`[Moderator]\n\n${text}\n`));

	const reloaded = loadDiscussion(f.root, f.d.id)!;
	assert.equal(isSettled(reloaded, reloaded.participants[0]!), false);
	assert.ok(unseenText(reloaded, reloaded.participants[1]!).text.includes(text));
	assert.equal(fs.existsSync(f.capturePath), false);
});

test("dispatch records its public note before the CLI starts and shares it with other participants", async (t) => {
	const f = fixture(t);
	const note = "Which behavior does your own source code implement?";
	await f.call("discuss_dispatch", { participant: "@OWNER", note });

	const capture = f.capture();
	assert.ok(capture.transcript.endsWith(`[Moderator]\n\n@owner\n\n${note}\n`));
	assert.doesNotMatch(capture.transcript, /\n\[owner\]\n/);
	const message = capture.argv[capture.argv.indexOf("--") + 1]!;
	assert.ok(message.includes(`<document>\n${capture.transcript.trim()}\n</document>`));
	assert.ok(message.includes("Read, list and search files only under your own working directory"));
	assert.doesNotMatch(message, /Moderator note:/);
	const brief = capture.argv[capture.argv.indexOf("--append-system-prompt") + 1]!;
	assert.ok(brief.includes(`own working directory (${f.d.participants[0]!.cwd})`));
	assert.equal(f.transcript().split(note).length - 1, 1);
	assert.match(f.transcript(), /\[owner\]\n\nMy findings are in this discussion reply\./);

	const reloaded = loadDiscussion(f.root, f.d.id)!;
	assert.equal(reloaded.totalTurns, 1);
	assert.ok(unseenText(reloaded, reloaded.participants[1]!).text.includes(note));
});

for (const note of [undefined, " \t\n "]) {
	test(`dispatch without a ${note === undefined ? "supplied" : "nonblank"} note adds no empty moderator message`, async (t) => {
		const f = fixture(t);
		await f.call("discuss_dispatch", { participant: "owner", ...(note === undefined ? {} : { note }) });
		assert.doesNotMatch(f.capture().transcript, /\[Moderator\]/);
		assert.doesNotMatch(f.transcript(), /\[Moderator\]/);
	});
}

test("a failed turn leaves its public question recorded without inventing a participant reply", async (t) => {
	const f = fixture(t);
	process.env.DISCUSS_TEST_FAIL = "1";
	const note = "Can you inspect your reference material?";
	await assert.rejects(f.call("discuss_dispatch", { participant: "owner", note }), /pi exited with code 7: fake failure/);
	assert.ok(f.transcript().endsWith(`[Moderator]\n\n@owner\n\n${note}\n`));
	assert.ok(f.capture().transcript.includes(note));
	assert.equal(loadDiscussion(f.root, f.d.id)!.totalTurns, 0);
	assert.doesNotMatch(f.transcript(), /\n\[owner\]\n/);
});

test("a withheld checkpoint neither posts a dispatch note nor starts the agent", async (t) => {
	const f = fixture(t);
	f.d.totalTurns = f.d.nextCheckpointAt;
	saveDiscussion(f.root, f.d);
	const result = await f.call("discuss_dispatch", { participant: "owner", note: "Not dispatched yet?" });
	assert.match(result.content.find((item) => item.type === "text")!.text, /Checkpoint reached/);
	assert.doesNotMatch(f.transcript(), /\[Moderator\]/);
	assert.equal(fs.existsSync(f.capturePath), false);
});

test("a human checkpoint pause tells the moderator to record its question before asking", async (t) => {
	const f = fixture(t);
	f.d.totalTurns = f.d.nextCheckpointAt;
	saveDiscussion(f.root, f.d);
	const result = await f.call("discuss_dispatch", { participant: "owner" }, {
		hasUI: true,
		ui: { select: async () => "Pause — I want to add something" } as unknown as ToolContext["ui"],
	});
	assert.match(result.content.find((item) => item.type === "text")!.text, /Record your question with discuss_post using speaker="moderator", then ask the human/);
	assert.equal(fs.existsSync(f.capturePath), false);
});
