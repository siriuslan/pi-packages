import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AGENTS } from "../src/agents.ts";
import { createDiscussion, loadDiscussion } from "../src/discussion.ts";
import { describe, moderatorBrief, participantBrief } from "../src/protocol.ts";
import { listTeams } from "../src/teams.ts";
import { setupDiscussion } from "../src/wizard.ts";

let root: string;
let previousAgentDir: string | undefined;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "discuss-role-test-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
});
afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	fs.rmSync(root, { recursive: true, force: true });
});

type Selection = string | undefined | ((options: string[]) => string);

/** A scripted UI fails on unexpected retries instead of hanging or touching real user data. */
function scriptedContext(t: TestContext, script: { inputs: Array<string | undefined>; selections: Selection[]; confirmations?: boolean[] }) {
	const inputs = [...script.inputs];
	const selections = [...script.selections];
	const confirmations = [...(script.confirmations ?? [])];
	const inputTitles: string[] = [];
	t.after(() => {
		assert.equal(inputs.length, 0, "all scripted inputs were used");
		assert.equal(selections.length, 0, "all scripted selections were used");
		assert.equal(confirmations.length, 0, "all scripted confirmations were used");
	});
	const ctx = {
		cwd: root,
		ui: {
			async input(title: string) {
				assert.ok(inputs.length, `unexpected input: ${title}`);
				inputTitles.push(title);
				return inputs.shift();
			},
			async select(title: string, options: string[]) {
				assert.ok(selections.length, `unexpected selection: ${title}`);
				const answer = selections.shift();
				const choice = typeof answer === "function" ? answer(options) : answer;
				if (choice !== undefined) assert.ok(options.includes(choice), `${choice} is offered in ${title}`);
				return choice;
			},
			async confirm(title: string) {
				assert.ok(confirmations.length, `unexpected confirmation: ${title}`);
				return confirmations.shift()!;
			},
			notify() {},
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, inputTitles };
}

const piChoice = (options: string[]) => {
	const choice = options.find((option) => option.endsWith("(default)"));
	assert.ok(choice, "pi is available with its defaults");
	return choice;
};
const piSettings = { agent: "pi" as const, model: AGENTS.pi.defaultModel, thinking: AGENTS.pi.defaultThinking };

for (const instruction of ["", " \t "]) {
	test(`role setup accepts ${instruction ? "whitespace-only" : "empty"} instructions`, async (t) => {
		const { ctx, inputTitles } = scriptedContext(t, {
			inputs: ["pi", instruction, ""],
			selections: ["+ Add a role", piChoice, "✓ Done"],
			confirmations: [false],
		});
		const setup = await setupDiscussion(ctx);
		assert.deepEqual(setup, { participants: [{ name: "pi", ...piSettings }], checkpointEvery: 3 });
		assert.match(inputTitles[1]!, /Role instruction for @pi \(optional, Enter to skip\)/);
	});
}

test("an explicit role instruction is trimmed and retained in the brief", async (t) => {
	const { ctx } = scriptedContext(t, {
		inputs: ["pi", "  Security reviewer.  ", ""],
		selections: ["+ Add a role", piChoice, "✓ Done"],
		confirmations: [false],
	});
	const setup = await setupDiscussion(ctx);
	assert.ok(setup);
	assert.equal(setup.participants[0]!.role, "Security reviewer.");
	const discussion = createDiscussion(root, { topic: "Review a proposal" }, setup.participants);
	const participant = discussion.participants[0]!;
	assert.equal(describe(participant), "@pi — role: Security reviewer.");
	assert.match(participantBrief(discussion, participant), /Your role in this discussion:\nSecurity reviewer\./);
});

test("cancelling the role instruction returns without adding a participant", async (t) => {
	const { ctx } = scriptedContext(t, {
		inputs: ["pi", undefined],
		selections: ["+ Add a role", undefined],
	});
	assert.equal(await setupDiscussion(ctx), undefined);
});

test("an empty instruction still allows cancelling the subsequent agent selection", async (t) => {
	const { ctx } = scriptedContext(t, {
		inputs: ["pi", ""],
		selections: ["+ Add a role", undefined, undefined],
	});
	assert.equal(await setupDiscussion(ctx), undefined);
});

test("a role without instructions survives team and discussion round trips", async (t) => {
	const { ctx } = scriptedContext(t, {
		inputs: ["pi", "", "", "bare-role"],
		selections: ["+ Add a role", piChoice, "✓ Done"],
		confirmations: [true],
	});
	const setup = await setupDiscussion(ctx);
	assert.ok(setup);
	const teams = listTeams();
	assert.equal(teams.length, 1);
	assert.deepEqual(teams[0]!.participants, [{ name: "pi", ...piSettings }]);

	const reload = scriptedContext(t, {
		inputs: [""],
		selections: ["↺ Load a saved team", "bare-role: @pi", "✓ Done"],
	});
	const loaded = await setupDiscussion(reload.ctx);
	assert.deepEqual(loaded, setup);
	const created = createDiscussion(root, { topic: "Discuss without a custom role" }, loaded!.participants);
	const discussion = loadDiscussion(root, created.id);
	assert.ok(discussion);
	const participant = discussion.participants[0]!;
	assert.equal(participant.role, undefined);
	assert.ok(fs.statSync(participant.cwd).isDirectory());
	assert.equal(describe(participant), "@pi — role");
	const brief = participantBrief(discussion, participant);
	assert.doesNotMatch(brief, /Your role in this discussion:/);
	assert.match(brief, /You are @pi, one participant/);
	assert.ok(brief.includes(`Your working directory (${participant.cwd}) may contain reference material`));
	assert.match(moderatorBrief(discussion, "start"), /- @pi — role \[/);
});

test("project participants still support both optional and explicit instructions", () => {
	const discussion = createDiscussion(root, { topic: "Project review" }, [
		{ name: "project", projectDir: root, ...piSettings },
		{ name: "owner", projectDir: root, role: "Frontend owner.", ...piSettings },
	]);
	const project = discussion.participants[0]!;
	const owner = discussion.participants[1]!;
	assert.doesNotMatch(participantBrief(discussion, project), /Your role in this discussion:/);
	assert.match(participantBrief(discussion, project), /You represent the project in your working directory/);
	assert.match(participantBrief(discussion, owner), /Your role in this discussion:\nFrontend owner\./);
	assert.ok(describe(project).endsWith(`(${root})`));
	assert.ok(describe(owner).endsWith("; role: Frontend owner."));
});
