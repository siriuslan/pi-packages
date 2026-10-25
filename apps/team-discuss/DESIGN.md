# team-discuss — Design

Status: **draft v3**, updated after two reviews ([REVIEW.md](REVIEW.md) and the review of
v2; see §14). Awaiting approval. No code yet.

A standalone terminal app for moderated, multi-participant AI discussions, like the
[`discuss` pi extension](../../packages/discuss), but here **the app is the moderator** and the
human watches and joins in from a dashboard.

## 1. Goals and scope

**v1 goals**
- Dashboard listing **all discussions on the machine** (global), plus *Start new*.
- Global, reusable **participant profiles** and **teams**.
- Participants run on **pi, Claude Code or Codex**, each with its own model and thinking level
  (same as the extension), as far as each agent's limits are verified (§6.1).
- **The app moderates:** it picks who speaks, runs turns, pauses for the human, and has a
  **moderator agent** write the summary.
- The human **watches live and can join in** at any time: comment, pause, give someone the
  floor, mute, wrap up.

**Non-goals for v1**
- Interop with the extension's per-folder discussions (D3), including importing its saved teams.
- Background runs: a discussion runs only while its view is open (D7).
- Editing the transcript by hand: it is generated from the event log (D9).
- Windows (D11).
- Renaming profiles, cost budgets, an LLM that picks speakers ("smart moderator"),
  exporting transcripts into a project. All possible later without model changes.

## 2. Decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Where data lives | `~/.team-discuss` (override: `TEAM_DISCUSS_HOME`, `~` expanded), on a local disk, private to the OS user (§6.4) |
| D2 | Role participants' workspace | One per **profile**, reused across discussions. Safe to share: participants can't write, and agents keep their sessions elsewhere (§6.1) |
| D3 | Relation to the extension | **Separate.** Its own store; the extension is untouched |
| D4 | TUI library | `@earendil-works/pi-tui` (pinned) |
| D5 | Moderator | App rules for routine choices + a moderator **agent** with **no tools** (pi or Claude Code) for the summary |
| D6 | Runtime and install | Node ≥ 22.19; published to npm as `@siriuslan/team-discuss`, command `team-discuss` (§10) |
| D7 | Run lifetime | A discussion runs only while its view is open; leaving the view stops it |
| D8 | Summary | Written automatically when everyone is settled |
| D9 | Storage | An **append-only event log** per discussion, one file per event, is the only source of truth. Committing an event can't be done twice for the same number (§4.3). State and `transcript.md` are derived from the log. |
| D10 | Human comments | Posting a comment always continues the discussion (§5.3) |
| D11 | Platforms | macOS and Linux in v1 (§6.3) |
| D12 | Agent sessions | Disposable: a seat resumes a session only if it holds nothing but committed turns (§6.2) |

Because of D3, the core lives **inside the app** (`src/core/`), not in a shared package. The
agent adapters and protocol are **ported** from `packages/discuss/src` at commit `8a774fc`.
That duplication is a known cost: fixes to adapters must be copied by hand until the two
are brought together (§12).

## 3. Concepts

| Concept | What it is | Scope | Identity |
|---|---|---|---|
| **Profile** | A reusable participant: `@name`, project folder *or* role text, default agent/model/thinking | Global | `name` (unique slug) |
| **Team** | A named list of profile names | Global | `name` |
| **Discussion** | Topic, moderator, participants, and everything that happened, as an event log | Global | `id` = `YYYYMMDD-HHmm-<topic-slug>`, plus `-2`, `-3`… if taken |
| **Seat** | Something that takes turns in one discussion: agent choice + working folder, plus (derived) its session, what it has seen, its usage | Per discussion | — |
| **Participant** | A seat holding a **frozen copy** of a profile | Per discussion | `name` |
| **Moderator** | A seat whose only job is writing summaries | Per discussion | — |

Rules:
- **A profile is a template; a participant is a snapshot.** Editing a profile only affects new
  discussions. Deleting one never breaks history. The participant → discussions view matches
  by name.
- **Agent sessions belong to a seat, never to a profile.** Memory is not carried from one
  discussion to another. That would leak context between topics and grow without bound.
