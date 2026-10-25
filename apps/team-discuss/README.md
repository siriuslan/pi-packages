# team-discuss

A terminal app for moderated discussions between AI agents. Participants run on
[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), Claude Code or Codex, each
in its own project folder or role. **The app is the moderator**: it decides who speaks, pauses
for you, and has a moderator agent write the summary. You watch live and can join in at any
time. A dashboard lists every discussion on your machine.

It is the standalone sibling of the [`discuss` pi extension](../../packages/discuss).

## Status

In development; not published yet. The design is in [DESIGN.md](DESIGN.md).

Currently **only pi's participant and moderator seats are verified and offered**. Claude's
login now works, but its CLI can write project MCP approval settings on startup even without
tools. Codex's tested model cannot read files with the provisional limits. Both remain
unavailable rather than weakening those limits. Results and remaining checks are in
[PROBES.md](PROBES.md).

## Requirements

- macOS or Linux
- Node.js ≥ 22.19
- A verified agent CLI installed and logged in (currently `pi`; see Status above)

## Development

```bash
npm install
npm run typecheck
npm test
```

`npm test` uses fake CLIs and never spends tokens. Real-agent capability probes are
separate and **spend tokens**:

```bash
npm run test:agents
# Narrow a rerun to selected CLIs:
TEAM_DISCUSS_PROBE_AGENTS=pi,claude npm run test:agents
```

The probes test the production adapters, including fresh/resumed sessions, participant
write attempts inside/outside the workspace, MCP startup canaries with positive controls,
and tool-free moderators. Codex is probed even while it is unavailable in the app; a failed
probe is not converted into a pass or silently skipped. Missing CLIs are reported as skips;
installed but unauthenticated CLIs fail.

Each probe uses a private temporary workspace and config home, copies saved credentials
(not symlinks), and removes them after cleanup. On macOS, Claude's default Keychain login is
read into the temporary credential file; its contents never go to logs or command arguments.
Original settings/MCP configuration files are not edited; the fixture checks selected source
files for changes (not the whole home directory or Keychain). These are live provider requests:
credential refreshes and account-side effects are not isolated. SIGKILL or power loss can
leave private temporary credential copies behind; see [PROBES.md](PROBES.md#scope-and-cleanup).
A revoked Claude login needs `claude auth login` before retrying, but the current capability
blocker is a startup write, not authentication. Logging in does not by itself enable a seat.

Provider-only pi extensions must be supplied explicitly rather than loading all of your
usual extensions. For example, if your Anthropic login needs `pi-anthropic-auth`:

```bash
TEAM_DISCUSS_PROBE_PI_EXTENSIONS='["/absolute/path/to/pi-anthropic-auth/src/index.ts"]' \
  TEAM_DISCUSS_PROBE_AGENTS=pi npm run test:agents
```

Optional overrides: `TEAM_DISCUSS_PROBE_PI_MODEL`, `TEAM_DISCUSS_PROBE_CLAUDE_MODEL`,
`TEAM_DISCUSS_PROBE_CODEX_MODEL` (otherwise app defaults), `TEAM_DISCUSS_PROBE_THINKING`
(default `low`), and `TEAM_DISCUSS_PROBE_CLAUDE_CREDENTIALS` (an existing credential-file path,
for a nonstandard login location). Do not put credential values in these variables. Turns
have a two-minute timeout; interruption awaits process cleanup before removing temp files.
