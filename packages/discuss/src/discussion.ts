/**
 * Discussion store — owns the on-disk layout and state of a discussion.
 *
 *   <root>/discussion-docs/<id>.md      shared transcript (the human-readable record)
 *   <root>/.pi/discussion/<id>.json     sidecar state (participants, sessions, counters)
 *   <root>/<id>-<name>/                 workspace folder of each role participant
 *
 * <id> is "<YYYYMMDD-HHmm>-<topic-slug>", so role workspaces are named
 * "<date-time>-<discussion>-<role-name>". Callers never build these paths
 * themselves: they create/load a Discussion and use the functions below.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENTS, type AgentId, agentSummary, isAgentId, type TurnOutcome } from "./agents.ts";
import { hasWebSearch, isHappy, mentions } from "./protocol.ts";

/** Checkpoint interval used when none is given: three turns per participant. */
export function defaultCheckpointEvery(participantCount: number): number {
	return Math.max(1, participantCount * 3);
}

/** What the user specifies for one participant. This is also the unit saved in teams. */
export interface ParticipantSpec {
	/** Tag used in the doc ("[name]") and for @mentions. Lowercase slug. */
	name: string;
	/** Absolute project folder. Present → project participant; absent → role participant with its own workspace. */
	projectDir?: string;
	/** Role instruction. Required for role participants, optional for project participants. */
	role?: string;
	/** Agent CLI this participant runs on. Fixed for the whole discussion. */
	agent: AgentId;
	/** Model as the agent names it (e.g. "anthropic/claude-opus-5-5" for pi, "opus" for Claude Code). Fixed. */
	model: string;
	/** Thinking / effort level as the agent names it. Fixed. */
	thinking: string;
}

export interface Participant extends ParticipantSpec {
	/** Where this participant's agent runs: projectDir, or the role's workspace folder. */
	cwd: string;
	/** The agent's persistent session; set after the participant's first successful turn. */
	sessionId?: string;
	turns: number;
	/** Last reply contained the happy phrase. */
	happy: boolean;
	/** Bytes of the doc already shown to this participant, and a hash of them (to detect edits). */
	seenBytes: number;
	seenHash: string;
	/** Dollar cost, when the agent reports it (see AgentInfo.reportsCost). */
	costUsd: number;
	tokens: number;
}

export interface Discussion {
	id: string;
	/** Absolute path of the shared doc. */
	docPath: string;
	createdAt: string;
	/** Ask the human every N completed turns. */
	checkpointEvery: number;
	nextCheckpointAt: number;
	totalTurns: number;
	participants: Participant[];
	log: Array<{ turn: number; participant: string; at: string; costUsd: number; tokens: number }>;
	summarizedAt?: string;
}

const DOCS_DIR = "discussion-docs";
const STATE_DIR = path.join(".pi", "discussion");
export const RESERVED_NAMES = new Set(["human", "all", "everyone", "moderator"]);

export function slugify(text: string, max = 40): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/g, "");
}

/**
 * Just the spec fields of a participant, normalized. Data saved before agents
 * were configurable has no `agent`; those participants ran on pi.
 */
export function toSpec(p: Omit<ParticipantSpec, "agent"> & { agent?: unknown }): ParticipantSpec {
	const { name, projectDir, role, model, thinking } = p;
	const agent = isAgentId(p.agent) ? p.agent : "pi";
	return { name, ...(projectDir ? { projectDir } : {}), ...(role ? { role } : {}), agent, model, thinking };
}

function readState(file: string): Discussion {
	const d: Discussion = JSON.parse(fs.readFileSync(file, "utf8"));
	d.participants = d.participants.map((p) => ({ ...p, ...toSpec(p), tokens: p.tokens ?? 0 }));
	return d;
}

function stateFile(root: string, id: string): string {
	return path.join(root, STATE_DIR, `${id}.json`);
}