- Agent/model/thinking come from the profile and can be **overridden per discussion** in
  setup. They are then fixed for that discussion (agent sessions can't change model safely).

## 4. Storage

### 4.1 Layout

```
~/.team-discuss/                      folders 0700, files 0600
├── config.json                       defaults (moderator agent, checkpoint factor)
├── participants/<name>/
│   ├── profile.json
│   └── workspace/                    role profiles only: reference material, reused (D2)
├── teams/<name>.json
└── discussions/<id>/
    ├── events/                       the record: 000001.json, 000002.json, … (§4.3)
    ├── transcript.md                 generated from events/, for reading
    └── .lock                         which window runs it (§4.4)
```

- One folder per discussion: delete, archive or copy a discussion as a single folder.
- Project participants still **run in their project folder**. Only the record lives here.
- **Local disk only.** The commit rule (§4.3) and the lock's process check (§4.4) assume a
  local filesystem. `TEAM_DISCUSS_HOME` must not point at a network or cloud-synced folder.
- **New discussion IDs:** the folder is created with a plain `mkdir`, which fails if it
  already exists. On failure the app tries `-2`, `-3`, and so on. Two windows can never
  share a folder, even when the same topic is started in the same minute.
- `config.json`, profiles, teams and `transcript.md` are written atomically (temp file +
  rename). Events are committed as in §4.3.
- No database or index: the dashboard replays every event log. If that ever gets slow, add
  a cache that can always be rebuilt from the logs.

### 4.2 Config, profiles, teams

```ts
interface AgentChoice { agent: "pi" | "claude" | "codex"; model: string; thinking: string }

// config.json
interface Config {
  moderator: AgentChoice;            // default moderator for new discussions (pi or claude, §6.1)
  checkpointPerParticipant: number;  // checkpoint every N = participants × this (default 3)
}

// participants/<name>/profile.json
interface Profile extends AgentChoice {
  name: string;                      // @tag; lowercase slug; not human/all/everyone/moderator
  projectDir?: string;               // present → project participant
  role?: string;                     // required for role participants, optional for project ones
  createdAt: string; updatedAt: string;
}

// teams/<name>.json
interface Team { name: string; members: string[]; savedAt: string } // profile names
```

### 4.3 The event log: `events/`

The log is the **only source of truth** for a discussion. Each event is a small JSON file named
by its sequence number (`000001.json`, `000002.json`, …). Once committed, an event file is
never changed or deleted.

```ts
type Event = { seq: number; at: string } & (                 // seq matches the file name
  | { type: "created"; topic: string; checkpointEvery: number;
      moderator: SeatConfig; participants: ParticipantConfig[] }  // always seq 1
  | { type: "human"; text: string }                          // a comment (the topic is in "created")
  | { type: "attempt"; seat: string }                        // a turn or summary is starting (§6.2)
  | { type: "turn"; speaker: string; reply: string; sessionId: string; costUsd: number; tokens: number }
  | { type: "summary"; text: string; sessionId: string; costUsd: number; tokens: number }
  | { type: "resume" }                                       // the human let it continue: /resume, /next, /wrap
  | { type: "mute"; name: string; muted: boolean }
  | { type: "reset"; name: string }                          // forget name's agent session
);
interface SeatConfig extends AgentChoice { cwd: string }     // where the agent runs
interface ParticipantConfig extends SeatConfig {             // snapshot of the profile
  name: string; projectDir?: string; role?: string;
}
```

**Committing an event.** This is the only way a discussion changes:
1. Write the event to a temp file inside `events/` (`.tmp-<token>-<seq>`) and fsync it.
2. `link()` the temp file to `<seq>.json`. **This is the commit.** `link` fails if the name
   already exists, so each sequence number can be committed only once. A writer commits
   `seq` only after reading up to `seq − 1`, so every committed event was written with
   knowledge of every event before it.
3. fsync the folder, then delete the temp file.

Consequences:
- **Number already taken:** another writer committed first, so our event is not committed.
  The writer reloads the log. If the lock is no longer its own, it stops (`LockLost`).
  Otherwise it continues from the reloaded state, and an uncommitted turn is discarded (§6.2).
- **Failures after the `link()` never undo the commit.** Deleting the temp file or regenerating
  `transcript.md` can fail, but those failures are warnings, never failed turns. The caller
  must not retry the turn.
- **No partial records.** A crash before the `link()` leaves only a temp file. Readers ignore temp
  files, and the next lock holder deletes them.
- **No silent repair.** A malformed event, a number that doesn't match its file name, or a gap
  is not skipped or fixed. The discussion opens read-only and names the bad file. This only
  happens if someone edited or deleted files by hand, or after a power cut.
- **Durability.** A committed event survives an app or OS crash. A sudden power cut can still
  lose, or rarely damage, the most recent events on drives that cache writes. For example,
  `fsync` on macOS doesn't flush the drive's cache.

Everything else is **computed by replaying the events**:

| Derived value | Rule |
|---|---|
| A seat's session | `sessionId` of the `turn` (or `summary`) that completed its latest `attempt`, if no `reset` came after. Otherwise none: the next turn starts a fresh session (§6.2). |
| What a seat has seen | With a session: everything up to that `turn`/`summary`. Without one: nothing, so the next turn gets the whole discussion. |
| Speaking now | The latest `attempt`, if it isn't completed yet and the lock is held |
| Last attempt failed | The seat's latest `attempt` was never completed and nobody is running it now |
| Turns, cost, tokens | Totals over its `turn` (or `summary`) events. Uncommitted attempts aren't counted. |
| Happy | Its latest reply contains the happy phrase |
| Muted | Its latest `mute` event |
| Mentioned | The first event after its latest turn that mentions it (§5.1) |
| Total turns | Number of `turn` events |
| Turns since the human | `turn` events after the latest `human` or `resume` event (§5.6) |
| Summarized | The latest `human`/`turn`/`summary` event is a summary |
| Previous speaker | Speaker of the latest `turn` event. Human comments and summaries don't count. |

**`transcript.md`** is generated from the log. It is rewritten (temp file + rename) after every
`created`, `human`, `turn` and `summary` event. It records the last event number it includes,
and is regenerated on open if it is missing or behind.
- Layout: the extension's (header, participants table, `[Human]` topic, `---` + `[name]`
  sections, `## Summary`). Other events aren't shown.
- It starts with a note that it is generated, so hand edits are overwritten.

### 4.4 The lock: `.lock`

The lock decides **which window runs a discussion**, so that two windows don't run turns, and
spend money, on the same discussion. It is **not** what keeps the log consistent. The commit
rule in §4.3 does that, even if two windows briefly both believe they hold the lock.

```ts
interface Lock { pid: number; token: string; acquiredAt: string } // token: random UUID
```

| Step | Rule |
|---|---|
| Acquire | Create `.lock` exclusively (`open(…, "wx")`, mode 0600). If that succeeds, we hold it. |
| Lock exists | Read it. It counts as **stale** only if `process.kill(pid, 0)` reports no such process. A stale lock is deleted and acquiring is tried once more. A live pid (including one we may not signal) or an unreadable file counts as **held**, and the discussion opens read-only. |
| Take over | Only explicitly: the human confirms `/takeover` in the read-only view. This replaces `.lock` with ours (temp file + rename). |
| Holder checks | Before every attempt and every commit, the holder compares tokens. If the token differs or the file is gone, it throws `LockLost`: the run stops, a running turn is stopped and discarded, and the view turns read-only. |
| Release | On close or quit, delete `.lock` only if it still holds our token. If that fails, the lock is left stale and is reclaimed automatically next time. |

Remaining races, and why they're harmless:
- **Reused pid:** if a dead holder's pid is reused by another process, the holder looks alive.
  The discussion opens read-only, and `/takeover` gets it going again.
- **Two runners:** two windows can briefly both run the same discussion, either because both
  reclaimed the same stale lock at once, or because a takeover happened while the old holder
  was mid-turn. Their commits still can't overlap (§4.3). The loser stops at its next check
  or conflict, and the worst case is one wasted turn.

### 4.5 Status on the dashboard (derived, never stored)

| Status | Rule |
|---|---|
| damaged | The log fails validation (§4.3) |
| running | `.lock` is held (not stale, §4.4) |
| summarized | The latest content event is a summary |
| new | No turns yet |
| paused | Anything else |

A crash can't leave a stale "running" behind.

## 5. Moderation

### 5.1 Mentions and "settled"

`protocol.ts` owns the mention syntax, and `discussion.ts` applies it to events:
- `@name` is case-insensitive and must not be followed by a letter, digit or `-`.
  `@all` and `@everyone` mention every participant.
