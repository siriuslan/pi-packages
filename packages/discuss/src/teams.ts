/**
 * Saved teams: reusable participant lists, stored globally (they are not tied
 * to one discussion folder) at <agentDir>/discussion/teams/<name>.json.
 * Role participants get a fresh workspace folder in every discussion.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ParticipantSpec, slugify, toSpec } from "./discussion.ts";

export interface Team {
	name: string;
	participants: ParticipantSpec[];
	savedAt: string;
}

function teamsDir(): string {
	return path.join(getAgentDir(), "discussion", "teams");
}

export function listTeams(): Team[] {
	const dir = teamsDir();
	if (!fs.existsSync(dir)) return [];
	const teams: Team[] = [];
	for (const f of fs.readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		try {
			const team: Team = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
			teams.push({ ...team, participants: team.participants.map(toSpec) });
		} catch {
			// ignore unreadable team files
		}
	}
	return teams.sort((a, b) => a.name.localeCompare(b.name));
}

/** Save (or overwrite) a team. The name is normalized to a slug. */
export function saveTeam(name: string, participants: ParticipantSpec[]): Team {
	const team: Team = { name: slugify(name, 60), participants: participants.map(toSpec), savedAt: new Date().toISOString() };
	fs.mkdirSync(teamsDir(), { recursive: true });
	fs.writeFileSync(path.join(teamsDir(), `${team.name}.json`), JSON.stringify(team, null, 2));
	return team;
}

export function deleteTeam(name: string): void {
	fs.rmSync(path.join(teamsDir(), `${name}.json`), { force: true });
}

export function describeTeam(t: Team): string {
	return `${t.name}: ${t.participants.map((p) => `@${p.name}`).join(", ")}`;
}