function localStamp(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function firstLine(text: string): string {
	return text.trim().split("\n")[0].trim();
}

function sha1(data: Buffer): string {
	return crypto.createHash("sha1").update(data).digest("hex");
}

/**
 * Create a discussion: a brand-new doc for `topic`, or adopt an existing doc
 * (e.g. a hand-written one). Creates role workspaces and saves state.
 */
export function createDiscussion(
	root: string,
	source: { topic: string } | { existingDoc: string },
	specs: ParticipantSpec[],
	checkpointEvery = defaultCheckpointEvery(specs.length),
): Discussion {
	const label = "topic" in source ? firstLine(source.topic) : path.basename(source.existingDoc, ".md");
	let id = `${localStamp()}-${slugify(label) || "discussion"}`;
	for (let n = 2; fs.existsSync(stateFile(root, id)); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;

	const docPath =
		"topic" in source ? path.join(root, DOCS_DIR, `${id}.md`) : path.resolve(root, source.existingDoc);

	const participants: Participant[] = specs.map((spec) => {
		const cwd = spec.projectDir ?? path.join(root, `${id}-${spec.name}`);
		if (!spec.projectDir) fs.mkdirSync(cwd, { recursive: true });
		return { ...toSpec(spec), cwd, turns: 0, happy: false, seenBytes: 0, seenHash: "", costUsd: 0, tokens: 0 };
	});

	const d: Discussion = {
		id,
		docPath,
		createdAt: new Date().toISOString(),
		checkpointEvery,
		nextCheckpointAt: checkpointEvery,
		totalTurns: 0,
		participants,
		log: [],
	};

	if ("topic" in source) {
		fs.mkdirSync(path.dirname(docPath), { recursive: true });
		fs.writeFileSync(docPath, renderHeader(d, source.topic));
	}
	saveDiscussion(root, d);
	return d;
}

function renderHeader(d: Discussion, topic: string): string {
	const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
	const rows = d.participants.map((p) => {
		const role = p.role ? cell(firstLine(p.role)).slice(0, 120) : "—";
		const kind = p.projectDir ? "project" : hasWebSearch(p) ? "role (web)" : "role";
		return `| @${p.name} | ${kind} | \`${p.cwd}\` | ${role} | ${agentSummary(p)} |`;
	});
	return [
		`# Discussion: ${firstLine(topic).slice(0, 100)}`,
		``,
		`> Started ${new Date().toLocaleString()} · moderated by pi · id \`${d.id}\``,
		``,
		`## Participants`,
		``,
		`| Tag | Kind | Workspace | Role | Agent |`,
		`|---|---|---|---|---|`,
		...rows,
		``,
		`---`,
		``,
		`[Human]`,
		``,
		topic.trim(),
		``,
	].join("\n");
}

export function saveDiscussion(root: string, d: Discussion): void {
	const file = stateFile(root, d.id);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(d, null, 2));
}

/** All discussions under `root`, newest first. */
export function listDiscussions(root: string): Discussion[] {
	const dir = path.join(root, STATE_DIR);
	if (!fs.existsSync(dir)) return [];
	const all: Discussion[] = [];
	for (const f of fs.readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		try {
			all.push(readState(path.join(dir, f)));
		} catch {
			// ignore unreadable state files
		}
	}
	return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Find a discussion by id or by the path of its doc. */
export function loadDiscussion(root: string, ref: string): Discussion | undefined {
	const file = stateFile(root, ref.trim());
	if (fs.existsSync(file)) return readState(file);
	const abs = path.resolve(root, ref.trim());
	return listDiscussions(root).find((d) => d.docPath === abs);
}

/** Look up a participant by name; tolerates a leading "@" and case differences. */
export function findParticipant(d: Discussion, name: string): Participant | undefined {
	const wanted = name.trim().replace(/^@/, "").toLowerCase();
	return d.participants.find((p) => p.name === wanted);
}

/**
 * The part of the doc this participant has not been shown yet.
 * kind: "all" on their first turn, "new" normally, "edited" if earlier
 * content changed since their last turn (then `text` is the whole doc).
 */
export function unseenText(d: Discussion, p: Participant): { text: string; kind: "all" | "new" | "edited" } {
	const doc = fs.readFileSync(d.docPath);
	if (p.seenBytes === 0) return { text: doc.toString("utf8"), kind: "all" };
	const prefixIntact = doc.length >= p.seenBytes && sha1(doc.subarray(0, p.seenBytes)) === p.seenHash;
	if (!prefixIntact) return { text: doc.toString("utf8"), kind: "edited" };
	return { text: doc.subarray(p.seenBytes).toString("utf8"), kind: "new" };
}

/** Settled = said the happy phrase and nobody has @-mentioned them since. */
export function isSettled(d: Discussion, p: Participant): boolean {
	return p.happy && !mentions(unseenText(d, p).text, p.name);
}

/** Append one section ("---", heading, body) to the doc. */
export function appendSection(d: Discussion, heading: string, body: string): void {
	// Exactly one blank line before "---"; without it, "---" right after text would turn that text into a heading.
	const doc = fs.readFileSync(d.docPath, "utf8");
	const gap = doc.endsWith("\n\n") ? "" : doc.endsWith("\n") ? "\n" : "\n\n";
	fs.appendFileSync(d.docPath, `${gap}---\n\n${heading}\n\n${body.trim()}\n`);
}

/** Record a completed participant turn: append the reply to the doc, update session and counters, save. */
export function recordTurn(
	root: string,
	d: Discussion,
	p: Participant,
	reply: string,
	{ sessionId, costUsd, tokens }: Pick<TurnOutcome, "sessionId" | "costUsd" | "tokens">,
): void {
	appendSection(d, `[${p.name}]`, reply);
	const doc = fs.readFileSync(d.docPath);
	p.seenBytes = doc.length;
	p.seenHash = sha1(doc);
	p.turns += 1;
	p.happy = isHappy(reply);
	p.sessionId = sessionId;
	p.costUsd += costUsd;
	p.tokens += tokens;
	d.totalTurns += 1;
	d.log.push({ turn: d.totalTurns, participant: p.name, at: new Date().toISOString(), costUsd, tokens });
	saveDiscussion(root, d);
}

export function checkpointDue(d: Discussion): boolean {
	return d.totalTurns >= d.nextCheckpointAt;
}

/** The human has been consulted; schedule the next checkpoint. */
export function passCheckpoint(root: string, d: Discussion): void {
	d.nextCheckpointAt = d.totalTurns + d.checkpointEvery;
	saveDiscussion(root, d);
}

/** "$1.23 · 45k tokens"; agents that don't report cost show tokens only. */
export function formatUsage(items: Array<{ agent: AgentId; costUsd: number; tokens: number }>): string {
	const cost = items.reduce((sum, p) => sum + p.costUsd, 0);
	const tokens = items.reduce((sum, p) => sum + p.tokens, 0);
	const k = tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
	const costs = items.some((p) => AGENTS[p.agent].reportsCost) ? `$${cost.toFixed(2)} · ` : "";
	const noCost = [...new Set(items.filter((p) => !AGENTS[p.agent].reportsCost && p.tokens > 0).map((p) => AGENTS[p.agent].label))];
	const note = costs && noCost.length ? ` (${noCost.join(", ")} cost not reported)` : "";
	return `${costs}${k} tokens${note}`;
}
