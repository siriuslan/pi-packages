import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { AGENT_IDS, AGENTS, type AgentId } from "../src/agents.ts";
import { createDiscussion, type Participant } from "../src/discussion.ts";
import { moderatorBrief, participantBrief, turnMessage } from "../src/protocol.ts";

function discussion(t: TestContext, agent: AgentId = "pi", kind: "project" | "role" = "role") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "discuss-protocol-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const settings = { agent, model: AGENTS[agent].defaultModel, thinking: AGENTS[agent].defaultThinking };
	return createDiscussion(root, { topic: "Review a proposal together" }, [
		{ name: "owner", ...(kind === "project" ? { projectDir: root } : {}), ...settings },
		{ name: "other", ...settings },
	]);
}

function assertParticipantRules(text: string, participant: Participant) {
	assert.ok(text.includes(`Read, list and search files only under your own working directory (${participant.cwd})`));
	assert.match(text, /Do not inspect another participant's folder or any path outside your working directory/);
	assert.match(text, /including through parent paths or symlinks/);
	assert.match(text, /do not open the shared discussion document yourself/);
	assert.match(text, /Raise all questions and requests for information in your discussion reply/);
	assert.match(text, /@-mentioning the relevant participant or @Human/);
	assert.match(text, /ask its owner to inspect it and share findings in the discussion/);
	assert.match(text, /never read it directly or use a private question channel/);
	assert.match(text, /Do not modify files/);
}

for (const agent of AGENT_IDS) {
	for (const kind of ["project", "role"] as const) {
		test(`${agent} ${kind} participants are instructed to keep file access local and questions public`, (t) => {
			const d = discussion(t, agent, kind);
			const participant = d.participants[0]!;
			const brief = participantBrief(d, participant);
			assertParticipantRules(brief, participant);
			assert.equal(brief.includes("You can search the web"), kind === "role" && AGENTS[agent].webSearch);
		});
	}
}

for (const kind of ["all", "new", "edited"] as const) {
	test(`${kind} turn messages repeat the current rules for resumed sessions`, (t) => {
		const d = discussion(t, "codex");
		const participant = d.participants[0]!;
		participant.sessionId = "session-created-before-the-new-rules";
		participant.turns = 1;
		const message = turnMessage(participant, { kind, text: "[Moderator]\n\n@owner\n\nWhat does your code do?" });
		assertParticipantRules(message, participant);
		assert.match(message, /<document>\n\[Moderator\]\n\n@owner\n\nWhat does your code do\?\n<\/document>/);
		assert.doesNotMatch(message, /Moderator note:/);
	});
}

test("a turn with no unseen text still carries the current workspace rules", (t) => {
	const d = discussion(t);
	const participant = d.participants[0]!;
	const message = turnMessage(participant, { kind: "new", text: " \n " });
	assertParticipantRules(message, participant);
	assert.match(message, /Nothing new has been added/);
});

for (const mode of ["start", "continue"] as const) {
	test(`${mode} moderator briefs prohibit folder inspection and require recorded questions`, (t) => {
		const brief = moderatorBrief(discussion(t, "pi", "project"), mode);
		assert.match(brief, /Do not read, list, search or otherwise inspect any participant's project folder or reference-material workspace/);
		assert.match(brief, /the shared document itself is the only file you should read/);
		assert.match(brief, /ask the participant who owns that folder to inspect it and share findings in the discussion/);
		assert.match(brief, /Do not inspect it yourself or ask a different participant to read it/);
		assert.match(brief, /All questions must be raised in the shared discussion, not solely in chat or private notes/);
		assert.match(brief, /discuss_post using speaker="moderator"/);
		assert.match(brief, /recorded publicly as \[Moderator\] before their turn/);
		assert.match(brief, /the default speaker is "human"/);
	});
}
