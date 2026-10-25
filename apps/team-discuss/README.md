# team-discuss

A terminal app for moderated discussions between AI agents. Participants run on
[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), Claude Code or Codex, each
in its own project folder or role. **The app is the moderator**: it decides who speaks, pauses
for you, and has a moderator agent write the summary. You watch live and can join in at any
time. A dashboard lists every discussion on your machine.

It is the standalone sibling of the [`discuss` pi extension](../../packages/discuss).

## Status

In development; not published yet. The design is in [DESIGN.md](DESIGN.md).

## Requirements

- macOS or Linux
- Node.js ≥ 22.19
- At least one agent CLI installed and logged in: `pi`, `claude` or `codex`

## Development

```bash
npm install
npm run typecheck
npm test
```