- Mentions inside **code blocks, inline code and quoted lines** (`> …`) are ignored, so
  `` `@siriuslan/team-discuss` `` or a quoted earlier question doesn't wake anyone.
- Mentions **count** in human comments (including the topic) and in *other* participants'
  replies. They **don't count** in a participant's own reply or in summaries. A summary's
  action items ("@x will…") must not restart the discussion.
- A human comment that mentions nobody is addressed to everyone, so it counts as `@all`.
- `@human` in a participant's reply pauses the run (`mention-human`). `@all` doesn't.
- A participant is **settled** when their latest reply has the happy phrase and nobody has
  mentioned them since.

### 5.2 Who speaks next: `nextSpeaker()`

`nextSpeaker()` is a pure function of the discussion and the current floor request, with
table tests. Candidates are participants who aren't muted or settled. It picks the first match:
1. The participant the human **gave the floor** to (`/next`), even if muted or settled. This
   gives them exactly one turn.
2. A candidate **mentioned** since their last turn, earliest mention first (ties in setup order).
3. A candidate who **hasn't spoken** yet, in setup order.
4. The candidate whose **last turn is oldest**. Only participant turns count, so the previous
   speaker never goes twice in a row unless someone asked them or nobody else is left.
5. No candidates → **summary** (§5.5).

### 5.3 The loop (in `DiscussionRun`)

```
loop while running:
  commit queued comments                 (one "human" event each)
  /pause or interrupt requested?         → pause (human)
  /wrap requested?                       → summary → pause (summarized)
  checkpoint due (§5.6)?                 → pause (checkpoint)
  pick = nextSpeaker(floor)
  none?                                  → summary if anything was added since the last one
                                           → pause (summarized)
  commit "attempt"; run pick's turn      → failed: nothing more committed → pause (turn-failed)
  commit "turn"
  reply mentions @Human?                 → pause (mention-human)

summary = commit "attempt" for the moderator; run it; commit "summary"
```

**A comment always means "carry on" (D10).** Before any automatic pause (checkpoint,
mention-human, turn-failed, summarized), the loop checks for pending human input: queued
comments or a `/next`. If there is any, it applies it and continues instead of pausing.
Only an explicit `/pause` or interrupt beats comments queued during the same turn.

### 5.4 Human commands

| Command | While paused | While running (a turn or summary in progress) |
|---|---|---|
| Comment (Enter) | Committed, then the discussion continues | Queued; committed right after the current turn, then it continues |
| `/resume` | Continues (`resume` event) | — |
| `/pause` (Esc) | — | Stops after the current turn; comments queued in that turn are still committed |
| Interrupt (Esc Esc) | — | Stops the turn now; it is never committed; paused |
| `/next @x [note]` | `@x` speaks next, then normal order resumes (`resume` event). The note goes only to `@x` and isn't recorded. | Same, after the current turn |
| `/mute @x`, `/unmute @x` | Applied (`mute` event) | Applied now; if `@x` is speaking, that turn still finishes and is committed |
| `/reset @x` | Applied (`reset` event): `@x`'s next turn starts a fresh session with the whole discussion | Applied after the current turn |
| `/wrap` | Summary now (`resume` event), skipping any checkpoint | Summary after the current turn and any queued comments |
| `/back` | Leaves | Confirms, interrupts, leaves |

The read-only view (§8) only allows scrolling, `/takeover` and `/back`.

### 5.5 Summary

- The moderator is a seat like any participant: it has a session, tracks what it has seen,
  and has its own usage. It runs with **no tools** (§6.1).
- Its first summary gets the whole discussion; a later one gets only what's new.
- It is committed as a `summary` event (`## Summary` in the transcript), and only if
  something was added since the last summary, so there are never two summaries in a row.
  Mentions in it don't wake anyone.
- A **summarized discussion can always continue**: a comment, `/next` or `/resume` carries on.
  "Reopening" needs no special handling.
- The summary covers: conclusion, decisions, open questions, action items per participant,
  and diagrams where helpful.

### 5.6 Checkpoints

- `checkpointEvery` is at least 1, set in setup. Default: participants × `checkpointPerParticipant` (3).
- A checkpoint is due when the participant turns since the human's latest comment or
  go-ahead (`human` or `resume` event) reach `checkpointEvery`. So any go-ahead passes it:
  a comment, `/resume`, `/next` or `/wrap`. Uncommitted attempts and summaries don't count.
