/**
 * @siriuslan/discuss — moderated multi-participant discussions.
 *
 * The current pi session is the moderator ("master agent"). Each participant
 * is a separate agent session (pi, Claude Code or Codex) — grounded in a project folder or defined by a
 * role — with its own agent, model and thinking level. Everything said is recorded
 * in one markdown document under discussion-docs/.
 *
 *   /discuss start [topic]        set up participants, create the doc, hand off to the moderator
 *   /discuss continue [id|doc]    resume a discussion, or adopt an existing markdown doc
 *   /discuss list                 discussions in the current folder
 *   /discuss teams                view / delete saved teams
 *
 * The moderator drives the discussion with the discuss_* tools; those tools
 * stay inactive until /discuss start or /discuss continue is used.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	appendSection,
	checkpointDue,
	createDiscussion,
	type Discussion,
	findParticipant,
	isSettled,
	listDiscussions,
	loadDiscussion,
	passCheckpoint,
	formatUsage,
	recordTurn,
	saveDiscussion,
	unseenText,
} from "./src/discussion.ts";
import { agentSummary, runTurn } from "./src/agents.ts";
import { cleanReply, hasWebSearch, mentions, moderatorBrief, participantBrief, turnMessage } from "./src/protocol.ts";
import { deleteTeam, describeTeam, listTeams } from "./src/teams.ts";
import { setupDiscussion } from "./src/wizard.ts";

const TOOL_NAMES = ["discuss_dispatch", "discuss_status", "discuss_post", "discuss_summarize"];
const USAGE = "Usage: /discuss start [topic] | /discuss continue [id|doc.md] | /discuss list | /discuss teams";

function requireDiscussion(root: string, id: string): Discussion {
	const d = loadDiscussion(root, id);
	if (d) return d;
	const known = listDiscussions(root).map((x) => x.id);
	throw new Error(`Unknown discussion "${id}". Known: ${known.join(", ") || "none"}`);
}

function discussionLabel(d: Discussion): string {
	return `${d.id} — ${d.totalTurns} turns — ${d.participants.map((p) => `@${p.name}`).join(", ")}`;
}

/** Who still has something to say, for the moderator. */
function statusReport(d: Discussion): string {
	const lines = d.participants.map((p) => {
		const unseen = unseenText(d, p);
		const state =
			p.turns === 0
				? "hasn't spoken yet"
				: isSettled(d, p)
					? "settled (happy)"
					: mentions(unseen.text, p.name)
						? "@-mentioned since their last turn"
						: "active";
		return `- @${p.name} (${agentSummary(p)}): ${state}; ${p.turns} turns; ${formatUsage([p])}`;
	});
	const allSettled = d.participants.every((p) => isSettled(d, p));
	return [
		`Discussion ${d.id}: ${d.totalTurns} turns, ${formatUsage(d.participants)} so far; next human checkpoint after turn ${d.nextCheckpointAt}.`,
		`Document: ${d.docPath}`,
		...lines,
		allSettled
			? d.summarizedAt
				? `Everyone is settled and the summary has been written.`
				: `Everyone is settled → write the summary with discuss_summarize.`
			: ``,
	]
		.filter(Boolean)
		.join("\n");
}

/** Ask the human at a checkpoint. Returns an instruction for the moderator if it must not dispatch. */
async function checkpointGate(ctx: ExtensionContext, d: Discussion): Promise<string | undefined> {
	if (!ctx.hasUI) {
		return `Checkpoint reached after ${d.totalTurns} turns and no human is available to approve more. Stop dispatching and report the status.`;
	}
	const proceed = `Continue (${d.checkpointEvery} more turns)`;
	const wrapUp = "Wrap up — summarize now";
	const pause = "Pause — I want to add something";
	const choice = await ctx.ui.select(
		`Discussion checkpoint: ${d.totalTurns} turns so far, ${formatUsage(d.participants)}. Continue?`,
		[proceed, pause, wrapUp],
	);
	passCheckpoint(ctx.cwd, d);
	if (choice === proceed) return undefined;
	if (choice === wrapUp) {
		return "At the checkpoint the human asked to wrap up. Do not dispatch anyone; write the summary now with discuss_summarize.";
	}
	return 'At the checkpoint the human paused the discussion. Do not dispatch anyone. Record your question with discuss_post using speaker="moderator", then ask the human what they want to add. Record their answer with discuss_post (the default speaker is "human"), and continue only when they say so.';
}

