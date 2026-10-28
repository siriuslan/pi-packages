/**
 * The discussion protocol: everything the LLMs are told about how a
 * discussion works (participant brief, per-turn message, moderator brief),
 * and how replies are interpreted (the happy phrase and @mentions).
 */

import * as path from "node:path";
import { AGENTS, agentSummary } from "./agents.ts";
import type { Discussion, Participant, ParticipantSpec } from "./discussion.ts";

export const HAPPY_PHRASE = "I AM HAPPY FOR NOW!!!";

/** Role participants may search the web when their agent can; project participants stick to their code. */
export function hasWebSearch(p: ParticipantSpec): boolean {
	return !p.projectDir && AGENTS[p.agent].webSearch;
}

export function isHappy(reply: string): boolean {
	return reply.includes(HAPPY_PHRASE);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if `text` @-mentions `name` (or @all / @everyone). */
export function mentions(text: string, name: string): boolean {
	return new RegExp(`(^|[^\\w@-])@(${escapeRegExp(name)}|all|everyone)(?![\\w-])`, "i").test(text);
}

/** Drop a "[name]" signature the participant may have added; the doc heading already says who spoke. */
export function cleanReply(reply: string, name: string): string {
	return reply.replace(new RegExp(`^\\s*\\[@?${escapeRegExp(name)}\\]\\s*`, "i"), "").trim();
}

/** One-line description of a participant, as other participants and the moderator see it. */
export function describe(p: Participant): string {
	const role = p.role ? p.role.trim().split("\n")[0].slice(0, 160) : "";
	if (p.projectDir) return `@${p.name} — project \`${path.basename(p.projectDir)}\` (${p.projectDir})${role ? `; role: ${role}` : ""}`;
	return `@${p.name} — role${role ? `: ${role}` : ""}`;
}

/** System-prompt addition for a participant. Constant for the whole discussion. */
export function participantBrief(d: Discussion, p: Participant): string {
	const others = d.participants.filter((o) => o !== p).map((o) => `- ${describe(o)}`);
	const role = p.role?.trim();
	const identity = p.projectDir
		? [
				`You represent the project in your working directory (${p.cwd}).`,
				`Ground what you say in that project's actual code and docs: look before you answer, and cite file paths.`,
				...(role ? [``, `Your role in this discussion:`, role] : []),
			]
		: [
				...(role ? [`Your role in this discussion:`, role, ``] : []),
				`Your working directory (${p.cwd}) may contain reference material for you (code, documents).`,
				`On your first turn, list it and read anything relevant; ground what you say in it when present.`,
			];
	return [
		`# Discussion participant: @${p.name}`,
		``,
		`You are @${p.name}, one participant in a moderated, multi-party written discussion.`,
		...identity,
		``,
		`Other participants:`,
		...others,
		`- [Human] — the person who raised the topic; they may join in at any time.`,
		`A moderator decides who speaks next; you only speak when it's your turn.`,
		``,
		`The discussion document is ${d.docPath}. Each turn you are shown everything added to it since your previous turn, so you don't need to re-read it.`,
		``,
		`Rules:`,
		`- Reply with your comment only. It is appended to the document under "[${p.name}]" automatically, so don't add a heading or signature.`,
		`- Be focused and concise, like a real discussion comment. Don't restate the discussion.`,
		`- To ask or answer a specific participant, @-mention them (e.g. @${d.participants.find((o) => o !== p)?.name ?? "someone"}). Mentions decide who speaks next. Use @Human for questions only the human can answer.`,
		`- You can read files but must not modify anything. Propose actions instead of doing them.`,
		...(hasWebSearch(p) ? [`- You can search the web. Cite the sources (URLs) of facts you take from it.`] : []),
		`- If you have nothing further to add and nobody has asked you anything, reply with exactly: ${HAPPY_PHRASE}`,
		`  Speak up again only when someone @-mentions you or new information changes your view.`,
	].join("\n");
}

/** The user message for one turn: whatever the participant hasn't seen, plus an optional moderator note. */
export function turnMessage(p: Participant, unseen: { text: string; kind: "all" | "new" | "edited" }, note?: string): string {
	const intro = {
		all: `Here is the discussion document so far:`,
		new: `New in the discussion since your previous turn:`,
		edited: `The discussion document was edited since your previous turn. Here is the full current version:`,
	}[unseen.kind];
	const body = unseen.text.trim() ? `${intro}\n\n<document>\n${unseen.text.trim()}\n</document>` : `Nothing new has been added since your previous turn.`;
	return [
		`It's your turn, @${p.name}.`,
		``,
		body,
		...(note?.trim() ? [``, `Moderator note: ${note.trim()}`] : []),
		``,
		`Reply now with your comment (or exactly "${HAPPY_PHRASE}" if you have nothing to add).`,
	].join("\n");
}

/** The message that hands the discussion to the master agent (the moderator). */
export function moderatorBrief(d: Discussion, mode: "start" | "continue"): string {
	return [
		mode === "start"
			? `Moderate the new discussion \`${d.id}\`.`
			: `Continue moderating the discussion \`${d.id}\`. Read the end of the document first to see where it stands.`,
		``,
		`Document: ${d.docPath}`,
		`Participants (agent, model and thinking level are fixed per participant):`,
		...d.participants.map((p) => `- ${describe(p)} [${agentSummary(p)}${hasWebSearch(p) ? ", web search" : ""}]`),
		``,
		`How to moderate:`,
		`1. Read the document once to understand the topic.`,
		`2. Call discuss_dispatch for exactly ONE participant at a time. Start with whoever the topic concerns most; after that, prefer participants with open @-mentions, then whoever's view is still missing. Use the optional \`note\` to steer a participant (e.g. "answer @x's question about Y").`,
		`3. Don't dispatch a settled participant (said "${HAPPY_PHRASE}" and not @-mentioned since). discuss_dispatch and discuss_status report who is settled.`,
		`4. When a reply @-mentions @Human, stop and ask me. Record my answer verbatim with discuss_post, then continue.`,
		`5. When everyone is settled, write a plain-English summary with discuss_summarize: the conclusion, decisions, open questions, and action items per participant (a diagram if it helps). Then tell me where the document is.`,
		`6. If discuss_dispatch says the human paused or asked to wrap up at a checkpoint, follow that instead of dispatching.`,
		`Never write participants' replies yourself or edit the document directly — only use the discuss_* tools.`,
	].join("\n");
}
