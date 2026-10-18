# pi-software-design-philosophy

A [pi](https://pi.dev) skill that helps the coding agent design, write, review and refactor code with one goal: **keeping complexity low**.

It's based on the ideas in **_A Philosophy of Software Design_ by John Ousterhout** (Yaknyam Press, 2018). Deep modules, information hiding, pulling complexity down, defining errors out of existence, "design it twice", comment-first design, and a checklist of design red flags are all turned into concrete workflows for the agent.

> **Not affiliated with or endorsed by John Ousterhout.** This package is an independent summary written in its own words. It contains no text or code examples from the book. If you find it useful, read the book; it explains these ideas far better and in much more depth.

## What it does

The skill runs in one of four modes, chosen from your request:

| Mode | Use it for | What you get |
|---|---|---|
| **Design** | New modules, classes, APIs, services | What the module should hide, 2–3 alternative designs compared, the chosen interface with its comments, and an error-handling strategy |
| **Implement** | Writing code | Code with deep interfaces, sensible defaults, fewer special cases and precise names, self-checked against the red flags |
| **Review** | PRs, files, codebases | A table of findings (location, red flag, problem caused, fix, severity) plus the top 3 strategic improvements |
| **Modify** | Changing or refactoring existing code | Changes that leave the design as if it had been planned that way from the start, with comments updated alongside |

## Install

### From npm (recommended)

Installs just this skill:

```bash
pi install npm:pi-software-design-philosophy
```

To pin a version for reproducible installs:

```bash
pi install npm:pi-software-design-philosophy@1.0.0
```

To try it for a single session without installing:

```bash
pi -e npm:pi-software-design-philosophy
```

Update later with `pi update npm:pi-software-design-philosophy`. Pinned versions stay pinned, so change the version in the source to upgrade.

### From GitHub (all skills in the repository)

This skill lives in the [siriuslan/pi-packages](https://github.com/siriuslan/pi-packages) repository. Installing from git loads **every** skill in that repository:

```bash
pi install git:github.com/siriuslan/pi-packages@v1.0.1
```

To load only this skill from the git install, use the object form in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/siriuslan/pi-packages@v1.0.1",
      "skills": ["packages/pi-software-design-philosophy/skills/*"]
    }
  ]
}
```

## Usage

Pi loads the skill automatically when a task matches, for example "review the design of `src/payments/`" or "design an API for the job scheduler".

To invoke it explicitly:

```text
/skill:software-design-philosophy review src/payments/
/skill:software-design-philosophy design a caching layer for the API client
/skill:software-design-philosophy refactor the order service to remove pass-through methods
```

## Contents

```
skills/software-design-philosophy/
├── SKILL.md                     # mental model, principles digest, four workflows, output templates
└── references/
    ├── principles.md            # each principle with techniques and illustrations
    ├── red-flags.md             # 14 red flags: detection hints, fixes, review checklist
    └── comments-and-naming.md   # comment templates, comment-first workflow, naming rules
```

## Other agents

The skill follows the [Agent Skills](https://agentskills.io/specification) format, so the `skills/software-design-philosophy/` folder also works in other compatible agents. Copy it into the agent's skills directory, for example `~/.claude/skills/` for Claude Code or `.agents/skills/` in a project.

## Development

Install from a local checkout. Pi loads it in place, so edits apply after `/reload`:

```bash
pi install /path/to/pi-software-design-philosophy
```

If you move the folder, run `pi remove` with the **old absolute path**, then `pi install` the new one.

## License

MIT for this package's own text; see [LICENSE](LICENSE). The book *A Philosophy of Software Design* is © John Ousterhout and is not included.