- At a checkpoint the run only pauses; it doesn't summarize.
- Checkpoints limit turns, not money. The status bar shows the running cost (tokens only for
  Codex, which doesn't report cost), and setup shows each seat's model.

## 6. Agents, permissions and trust

`agents.ts` keeps the extension's single operation,
`runTurn(request, signal, onProgress) → { reply, sessionId, costUsd, tokens }`, with these changes:
- **pi is started from `PATH`** (`pi`, or `TEAM_DISCUSS_PI_BIN`). The extension re-runs
  `process.argv[1]`; inside this app that would start the app again.
- `isAgentInstalled()` checks `PATH` for **all** agents, pi included.
- pi's model list comes from `pi --list-models` (cached). Typing any model name still works.
- The request names the seat kind, `"participant"` or `"moderator"`, and the adapter applies
  that kind's limits (§6.1). The limits are always applied; `runTurn` itself doesn't decide
  who may take a seat, so the probes (§10) can test a combination before it is offered.
- `unavailableReason(agent, kind)` says why an agent can't take that seat on this machine
  (not eligible, not installed, Codex's feature list unreadable), or nothing if it can. Setup
  offers only agents without a reason, and `DiscussionRun` asks again before every attempt.
- The message goes to every CLI on **stdin**. Linux caps a single argument at 128 KB, and a
  whole discussion can be bigger than that.
- Turns run in their own process group (§6.3).

### 6.1 What each agent may do, and where it is offered

**The safety contract:**
- **Participants can read but not change anything, and can't reach MCP servers.**
- **The moderator has no tools at all.**
- **These limits fail closed:** an agent is offered for a seat kind only where its limits are
  verified, and a turn whose limits can't be applied fails before it starts.

| Agent | Participant: read-only, no MCP | Moderator: no tools |
|---|---|---|
| pi | **Offered.** `--tools read,grep,find,ls --exclude-tools 'mcp__*' --no-mcp`. The allowlist turns off every built-in and extension tool not named, and `--exclude-tools` turns off MCP tools by name. `--no-mcp` stops pi's built-in MCP support from even starting its servers. | **Offered.** `--no-tools --no-mcp`. pi documents `--no-tools` as turning off all built-in, extension, custom and MCP tools. |
| Claude Code | **Offered.** `--tools Read,Grep,Glob` (plus `WebSearch,WebFetch` for role participants), the same list in `--allowed-tools`, and `--strict-mcp-config` (no MCP servers). | **Offered.** `--tools "" --strict-mcp-config` |
| Codex | **Offered only if verified in step 4** (§11), with these limits: `sandbox_mode=read-only` and `approval_policy=never`; `--ignore-user-config`, so the user's MCP servers and plugins aren't loaded; and `--disable` for every enabled feature that isn't on a short allowlist. The list of enabled features comes from `codex features list` at run time, so features added by future Codex versions start out disabled. If that list can't be read, Codex isn't offered. | **Not offered.** Codex has no tool-free mode: even with its shell off, other built-in tools remain, such as `view_image`. |

- **Fail closed in practice.** pi and Claude Code take allowlists, so a tool added in a new
  version is off. A CLI that doesn't know one of these flags exits with an error, so the turn
  fails instead of running without limits. Tested versions: pi 1.4.0, Claude Code 2.1.308,
  Codex 0.156.1.
- **Remaining gaps, stated as policy:**
  - pi: a third-party extension that *replaces* pi's MCP support (such as `pi-mcp-adapter`)
    isn't stopped by `--no-mcp` and may still start its servers. Its tools still can't be
    called.
  - Codex: a future built-in tool that isn't behind a feature flag would not be caught by the
    feature allowlist. Codex's OS sandbox still blocks writes and network for anything run
    through its shell.
  - The user's own setup still applies, such as Claude Code hooks and pi extensions' event
    handlers. Extensions stay loaded because they may provide model providers.
- **Shared role workspace (D2):** participants can't write, and all three CLIs keep their
  session files under the home folder (`~/.pi/agent/sessions`, `~/.claude/projects`,
  `~/.codex/sessions`), not in the working folder. The extension's role workspaces on this
  machine are still empty after real discussions. The probes in §10 check this for every agent.

### 6.2 Agent sessions are disposable

**Invariant (D12):** a resumed session contains only committed turns, and the tool use behind them.

- Before a turn or summary starts, the run commits an `attempt` event for that seat.
- A seat resumes its session only if its latest attempt was completed by its `turn` or
  `summary`, with no `reset` after it. Otherwise its next turn starts a fresh session and gets
  the whole discussion. "Otherwise" covers every way an attempt can end without a commit:
  - the turn failed
  - the turn was stopped
  - the app crashed
  - another window took over
  - the commit lost to another writer
- This holds across crashes and windows because the attempt is in the log before the agent
  starts. No recovery step is needed on open.
- The cost: after such a failure, that participant reads the whole discussion again, and any
  files it needs, once.
- A side benefit: a read-only window sees the open attempt and can show who is speaking, and
  an attempt that crashed shows as ✗ (last attempt failed).

### 6.3 Stopping turns and cleaning up processes

- **Platforms:** macOS and Linux (D11). Process groups are a POSIX feature; on Windows the app
  exits with a message.
- Each turn runs in its own process group (`spawn(…, { detached: true })`).
- **Cleaning up a group:**
  1. Send SIGTERM to the group.
  2. Wait up to 5 s for the group to empty (`kill(-pgid, 0)` reports no such process).
  3. Send SIGKILL to the group.

  This runs whenever a turn ends, whether it finished, failed or was stopped, and even if the
  agent itself has already exited. Cleanup starts on the direct child's `exit`, not `close`:
  descendants can inherit its pipes and keep `close` from firing. After cleanup, final output
  is drained, with a 1 s limit in case an escaped descendant holds a pipe; hitting that limit
  fails the turn. Nothing remaining in the turn's process group outlives it.
- **Stopping a turn:** output after the stop is ignored, and the turn returns no reply,
  session id or usage. The open attempt makes the seat's session fresh next time (§6.2).
- **Quitting:**
  - The quit key and SIGINT, SIGTERM and SIGHUP run an async shutdown. It waits for every
    group's cleanup (5 s grace plus at most 1 s for final pipe drain), releases the lock,
    then exits. `processes.shutdown()` refuses new commands and awaits all current commands;
    CLI discovery queries use it too. The app wires the signal and quit handlers in step 10.
  - The `exit` handler is only a synchronous last resort: it sends SIGKILL to any groups left.
  - If the app is killed with SIGKILL, each agent finishes its single turn and exits on its
    own. The result is never committed.
- **Limits:** a descendant that starts its own process group or session, or hands work to a
  daemon that's already running, isn't stopped. Participants have no general shell, except
  Codex's sandboxed one, so this is unlikely.

### 6.4 Trust and data

- **Private to the OS user:** in `~/.team-discuss`, folders are 0700 and files 0600, temp files included.
- **What leaves the machine:** each turn sends the discussion so far, plus any files the agent
  reads, to that agent's model provider. The moderator gets the whole discussion.
- **All discussion text is untrusted input to every agent.** A reply, or a web page a role
  participant read, can try to steer the others (prompt injection). The contract in §6.1
  caps what that can achieve.
  - **Remaining risk:** participants can read files outside their folder, and role
    participants with web access could leak what they read through searches or fetched URLs.
- **So:** add only projects and reference material you trust and are willing to send to
  those providers. The README says this too.

## 7. Code structure and interfaces

```
apps/team-discuss/
├── package.json  tsconfig.json  README.md  DESIGN.md
├── src/
│   ├── main.ts               entry: platform check, --help/--version, open Home, start the UI
│   ├── core/                 no UI imports allowed
│   │   ├── agents.ts         run one turn on pi / Claude Code / Codex (ported); limits; eligibility
│   │   ├── processes.ts      process groups: start, clean up, shut down (§6.3)
│   │   ├── protocol.ts       briefs, turn messages, mention syntax, happy phrase (ported)
│   │   ├── lock.ts           which window runs a discussion (§4.4)
│   │   ├── discussion.ts     event log: commit, validate, replay; transcript rendering
│   │   ├── home.ts           ~/.team-discuss: layout, permissions, profiles, teams, discussions
│   │   └── moderator.ts      nextSpeaker() + DiscussionRun (the moderation loop)
│   └── ui/                   pi-tui screens; talks only to core's interfaces
│       ├── app.ts            screen stack, global keys, shutdown
│       ├── theme.ts
│       ├── dashboard.ts      tabs: Discussions · Participants · Teams
│       ├── setup.ts          new-discussion form
│       ├── profile-form.ts   team-form.ts
│       └── discussion-view.ts live (or read-only) discussion
├── scripts/smoke.sh          pack → global install into a temp prefix → run (§10)
└── test/                     node:test; core only. test/agents/: opt-in real-agent probes
```

Each core module owns one piece of knowledge, and recovery details stay inside these modules,
never in the UI:

| Module | Owns (nothing else knows it) |
|---|---|
| `agents.ts` | CLI flags, per-seat limits and eligibility, sessions, JSON event formats |
| `processes.ts` | Process groups, signals, the cleanup timeout, shutdown |
| `protocol.ts` | What LLMs are told; happy phrase; mention syntax |
| `lock.ts` | Lock file format, staleness, take-over, the token check |
| `discussion.ts` | Event format, the commit rule, validation, replay (§4.3), what a seat has seen, transcript layout |
| `home.ts` | Directory layout, permissions, config/profile/team files, creating and listing discussions |
| `moderator.ts` | Speaking order, pause rules, the run loop |

### Key interfaces (the comments are part of the design)

```ts
// core/discussion.ts
/**
 * One discussion, replayed from its event log (§4.3). Every field is derived
 * from the events; nothing else is stored. Read-only: see LockedDiscussion.
 */
export interface Discussion {
  readonly id: string; readonly topic: string; readonly createdAt: string;
  readonly events: readonly Event[];
  readonly moderator: SeatState;
  readonly participants: readonly ParticipantState[]; // setup order
  readonly speaking?: string;           // seat with an open attempt
  readonly totalTurns: number;
  readonly turnsSinceHuman: number;
  readonly summarized: boolean;
  /** Content this seat hasn't been shown yet, rendered like the transcript ("" if none). */
  unseen(seat: string | "moderator"): string;
}
export interface SeatState extends SeatConfig {
  sessionId?: string;          // undefined → next turn starts fresh with the whole discussion (§6.2)
  seenSeq: number; costUsd: number; tokens: number;
  lastAttemptFailed: boolean;
}
export interface ParticipantState extends ParticipantConfig, SeatState {
  turns: number;
  lastTurnSeq: number;         // 0 = hasn't spoken
  happy: boolean; muted: boolean;
  mentionedSeq?: number;       // first event mentioning them since their last turn (§5.1)
  settled: boolean;            // happy and not mentioned since
}

/** A discussion this process holds the lock for: the only way to change one. */
export interface LockedDiscussion extends Discussion {
  /**
   * Commit one event (§4.3) and update the derived state. Returns once the event
   * is committed. Throws LockLost if the lock isn't ours, and Conflict if another
   * writer committed this number first (the log has been reloaded; nothing of ours
   * was committed). Transcript regeneration happens after the commit; if it fails,
   * that is reported through onWarning and never thrown.
   */
  append(event: NewEvent): Event;   // NewEvent = Event without seq/at
  onWarning(listener: (message: string) => void): () => void;
  /** Delete the lock if it is still ours. */
  release(): void;
}
```

```ts
// core/home.ts
/** The ~/.team-discuss store. Nothing else builds paths under it. Expands "~". */
export function openHome(root = process.env.TEAM_DISCUSS_HOME ?? "~/.team-discuss"): Home;

export interface Home {
  config(): Config;
  saveConfig(config: Config): void;

  profiles(): Profile[];
  /** Create or update. Validates name (slug, not reserved), projectDir (exists) and eligibility (§6.1). */
  saveProfile(profile: Profile): Profile;
  /**
   * Deletes the profile **and its workspace**, and removes it from every team.
   * The UI confirms first, naming the workspace and its file count.
   */
  deleteProfile(name: string): void;
  /** Role profiles' reusable workspace folder (created on demand). */
  workspaceOf(name: string): string;

  teams(): Team[];
  saveTeam(team: Team): Team;
  deleteTeam(name: string): void;

  /** All discussions, newest first, optionally only those `participant` took part in. Damaged ones are listed as such. */
  discussions(filter?: { participant?: string; text?: string }): DiscussionSummary[];
  /** Snapshot the profiles (with per-discussion overrides), create the folder (§4.1), commit "created". */
  createDiscussion(input: NewDiscussion): string; // → id
  /** Read-only; works while another window holds the lock. Throws DamagedDiscussion naming the bad file. */
  readDiscussion(id: string): Discussion;
  /** Throws DiscussionLocked (with the holder) unless the lock is free or stale, or `takeOver`. */
  lockDiscussion(id: string, opts?: { takeOver?: boolean }): LockedDiscussion;
  deleteDiscussion(id: string): void; // refuses while the lock is held
}
```

```ts
// core/moderator.ts
/**
 * A discussion moderated by this process: the app's moderator. Picks
 * speakers (nextSpeaker), runs their turns, pauses for the human (checkpoints,
 * @Human, failures), and has the moderator seat write the summary when everyone
 * is settled. Holds the discussion's lock until close(). The UI only calls
 * these commands and renders events; it never touches files, agents or processes.
 */
export class DiscussionRun {
  /** Locks the discussion and opens it paused ("opened"). Throws DiscussionLocked. */
  static open(home: Home, id: string, opts?: { takeOver?: boolean }): DiscussionRun;
  readonly discussion: Discussion;
  readonly phase: "paused" | "speaking" | "summarizing" | "closed";
  readonly pauseReason?: "opened" | "human" | "checkpoint" | "mention-human" | "turn-failed" | "summarized";
  on(listener: (event: RunEvent) => void): () => void;

  // Commands; their behavior in each phase is the table in §5.4.
  resume(): void;
  pause(): void;
  interrupt(): void;
  post(text: string): void;
  giveFloor(name: string, note?: string): void;
  setMuted(name: string, muted: boolean): void;
  resetSession(name: string): void;
  wrapUp(): void;
  /** Stop any turn, wait for its process group to be cleaned up, release the lock. */
  close(): Promise<void>;
}

export type RunEvent =
  | { type: "turn-start"; speaker: string; reason: string }   // reason: "mentioned by @x", "hasn't spoken"…
  | { type: "progress"; speaker: string; status: string }      // "using Read, Grep (4 tool calls)"
  | { type: "appended"; event: Event }
  | { type: "turn-failed"; speaker: string; error: string }
  | { type: "warning"; message: string }                       // e.g. transcript.md couldn't be written
  | { type: "phase" }                                          // phase/pauseReason changed
  | { type: "lock-lost" };                                     // another window took over; run is closed

/** Who speaks next, or undefined → summary. Pure; see §5.2. */
export function nextSpeaker(d: Discussion, floor?: string): { name: string; reason: string } | undefined;
```

`protocol.ts` changes from the extension:
- The moderator brief becomes a **summary brief**: system instructions for the moderator seat.
- Turn messages are either "the discussion so far" or "new since your last turn". The
  extension's "the document was edited" case no longer exists.
- Mentions follow §5.1.

## 8. UI

Full-screen (`TuiAltScreen`): the app owns scrolling and supports the mouse wheel. Every action
has a keyboard path. Keys below are tentative.

### Dashboard
```
┌ team-discuss ─────────── [Discussions]  Participants  Teams ┐
│ [+ Start new]                          filter: @sf360_      │
│ ▶ 20261024-1930-auth-redesign   12 turns  $1.84  running    │
│ ✓ 20261023-1100-api-batching     9 turns  $0.92  summarized │
│ ‖ 20261020-0915-matching-ui      4 turns  $0.31  paused     │
│ enter open · n new · d delete · / filter · tab next tab · q │
└─────────────────────────────────────────────────────────────┘
```
- **Discussions:** newest first; filter by text or `@participant`. Damaged ones show ⚠ and
  the bad file.
- **Participants:** profiles with kind, agent, number of discussions, total cost. Enter opens the
  detail view: profile, workspace path, their discussions. Actions: new, edit, delete. Delete
  asks for confirmation and names the workspace and its file count.
- **Teams:** new (choose profiles), edit, delete.

### New discussion
Fields, in order:
1. **Topic** (multi-line editor).
2. **Participants:** choose profiles (searchable), add one inline with *+ new profile*, or *load
   team*. On any row you can change agent/model/thinking **for this discussion only**.
3. **Moderator** row (default from config).
4. **Checkpoint interval** (at least 1) and **save as team**.

Only agents that are installed and **eligible** for that seat are offered (§6.1). Each row
shows its model, so cost is visible before starting. **Start** creates the discussion and runs
it immediately.

### Live discussion
```
┌ auth-redesign ─────────────────────────┬ Participants ──────┐
│ [sf360]                                 │ ▶ @sf360  speaking │
│ We batch in src/sync/queue.ts …         │   using Read (3)   │
│ @matching-ui can you confirm …          │ ● @matching-ui     │
│                                         │ ✓ @security        │
│ [matching-ui]                           │ ⊘ @legacy  muted   │
│ …                (markdown, scrollable) │ turn 8/12 · $1.12  │
├─────────────────────────────────────────┴────────────────────┤
│ running · next: @matching-ui (mentioned by @sf360)           │
│ > comment as Human…                                          │
└──────────────────────────────────────────────────────────────┘
```
- The editor is always focused: **Enter** posts a comment, and `@` autocompletes names.
- Commands (§5.4) use slash-autocomplete. **Esc** pauses and **Esc Esc** interrupts.
  PgUp/PgDn or the wheel scroll. The view follows new replies unless you scrolled up.
- Icons: ▶ speaking, ● mentioned, ○ hasn't spoken, · active, ✓ settled, ⊘ muted,
  ✗ last attempt failed.
- The status bar shows the turns until the next checkpoint, the running cost, and warnings
  (for example, "transcript.md couldn't be updated").
- **Leaving (D7):** `/back` or quitting closes the run, which waits for cleanup (§6.3) and
  releases the lock. If a turn is running, the app asks first. One app window moderates one
  discussion at a time; to run two, open a second window.
- **Read-only:**
  - If the lock is held elsewhere, the same view opens read-only and shows "running in
    another window (pid …, since …)". It refreshes when `events/` changes, shows who is
    speaking from the open attempt, and offers `/takeover` with a confirmation.
  - If this window loses its lock (`lock-lost`), it switches to read-only and says so.
  - A damaged discussion opens read-only with the error and the bad file named.

## 9. Errors and special cases

Where possible, the design makes a case impossible instead of handling it.

| Case | Handling |
|---|---|
| Human comments during a turn | **Queued** and committed after the turn. Committing mid-turn would count the comment as seen by a speaker who never saw it. |
| Turn fails (CLI error, missing project folder, lost session) | Nothing more committed; pause `turn-failed` with the error. The seat's next turn uses a fresh session (§6.2). The human can retry (`/resume` or a comment), `/next` someone else, `/mute`, or `/reset`. |
| Agent CLI missing or not eligible, or too old for a limit flag | Not offered in setup. In an existing discussion, the turn fails before starting (§6.1). |
| Crash while committing | Before the commit: only a temp file is left, which is ignored and deleted later. After: the event is committed (§4.3). |
| `transcript.md` can't be written | Warning only; the event is still committed. Regenerated on the next event or on open. |
| `transcript.md` deleted or edited | Regenerated from the log; edits are lost (D9) |
| Event file damaged, missing or edited | Discussion opens read-only as **damaged**, naming the file; nothing is repaired automatically |
| Same topic started twice in one minute | Second folder gets `-2` (§4.1) |
| Discussion locked by another window | Read-only view with `/takeover`. A stale lock is reclaimed silently (§4.4). |
| Another window took over | At the next check or commit: `LockLost`. The run stops, any running turn is stopped and discarded, and the view turns read-only. |
| Role profile deleted, old discussion continues | Its workspace is recreated empty before the next turn; the participant runs without the reference material |
| Profile edited | Discussions hold snapshots, so nothing to do. Deleting a profile removes it from teams. |
| Summarized discussion gets more input | Normal: it continues; the next summary is committed |
| Leaving the view mid-turn | Confirm, then interrupt and clean up; the discussion shows as paused |
| App killed mid-turn | Nothing committed for that turn. The agent finishes and exits on its own (§6.3), its session is fresh next time (§6.2), and the stale lock is reclaimed on next open. |

## 10. Build, install, test

### Package
- `apps/team-discuss/package.json`:
  - `name: "@siriuslan/team-discuss"`, `type: "module"`, `bin: { "team-discuss": "dist/main.js" }`
  - `files: ["dist"]`, `engines: { node: ">=22.19" }`, `os: ["darwin", "linux"]`, `license: "MIT"` (LICENSE file)
  - `private: true` until the publish step (14), so nothing can be published by accident
  - dependency `@earendil-works/pi-tui` (exact version); dev dependencies `typescript`, `esbuild`, `@types/node`
  - It stands on its own: the root `package.json` (the pi manifest) is unchanged and needs no workspaces.
- The **package name** is what people install from npm; the **command name** (`bin`) is what
  they type afterwards. The two are independent, like `@anthropic-ai/claude-code` / `claude`.
- **Dev:** `node src/main.ts` (Node ≥ 23.6 runs TypeScript directly; imports use `.ts`, as in
  the extension). Typecheck: `tsc --noEmit`.
- **Release build:**
  `esbuild src/main.ts --bundle --platform=node --format=esm --target=node22 --packages=external --outfile=dist/main.js`
  - `--bundle` pulls our own modules, including their `.ts` imports, into one file. Node
    won't run `.ts` inside `node_modules`, so this step is required.
  - `--packages=external` leaves every npm package as a normal import. pi-tui loads optional
    native add-ons (clipboard) from paths relative to its own package, and those would break
    inside a bundle. npm installs pi-tui normally instead.
  - `src/main.ts` starts with `#!/usr/bin/env node`, which esbuild keeps.
- **Publish:** `npm publish --access public` from `apps/team-discuss`; `prepublishOnly` runs
  the build, the tests and the smoke test.

### Smoke test (`scripts/smoke.sh`, from the UI-shell step on)
1. `npm pack`, then check the tarball contains only `dist/`, `package.json`, `README.md` and `LICENSE`.
2. `npm install -g --prefix <temp>` from the tarball.
3. Run `team-discuss --version` and `--help`. This proves the bin, the bundle and the pi-tui
   import work from a real install.
4. Start the UI once by hand and paste into the editor. This checks the clipboard add-on.

### How other users install it
Requirements:
- macOS or Linux, Node ≥ 22.19 (pi-tui's minimum).
- At least one agent CLI installed and logged in: `pi`, `claude` or `codex`. The app has
  no LLM of its own; participants and the moderator run on these CLIs. The moderator needs
  pi or Claude Code (§6.1).

```bash
npm install -g @siriuslan/team-discuss   # install; puts `team-discuss` on PATH
team-discuss                             # open the dashboard

npx @siriuslan/team-discuss              # or: try once without installing
npm update -g @siriuslan/team-discuss    # upgrade
```

From source (contributors): `cd apps/team-discuss && npm install && npm link`, or run
`node src/main.ts` directly.

On first run the app creates `~/.team-discuss` and asks for the default moderator agent, offering
the eligible agents it finds installed.

Not planned for v1: a standalone binary (`bun build --compile`, which pi uses) through GitHub
Releases or Homebrew. It would remove the Node requirement, but needs builds for each platform
with pi-tui's native add-ons included.

### Tests
`node --test`, core only. A **fake agent CLI** on `PATH` stands in for the real ones, so no
tokens are spent.

| Area | Cases |
|---|---|
| `nextSpeaker` | Each rule in §5.2; previous speaker; human comments and summaries don't affect round robin; muted/settled; floor |
| Mentions | Case; `@all`; own reply; summary; unaddressed human comment; code blocks, inline code, quotes |
| Event log | Replay of every derived value in §4.3. Two writers commit the same number: exactly one wins, and the other gets `Conflict`. Leftover temp files are ignored. Malformed event, number mismatch or gap → damaged. A transcript write failure → warning, event still committed. |
| Sessions | An attempt not completed by its turn (failed, stopped, crash simulated by an open attempt, conflict) → fresh session and the whole discussion next time; `reset` likewise |
| Lock | Free; held by a live pid; stale pid; take-over. A writer **suspended between its token check and its commit** (test hook) while another window takes over and commits: the suspended writer's commit fails, it stops, and the log stays valid. Two windows reclaiming one stale lock. Release removes only our own lock. |
| Processes | The fake agent starts a grandchild that ignores SIGTERM: interrupt → the grandchild is SIGKILLed after the grace period. Same when the fake agent exits first and leaves the grandchild behind. The quit path awaits cleanup before exiting. The grace period is a parameter, so tests run fast. |
| Home | Profiles, teams, deleting a profile (workspace and teams); permissions 0700/0600; `~` expansion; two discussions with the same topic in the same minute; eligibility checks |
| Adapters | Recorded JSON event lines; argument lists contain exactly the §6.1 flags per agent and seat kind; ineligible combinations are refused before spawning |
| `DiscussionRun` | Comments queued during a turn, combined with `/pause`, `/wrap` and interrupt; comment after an automatic pause; checkpoint; `@Human`; turn failure and retry; reset |

**Opt-in real-agent probes**, `npm run test:agents` (spends tokens). For every installed
agent and seat kind, each probe runs in an empty temp folder:

| Probe | Pass when |
|---|---|
| Write probe (participants) | The prompt explicitly asks the agent to create a file in its folder, create one outside it (a temp path), and, if it has a shell, run a command that writes. Neither file exists afterwards and the folder is unchanged. |
| MCP canary (participants) | A tiny stdio MCP server that creates a marker file when it starts is configured where the agent would pick it up for this run: project-level config in the temp folder, or a temporary config home, never the user's real config. The marker is absent afterwards. |
| No tools (moderator) | Asked to list its folder and read a file holding a secret string. Its JSON stream shows no tool calls and its reply doesn't contain the secret. |
| Basic turn | A reply is produced and a session id is reported |

These probes are the evidence behind §6.1. Codex participants are offered only if they pass (step 4).

## 11. Implementation plan (dependencies first)

Each step is a focused unit; runtime and new-test commits may be separate.

1. Scaffold `apps/team-discuss` (package, tsconfig, README stub, this design)
2. `core/agents.ts`: port adapters; start pi from PATH; detect installed agents; list pi
   models; per-seat limits and eligibility (§6.1); argument-list tests
3. `core/processes.ts`: process groups, cleanup, shutdown (§6.3); tests with fake agents
4. Opt-in real-agent probes (§10); verify the Codex limits and set Codex's participant
   eligibility from the result
5. `core/protocol.ts`: port; summary brief; mention rules (§5.1); tests
6. `core/lock.ts`: lock protocol (§4.4); tests
7. `core/discussion.ts`: commit rule, validation, replay, sessions rule, transcript rendering; tests
8. `core/home.ts`: layout, permissions, config, profiles, teams, creating and listing discussions; tests
9. `core/moderator.ts`: `nextSpeaker` + `DiscussionRun`; tests with the fake agent, including
   the suspended-writer test
10. UI shell + release build: `main.ts` (platform check, `--help`/`--version`), app/screen
    stack, theme, shutdown, Discussions tab (read-only list), esbuild build, smoke test.
    This checks early that pi-tui works standalone and that the installed package works.
11. Participants and Teams tabs
12. New-discussion form
13. Live discussion view (transcript, side panel, editor, commands, read-only mode, take-over)
14. README (install, requirements, trust and data); publish checklist; remove `private: true`

Commit titles use the prefix `team-discuss`, e.g. `team-discuss-add home store`.

## 12. Risks and follow-ups

- **pi-tui used on its own.** Its docs and examples mostly target pi extensions, and pi's themes
  live in pi, not pi-tui, so we need our own theme. Step 10 checks this before most of the UI is built.
- **Duplicated adapters.** Changes to the Claude/Codex/pi CLIs must be fixed in both the extension
  and the app. Follow-up: once the app is stable, extract `agents.ts` + `protocol.ts` into a
  shared package that both use. Until then, the extension gets its own fixes (see below).
- **Extension gaps found during this design** (to be fixed separately, with regression tests):
  - Its pi participants start the user's built-in MCP servers. Their tools can't be called,
    because none is named in the `--tools` allowlist and neither `codemode` nor
    `tool_search` is listed. Fix: `--no-mcp --exclude-tools 'mcp__*'`.
  - Its Codex participants run with Codex's default features and the user's config.
  - Its pi adapter passes the turn message as one argument, which fails on Linux once the
    unseen part of the discussion passes 128 KB.
- **CLI behavior changes.** The limits in §6.1 depend on each CLI's flags. Unknown flags fail
  closed, the adapter tests pin the argument lists, and the probes catch changed behavior.
  Rerun the probes when raising the tested versions.
- **Codex may be participant-ineligible in v1** if step 4 can't verify its limits. Codex is
  never offered as moderator (§6.1).
- **Spending while nobody watches:** limited by checkpoints and visible cost. A budget cap is a
  later option. A takeover can waste at most one turn (§4.4).
- **Dashboard speed:** it replays every event log on open. That's fine for hundreds of
  discussions; add a rebuildable cache if it gets slow.
- **Native add-ons:** relying on npm to install pi-tui (instead of bundling it) keeps its
  add-ons working. The smoke test (step 10) checks this.
- **`pi --list-models` output format** has to be parsed; fall back to typing a model name.

## 13. Open questions and things to verify

No open design decisions. To verify during implementation:
- **Step 4 (Codex):**
  - Does `--ignore-user-config` also keep project-level config, MCP servers and plugins out,
    including on `exec resume`?
  - Which features belong on the allowlist?
  - Is there a tool-free mode? Not expected, so Codex stays off as moderator.
- **Step 4 (pi):** the MCP canary passes with `--no-mcp --exclude-tools 'mcp__*'`, and the
  moderator probe passes with `--no-tools`.
- **Step 2:** the output format of `pi --list-models`.
- **Step 10:** pi-tui works standalone, and the packed, installed app runs, including the
  clipboard add-on.

Names checked on 2026-10-24:
- `@siriuslan/team-discuss` is not on npm, and `@siriuslan` is our own scope.
- No other package registry checked installs a `team-discuss` command.

## 14. Response to the reviews

### First review (REVIEW.md)

| Item | Resolution |
|---|---|
| 1 ID collisions | Readable IDs kept; exclusive folder creation, then `-2`, `-3` (§4.1) |
| 2 Lock protocol | Superseded by second review #1 |
| 3 Two-file consistency | An append-only event log is the only truth; transcript generated (D9, §4.3) |
| 4 Read-only enforcement | Contract, limits per agent and eligibility (§6.1); probes (§10). Shared role workspace kept (D2). |
| 5 Threat model | Moderator has no tools; trust and data section (§6.4). A full threat model is out of proportion for a local, single-user tool. |
| 6 Mention rules | §5.1; settled and mentioned are derived from events (§4.3) |
| 7 Pause rules | One rule: a comment always continues (D10, §5.3); command table (§5.4) |
| 8 Previous speaker, `log.turn` | Last participant turn only (§4.3, §5.2); every event has `seq`, and turns are counted separately |
| 9 Interruption | Superseded by second review #5 |
| 10 Privacy | 0700/0600, private per OS user, `~` expanded (D1, §6.4) |
| 11 Profile deletion | Deletes profile and workspace after a confirmation that names them. Old discussions get an empty workspace (§7, §9). |
| 12 Checkpoints | Any go-ahead passes it, no summary at a checkpoint, at least 1, uncommitted attempts don't count, cost visible (§5.6) |
| Build | Exact esbuild command, shebang, `files`, early smoke test (§10, §11) |

### Second review (of v2)

| Item | Resolution |
|---|---|
| 1 Token check isn't write exclusion | Exclusion moved into the write itself: each event is committed with `link()`, which fails if the number exists (§4.3). Every committed event was written with knowledge of all earlier ones, whatever the lock does. The lock is now explicitly advisory: it decides which window runs (§4.4). An OS-held lock was not chosen: Node has no API for one without a native add-on. Suspended-writer test added (§10). |
| 2 Aborted sessions aren't harmless | Agreed; the earlier claim was wrong. Sessions are disposable (D12, §6.2): an `attempt` event is committed before each turn, and only a completed attempt's session is resumed. This covers failure, stop, crash, takeover and conflict. |
| 3 Codex contradicts the contract | Eligibility per agent and seat kind (§6.1). Codex is never offered as moderator. Codex participants are offered only if step 4 verifies `--ignore-user-config` plus a feature allowlist enforced by disabling everything else; otherwise Codex is off for participants in v1. Remaining gaps are stated as policy. |
| 4 Commit boundary | The commit is the successful `link()`. Later failures are warnings. No partial records exist. Damaged records are reported, not skipped. Durability wording corrected (§4.3). |
| 5 Process cleanup | macOS and Linux only (D11). Group cleanup after every turn, even if the agent already exited. Async shutdown waits for it; the exit handler is a last resort. Limits stated. Tests for SIGTERM-ignoring and orphaned grandchildren (§6.3, §10). |
| Tests | Write probes inside and outside the folder, MCP canary, moderator no-tools probe (§10) |
| Extension | Gaps listed in §12. The pi claim is narrowed to the built-in MCP support, and the impact corrected: its MCP servers start, but their tools can't be called. |