export default function (pi: ExtensionAPI) {
	function handOff(ctx: ExtensionCommandContext, d: Discussion, mode: "start" | "continue") {
		pi.setActiveTools([...new Set([...pi.getActiveTools(), ...TOOL_NAMES])]);
		const brief = moderatorBrief(d, mode);
		if (ctx.isIdle()) pi.sendUserMessage(brief);
		else pi.sendUserMessage(brief, { deliverAs: "followUp" });
	}

	async function startCommand(topicArg: string, ctx: ExtensionCommandContext) {
		const topic = topicArg || (await ctx.ui.editor("What should be discussed? (question, proposal, context…)", ""));
		if (!topic?.trim()) return;
		const setup = await setupDiscussion(ctx);
		if (!setup) return ctx.ui.notify("Discussion setup cancelled.", "info");
		const d = createDiscussion(ctx.cwd, { topic }, setup.participants, setup.checkpointEvery);
		ctx.ui.notify(`Created ${path.relative(ctx.cwd, d.docPath)}`, "info");
		handOff(ctx, d, "start");
	}

	async function continueCommand(ref: string, ctx: ExtensionCommandContext) {
		let d: Discussion | undefined;
		if (!ref) {
			const all = listDiscussions(ctx.cwd);
			if (!all.length) return ctx.ui.notify("No discussions in this folder yet. Use /discuss start.", "info");
			const labels = all.map(discussionLabel);
			const pick = await ctx.ui.select("Continue which discussion?", labels);
			if (!pick) return;
			d = all[labels.indexOf(pick)];
		} else {
			d = loadDiscussion(ctx.cwd, ref);
		}

		if (!d) {
			const doc = path.resolve(ctx.cwd, ref);
			if (!fs.existsSync(doc) || !fs.statSync(doc).isFile()) return ctx.ui.notify(`No discussion or document found: ${ref}`, "error");
			ctx.ui.notify("This document isn't a discussion yet — choose its participants.", "info");
			const setup = await setupDiscussion(ctx);
			if (!setup) return ctx.ui.notify("Discussion setup cancelled.", "info");
			d = createDiscussion(ctx.cwd, { existingDoc: doc }, setup.participants, setup.checkpointEvery);
		}
		handOff(ctx, d, "continue");
	}

	async function teamsCommand(ctx: ExtensionCommandContext) {
		const teams = listTeams();
		if (!teams.length) return ctx.ui.notify("No saved teams yet. You can save one at the end of /discuss start.", "info");
		const labels = teams.map(describeTeam);
		const pick = await ctx.ui.select("Saved teams", labels);
		if (!pick) return;
		const team = teams[labels.indexOf(pick)];
		const details = team.participants
			.map((p) => `@${p.name} — ${p.projectDir ?? "role"}${p.role ? `: ${p.role.split("\n")[0].slice(0, 80)}` : ""} [${agentSummary(p)}]`)
			.join("\n");
		const action = await ctx.ui.select(`Team "${team.name}"\n${details}`, ["Back", "Delete this team"]);
		if (action === "Delete this team" && (await ctx.ui.confirm("Delete team?", `Delete "${team.name}"?`))) {
			deleteTeam(team.name);
			ctx.ui.notify(`Deleted team "${team.name}".`, "info");
		}
	}

	pi.registerCommand("discuss", {
		description: "Moderated multi-participant discussion (projects and/or roles). /discuss start|continue|list|teams",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "start ", label: "start [topic]" },
				{ value: "continue ", label: "continue [id | path/to/doc.md]" },
				{ value: "list", label: "list" },
				{ value: "teams", label: "teams" },
			];
			return items.filter((i) => i.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			const sub = input.split(/\s+/)[0] ?? "";
			const rest = input.slice(sub.length).trim();

			if (sub === "list") {
				const all = listDiscussions(ctx.cwd);
				ctx.ui.notify(all.length ? all.map(discussionLabel).join("\n") : "No discussions in this folder yet.", "info");
				return;
			}
			if (!ctx.hasUI) return ctx.ui.notify("/discuss needs the interactive UI.", "error");
			if (sub === "start") return startCommand(rest, ctx);
			if (sub === "continue") return continueCommand(rest, ctx);
			if (sub === "teams") return teamsCommand(ctx);
			if (sub === "") {
				const pick = await ctx.ui.select("Discussions", ["Start a new discussion", "Continue a discussion", "Manage saved teams"]);
				if (pick === "Start a new discussion") return startCommand("", ctx);
				if (pick === "Continue a discussion") return continueCommand("", ctx);
				if (pick === "Manage saved teams") return teamsCommand(ctx);
				return;
			}
			ctx.ui.notify(USAGE, "warning");
		},
	});

	const discussionId = Type.String({ description: "Discussion id, as given when the discussion was started/continued." });

	pi.registerTool({
		name: "discuss_dispatch",
		label: "Discuss: Dispatch",
		description:
			"Give one participant the floor: they are shown everything new in the discussion document, reply in their own persistent session, and the reply is appended to the document. Any moderator note is recorded publicly before the turn. Returns the reply and who is still active.",
		promptSnippet: "Give one discussion participant the floor",
		promptGuidelines: [
			"Dispatch exactly one participant per discuss_dispatch call; choose the next speaker yourself from open @mentions and missing viewpoints.",
			"Don't dispatch settled participants unless they've been @-mentioned since.",
			"Do not inspect participant folders yourself. Ask the owning participant for findings in the shared discussion; notes are public, not a private question channel.",
		],
		defaultActive: false,
		executionMode: "sequential",
		parameters: Type.Object({
			discussionId,
			participant: Type.String({ description: "Participant name, e.g. matching-ui (with or without @)." }),
			note: Type.Optional(Type.String({ description: "Optional public moderator note or question addressed to this participant, e.g. 'answer @sf360's question about batching'. Appended to the shared discussion under [Moderator] before the turn." })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const d = requireDiscussion(ctx.cwd, params.discussionId);
			const p = findParticipant(d, params.participant);
			if (!p) throw new Error(`Unknown participant "${params.participant}". Participants: ${d.participants.map((x) => `@${x.name}`).join(", ")}`);

			if (checkpointDue(d)) {
				const stop = await checkpointGate(ctx, d);
				if (stop) return { content: [{ type: "text", text: stop }], details: undefined };
			}

			if (params.note?.trim()) appendSection(d, "[Moderator]", `@${p.name}\n\n${params.note.trim()}`);

			const progress = (status: string) =>
				onUpdate?.({ content: [{ type: "text", text: `@${p.name} (${agentSummary(p)}) ${status}` }], details: undefined });
			progress("is thinking…");

			const outcome = await runTurn(
				{
					agent: p.agent,
					cwd: p.cwd,
					sessionId: p.sessionId,
					model: p.model,
					thinking: p.thinking,
					instructions: participantBrief(d, p),
					message: turnMessage(p, unseenText(d, p)),
					webSearch: hasWebSearch(p),
				},
				signal,
				progress,
			);
			const reply = cleanReply(outcome.reply, p.name);
			recordTurn(ctx.cwd, d, p, reply, outcome);
			const usage = formatUsage([{ agent: p.agent, costUsd: outcome.costUsd, tokens: outcome.tokens }]);

			return {
				content: [{ type: "text", text: `[${p.name}] (turn ${d.totalTurns}, ${usage}):\n\n${reply}\n\n${statusReport(d)}` }],
				details: { discussionId: d.id, participant: p.name, turn: d.totalTurns, costUsd: outcome.costUsd, tokens: outcome.tokens },
			};
		},
	});

	pi.registerTool({
		name: "discuss_status",
		label: "Discuss: Status",
		description: "Show a discussion's progress: turns, cost, next checkpoint, and which participants are active, @-mentioned, or settled.",
		promptSnippet: "Check discussion progress and who is still active",
		defaultActive: false,
		parameters: Type.Object({ discussionId }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const d = requireDiscussion(ctx.cwd, params.discussionId);
			return { content: [{ type: "text", text: statusReport(d) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "discuss_post",
		label: "Discuss: Post comment",
		description:
			"Append a human comment (default speaker) or your own moderator question to the shared discussion. Use speaker='moderator' for your questions, never attribute them to the human. Participants see the text on their next turn; anyone it @-mentions becomes active again.",
		promptSnippet: "Record human comments and moderator questions in the discussion",
		promptGuidelines: ["Raise every moderator question in the shared discussion with speaker='moderator' before asking for an answer. Record human answers verbatim with the default human speaker."],
		defaultActive: false,
		executionMode: "sequential",
		parameters: Type.Object({
			discussionId,
			text: Type.String({ description: "The human's comment verbatim, or your moderator question. Keep @mentions." }),
			speaker: Type.Optional(Type.Union([Type.Literal("human"), Type.Literal("moderator")], { description: "Who is speaking: defaults to human. Use moderator for your own questions or comments." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const d = requireDiscussion(ctx.cwd, params.discussionId);
			appendSection(d, params.speaker === "moderator" ? "[Moderator]" : "[Human]", params.text);
			return { content: [{ type: "text", text: `Posted to ${d.docPath}.\n\n${statusReport(d)}` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "discuss_summarize",
		label: "Discuss: Summarize",
		description:
			"Append the final '## Summary' section, written by you: conclusion, decisions, open questions, and action items per participant (diagrams welcome). Use when everyone is settled or the human asks to wrap up.",
		promptSnippet: "Append the final summary to the discussion document",
		defaultActive: false,
		executionMode: "sequential",
		parameters: Type.Object({
			discussionId,
			summaryMarkdown: Type.String({ description: "Summary body in markdown, without the '## Summary' heading." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const d = requireDiscussion(ctx.cwd, params.discussionId);
			appendSection(d, "## Summary", params.summaryMarkdown);
			d.summarizedAt = new Date().toISOString();
			saveDiscussion(ctx.cwd, d);
			return { content: [{ type: "text", text: `Summary appended to ${d.docPath}.` }], details: undefined };
		},
	});
}
