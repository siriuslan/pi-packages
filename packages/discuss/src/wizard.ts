/**
 * Interactive setup of a discussion's participants (project folders and/or
 * roles, each with its own agent, model and thinking level) and its
 * checkpoint interval.
 * Can start from — and save to — a reusable team.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AGENT_IDS, AGENTS, agentSummary, isAgentInstalled, suggestedModels, thinkingLevels } from "./agents.ts";
import { defaultCheckpointEvery, type ParticipantSpec, RESERVED_NAMES, slugify } from "./discussion.ts";
import { describeTeam, listTeams, saveTeam } from "./teams.ts";

export interface Setup {
	participants: ParticipantSpec[];
	checkpointEvery: number;
}

const ADD_PROJECT = "+ Add a project folder";
const ADD_ROLE = "+ Add a role";
const LOAD_TEAM = "↺ Load a saved team";
const REMOVE = "− Remove a participant";
const DONE = "✓ Done";

/**
 * Ask for one line of text until `check` accepts it. `check` returns the
 * problem with the answer (shown above the prompt on the retry), or nothing
 * if it's fine. Returns the trimmed answer, or undefined if the user pressed
 * Esc. (pi doesn't display input placeholders, so examples and defaults must
 * be part of the title.)
 */
async function askText(
	ctx: ExtensionCommandContext,
	title: string,
	check: (value: string) => string | undefined = () => undefined,
): Promise<string | undefined> {
	let problem: string | undefined;
	while (true) {
		const raw = await ctx.ui.input(problem ? `⚠ ${problem}\n\n${title}` : title);
		if (raw === undefined) return undefined;
		problem = check(raw.trim());
		if (!problem) return raw.trim();
	}
}

/**
 * Walk the user through choosing participants. Esc inside any step goes back
 * to the participant list; Esc on the list itself cancels (after confirming,
 * if participants were added). Returns undefined if they cancel.
 */
export async function setupDiscussion(ctx: ExtensionCommandContext): Promise<Setup | undefined> {
	const ui = ctx.ui;
	const participants: ParticipantSpec[] = [];
	let loadedTeam: string | undefined;
	let changedSinceLoad = false;
	let checkpointEvery: number | undefined;

	while (checkpointEvery === undefined) {
		const teams = listTeams();
		const options = [
			...(participants.length ? [DONE] : []),
			ADD_PROJECT,
			ADD_ROLE,
			...(teams.length ? [LOAD_TEAM] : []),
			...(participants.length ? [REMOVE] : []),
		];
		const title = participants.length
			? `Participants: ${participants.map((p) => `@${p.name}`).join(", ")}`
			: "Who takes part in this discussion? Add at least one participant.";
		const choice = await ui.select(title, options);
		if (choice === undefined) {
			if (!participants.length) return undefined;
			const discard = await ui.confirm("Cancel the discussion setup?", `The ${participants.length} participant(s) added so far will be discarded.`);
			if (discard) return undefined;
			continue;
		}

		const taken = new Set(participants.map((p) => p.name));
		if (choice === DONE) {
			checkpointEvery = await askCheckpoint(ctx, participants.length);
		} else if (choice === ADD_PROJECT || choice === ADD_ROLE) {
			const spec = choice === ADD_PROJECT ? await askProject(ctx, taken) : await askRole(ctx, taken);
			if (spec) {
				participants.push(spec);
				changedSinceLoad = true;
			}
		} else if (choice === LOAD_TEAM) {
			const labels = teams.map(describeTeam);
			const pick = await ui.select("Load which team?", labels);
			if (!pick) continue;
			const team = teams[labels.indexOf(pick)];
			const added = team.participants.filter((p) => !taken.has(p.name));
			participants.push(...added);
			if (participants.length === added.length) {
				loadedTeam = team.name;
				changedSinceLoad = false;
			} else {
				changedSinceLoad = true;
			}
		} else if (choice === REMOVE) {
			const pick = await ui.select("Remove which participant?", participants.map((p) => `@${p.name}`));
			if (!pick) continue;
			participants.splice(participants.findIndex((p) => `@${p.name}` === pick), 1);
			changedSinceLoad = true;
		}
	}

	if (!loadedTeam || changedSinceLoad) {
		const save = await ui.confirm("Save these participants as a team?", "You can load a saved team next time instead of adding everyone again.");
		if (save) {
			const name = await askText(
				ctx,
				loadedTeam ? `Team name (Enter for "${loadedTeam}")` : "Team name, e.g. matching-system (Esc to skip saving)",
				(v) => (v || loadedTeam ? undefined : "A team name is required."),
			);
			if (name !== undefined) {
				const team = saveTeam(name || loadedTeam!, participants);
				ui.notify(`Saved team "${team.name}".`, "info");
			}
		}
	}
	return { participants, checkpointEvery };
}

function resolveDir(cwd: string, raw: string): string | undefined {
	const expanded = raw.trim().replace(/^~(?=$|\/)/, os.homedir());
	const dir = path.resolve(cwd, expanded);
	return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? dir : undefined;
}

