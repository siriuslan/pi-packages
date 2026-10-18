# atomic-git-commits

A [pi](https://pi.dev) skill that plans and builds a multi-part change as a sequence of small, self-contained steps, and records each step as its own git commit titled `TICKET-description`, e.g. `PROJ-123-add UserRepository`.

The resulting history reads like a short explanation of the feature. Reviewers can follow the reasoning, `git bisect` lands on a meaningful step, `git blame` leads to a message that explains *why*, and reverting a single commit switches the feature off.

## What it does

- **Plans before coding:** defines "done", lists every piece of work (including migrations, config, security and docs), and shows the commit plan as a table.
- **Orders the steps safely:**
  1. Structural changes (refactors, renames, new dependencies) come first.
  2. Everything else follows in dependency order, so the project compiles at every commit.
  3. The user-visible entry point (endpoint, route, command, flag) is wired in last.
- **Keeps tests together:** all new tests go in one commit, last by default, or first when you work test-first (TDD).
- **Stages carefully:** commits only explicit paths after reviewing the staged diff, and never touches anyone else's uncommitted work.
- **Writes consistent messages:** `TICKET-imperative description`, with a body that explains why. The ticket comes from your request, the branch name, or a question to you.
- **Stays safe:** it only creates commits. It never amends, rebases, resets, stashes, pushes or switches branches.

It also handles work that is already written: it splits the existing changes into a sensible commit series.

Worked examples are included for a backend `POST /users` endpoint and a React sign-up page.

## Install

### From npm (recommended)

Installs just this skill:

```bash
pi install npm:atomic-git-commits
```

To pin a version for reproducible installs:

```bash
pi install npm:atomic-git-commits@1.0.0
```

To try it for a single session without installing:

```bash
pi -e npm:atomic-git-commits
```

Update later with `pi update npm:atomic-git-commits`. Pinned versions stay pinned, so change the version in the source to upgrade.

### From GitHub (all skills in the repository)

This skill lives in the [siriuslan/pi-packages](https://github.com/siriuslan/pi-packages) repository. Installing from git loads **every** skill in that repository:

```bash
pi install git:github.com/siriuslan/pi-packages
```

To load only this skill from the git install, use the object form in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/siriuslan/pi-packages",
      "skills": ["packages/atomic-git-commits/skills/*"]
    }
  ]
}
```

## Usage

Pi loads the skill automatically when you implement a feature or fix that spans several files or layers, or when you ask it to commit work.

To invoke it explicitly, optionally with a ticket:

```text
/skill:atomic-git-commits PROJ-123 add POST /users endpoint
/skill:atomic-git-commits add a sign-up page that calls POST /users
/skill:atomic-git-commits commit the changes I've already made
```

If you don't give a ticket, it takes the first `ABC-123` pattern from the branch name. If there isn't one, it asks you, or falls back to a short kebab-case task name.

## Contents

```
skills/atomic-git-commits/
├── SKILL.md                       # principles, procedure, git boundaries, message format, checklist
└── references/
    ├── backend-example.md         # worked example: POST /users endpoint
    └── frontend-example.md        # worked example: React sign-up page
```

## Other agents

The skill follows the [Agent Skills](https://agentskills.io/specification) format, so the `skills/atomic-git-commits/` folder also works in other compatible agents. Copy it into the agent's skills directory, for example `~/.claude/skills/` for Claude Code or `.agents/skills/` in a project.

## Development

Install from a local checkout. Pi loads it in place, so edits apply after `/reload`:

```bash
pi install /path/to/pi-packages/packages/atomic-git-commits
```

If you move the folder, run `pi remove` with the **old absolute path**, then `pi install` the new one.

## License

MIT; see [LICENSE](LICENSE).
