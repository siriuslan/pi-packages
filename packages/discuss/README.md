# @siriuslan/discuss

A [pi](https://pi.dev) extension that runs a moderated, multi-round discussion between AI participants. Each participant is grounded in a
**project folder** or defined by a **role**, and runs on the agent you choose: **pi**,
**Claude Code** or **Codex**. You get one readable markdown record with a final summary and
action items.

- **Moderator** = your current pi session. It picks who speaks next and writes the summary.
- **Participants** = separate agent sessions, one per participant. Each keeps its own memory for
  the whole discussion and is read-only.
- **Record** = `discussion-docs/<id>.md`. Every reply is appended under `[name]`.

## Commands

| Command | What it does |
|---|---|
| `/discuss start [topic]` | Choose participants, create the doc, start moderating |
| `/discuss continue [id \| doc.md]` | Resume a discussion, or turn an existing markdown doc into one |
| `/discuss list` | List discussions in the current folder |
| `/discuss teams` | View or delete saved teams |
| `/discuss` | Menu |

## Participants

Add any mix of:

- **Project folder**: the participant runs *in* that folder and answers from its real code and
  docs. The tag defaults to the folder name. A role instruction is optional.
- **Role**: a tag name plus an optional role instruction (e.g. "security reviewer, skeptical of
  new dependencies"). Press Enter to leave the instruction empty. Each role gets its own
  workspace folder, `<cwd>/<YYYYMMDD-HHmm>-<topic>-<role-name>/`. Put code or documents there if
  you want the role to use them.

### Agents

Each participant has its own **agent, model and thinking level**, fixed for the whole discussion.
Setup offers each installed agent with its defaults in one click, or *Customize…* to choose the
model and thinking level.

| Agent | Default | Read-only access | Web search (role participants) | Usage shown |
|---|---|---|---|---|
| pi | `anthropic/claude-opus-5-5` · `xhigh` | tools `read, grep, find, ls` | not available | $ and tokens |
| Claude Code (`claude`) | `opus` · `xhigh` | tools `Read, Grep, Glob` | `WebSearch, WebFetch` | $ and tokens |
| Codex (`codex`) | `gpt-5.6-terra` · `xhigh` | read-only sandbox (shell commands can read, not write) | live web search | tokens only |

- **Web search** is on for role participants whose agent supports it. It is off for project
  participants, who stick to their code.
- Agents whose CLI isn't installed are hidden in setup. Claude Code and Codex use your existing
  logins.
- Discussions and teams saved before agents were configurable run on pi.

### Teams

At the end of setup you can save the participants as a team and load it next time.
Teams are global: `~/.pi/agent/discussion/teams/<name>.json`. Role participants get a fresh
workspace in every discussion.

## How a discussion runs

1. Participants are shown only what's new in the doc since their previous turn.
2. They @-mention each other (or `@Human`) to ask questions. A mention makes that participant
   active again.
3. A participant with nothing more to add replies `I AM HAPPY FOR NOW!!!` and is "settled".
4. When everyone is settled, the moderator appends `## Summary` with decisions and action items.

**Checkpoint:** every N turns (default: participants × 3, set during setup) you are asked to
continue, pause to add something, or wrap up.

## Files

```
<cwd>/
├── discussion-docs/<id>.md          # the transcript
├── .pi/discussion/<id>.json         # state: participants, agents, sessions, turns, usage
└── <id>-<role-name>/                # one workspace per role participant
```

## Requirements

- pi 1.3.0 or later (tested with 1.3.0).
- Optional: the [Claude Code](https://github.com/anthropics/claude-code) CLI (`claude`) and/or the
  [Codex](https://github.com/openai/codex) CLI (`codex`), installed on your `PATH` and logged in,
  for participants that run on them. Without them, every participant runs on pi.

## Install

```bash
pi install npm:@siriuslan/discuss
```

To pin a version, or try it for a single session without installing:

```bash
pi install npm:@siriuslan/discuss@0.1.0
pi -e npm:@siriuslan/discuss
```

It also lives in the [siriuslan/pi-packages](https://github.com/siriuslan/pi-packages) repository;
installing that repository from git loads this extension along with the other packages.

## Security

This is an extension: pi runs its code with your user's permissions. It starts one agent
process (`pi`, `claude` or `codex`) per participant turn, in the participant's folder.
Participants are limited to read-only tools (Codex: its read-only sandbox, which still lets shell
commands read files anywhere); role participants on Claude Code or Codex can search the web.
The extension itself writes only the discussion files listed above and saved teams.

## Development

Load a local checkout in place, so edits apply after `/reload`:

```bash
pi install /path/to/pi-packages/packages/discuss
```

Or try it for one session: `pi -e /path/to/pi-packages/packages/discuss`.

## License

MIT; see [LICENSE](LICENSE).