async function askProject(ctx: ExtensionCommandContext, taken: Set<string>): Promise<ParticipantSpec | undefined> {
	const ui = ctx.ui;
	const raw = await askText(
		ctx,
		"Project folder: absolute, ~/…, or relative to the current folder (e.g. ~/projects/my-app)",
		(v) => (!v ? "A folder is required." : resolveDir(ctx.cwd, v) ? undefined : `Not a folder: ${v}`),
	);
	if (raw === undefined) return undefined;
	const projectDir = resolveDir(ctx.cwd, raw)!;
	const name = await askName(ctx, taken, slugify(path.basename(projectDir), 30));
	if (!name) return undefined;
	const role = await askText(
		ctx,
		`Role for @${name} (optional, Enter to skip)\ne.g. Frontend owner; focus on API contracts and UX impact`,
	);
	if (role === undefined) return undefined;
	const agent = await askAgent(ctx, name, false);
	if (!agent) return undefined;
	return { name, projectDir, ...(role.trim() ? { role: role.trim() } : {}), ...agent };
}

async function askRole(ctx: ExtensionCommandContext, taken: Set<string>): Promise<ParticipantSpec | undefined> {
	const name = await askName(ctx, taken);
	if (!name) return undefined;
	const role = await askText(
		ctx,
		[
			`Role instruction for @${name} (optional, Enter to skip): who they are, what they care about, how they should argue.`,
			`e.g. Security reviewer. Skeptical of new dependencies; argue from concrete threats and cite sources.`,
			`(Longer material? After setup, put files in @${name}'s workspace folder.)`,
		].join("\n"),
	);
	if (role === undefined) return undefined;
	const agent = await askAgent(ctx, name, true);
	if (!agent) return undefined;
	return { name, ...(role ? { role } : {}), ...agent };
}

async function askName(ctx: ExtensionCommandContext, taken: Set<string>, suggested?: string): Promise<string | undefined> {
	const toName = (v: string) => slugify(v || suggested || "", 30);
	const raw = await askText(
		ctx,
		suggested ? `Tag name (Enter for @${suggested})` : "Tag name, used as @name in the discussion (e.g. security-reviewer)",
		(v) => {
			const name = toName(v);
			if (!name) return "A tag name is required.";
			if (RESERVED_NAMES.has(name)) return `@${name} is reserved; pick another name.`;
			if (taken.has(name)) return `@${name} is already a participant.`;
		},
	);
	return raw === undefined ? undefined : toName(raw);
}

const OTHER_MODEL = "Other… (type a model name)";

/**
 * Agent, model and thinking level for one participant. The first menu offers
 * each installed agent with its defaults (one click); "Customize…" walks
 * through agent → model → thinking.
 */
async function askAgent(
	ctx: ExtensionCommandContext,
	name: string,
	isRole: boolean,
): Promise<Pick<ParticipantSpec, "agent" | "model" | "thinking"> | undefined> {
	const ui = ctx.ui;
	const installed = AGENT_IDS.filter(isAgentInstalled);
	const missing = AGENT_IDS.filter((id) => !installed.includes(id)).map((id) => AGENTS[id].label);
	const title = `Agent for @${name}${missing.length ? ` (not installed: ${missing.join(", ")})` : ""}`;

	const quickPicks = installed.map((id) => {
		const value = { agent: id, model: AGENTS[id].defaultModel, thinking: AGENTS[id].defaultThinking };
		const web = isRole && AGENTS[id].webSearch ? " · web search" : "";
		return { label: `${agentSummary(value)}${web}${id === "pi" ? "  (default)" : ""}`, value };
	});
	const customize = "Customize…";
	const choice = await ui.select(title, [...quickPicks.map((q) => q.label), customize]);
	if (!choice) return undefined;
	const quick = quickPicks.find((q) => q.label === choice);
	if (quick) return quick.value;

	const agentLabels = installed.map((id) => AGENTS[id].label);
	const agentLabel = await ui.select(title, agentLabels);
	if (!agentLabel) return undefined;
	const agent = installed[agentLabels.indexOf(agentLabel)];
	const { label } = AGENTS[agent];

	let model = await ui.select(`${label} model for @${name}`, [...suggestedModels(agent, ctx.modelRegistry), OTHER_MODEL]);
	if (model === OTHER_MODEL) model = await askText(ctx, `${label} model name`, (v) => (v ? undefined : "A model name is required."));
	if (!model) return undefined;

	const thinking = await ui.select(
		`${label} thinking level for @${name}`,
		thinkingLevels(agent, model).map((l) => (l === AGENTS[agent].defaultThinking ? `${l} (default)` : l)),
	);
	if (!thinking) return undefined;
	return { agent, model, thinking: thinking.split(" ")[0] };
}

async function askCheckpoint(ctx: ExtensionCommandContext, participantCount: number): Promise<number | undefined> {
	const fallback = defaultCheckpointEvery(participantCount);
	const toNumber = (v: string) => (v ? Number(v) : fallback);
	const raw = await askText(
		ctx,
		`Check in with you every N turns (Enter for ${fallback} = ${participantCount} participants × 3)`,
		(v) => (Number.isInteger(toNumber(v)) && toNumber(v) > 0 ? undefined : "Enter a whole number greater than 0."),
	);
	return raw === undefined ? undefined : toNumber(raw);
}
