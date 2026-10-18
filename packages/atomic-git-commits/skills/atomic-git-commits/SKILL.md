---
name: atomic-git-commits
description: Design and build a multi-part change as a sequence of small, self-contained steps (structural prep first, dependencies before dependents, user-visible entry point last) and record each step as a git commit titled TICKET-description, e.g. PROJ-123-add UserRepository. Use when implementing a backend or frontend feature or fix that spans several files or layers, when planning how to structure such work, or when asked to commit it. Only creates commits; never amends, rewrites, resets or pushes history.
---

# Atomic Git Commits

This skill is about how to design and build a change; git is only where the result becomes
visible. Before writing code, break the change into small steps. Each step does one thing,
relies only on what earlier steps built, and leaves the project compiling. Build the steps in
that order and commit each one as soon as it is done.

The finished history reads top to bottom like a short explanation of the feature: a reviewer
can follow the reasoning, `git bisect` lands on a meaningful step, `git blame` leads to a
message that says why, and reverting a single commit switches the feature off.

## Worked examples

Read the matching example before planning. Paths are relative to this skill's directory.

- `references/backend-example.md`: `POST /users` endpoint (refactor, schema, model,
  repository, hashing, service, validation, error mapping, endpoint, docs, tests).
- `references/frontend-example.md`: React sign-up page that calls that endpoint (refactor,
  dependencies, API client, schema, hook, form, page, route, tests).

For full-stack work read both. Commit the backend series first, then the frontend series,
and never mix backend and frontend code in one commit.

## Principles

1. **One intent per commit.** You can state what it does in one sentence without "and".
2. **Build upward.** A commit only uses code that exists in it or in an earlier commit.
   Production code compiles at every commit and tests that already existed keep passing.
3. **Structure before behavior.** Refactors, renames, moves, formatting and new dependencies
   get their own commits, placed before the feature work. Make the change easy, then make the
   easy change. Never mix structural and behavioral changes in one commit.
4. **Expose last.** Nothing user-visible changes until one deliberate commit wires in the
   entry point (endpoint, route, link, CLI command, consumer, feature flag). Everything before
   it is unreachable and therefore safe to ship; reverting that one commit removes the feature.
   Validation, security and error handling must already be in place when it lands.
5. **New tests in one commit, first or last.** See below.
6. **Fit the codebase, not the template.** Follow the project's architecture, naming and
   tools. Skip steps that are not separate pieces in this codebase and never add a layer just
   to produce a commit. A small change can be a single commit.

## Where the tests go

All new tests for the change go together in one commit.

- **Tests last (default).** Implement every step, then write the tests and commit them as the
  final commit. The whole suite passes at that commit.
- **Tests first (TDD).** Use when the user asks for TDD/test-first or the project clearly
  works that way. After the structural commits, write tests that describe the target behavior
  and commit them. They fail (in typed languages they may not even compile) until the
  implementation commits land; say so in the commit body. The exposing commit turns the
  suite green.

Either way:

- Edits to *existing* tests or snapshots that a step forces go in that step's commit, so
  principle 2 holds. Only new tests wait for the tests commit.
- Infrastructure that exists only for the new tests (fixtures, fakes, mock handlers, test
  data) goes in the tests commit.
- Run the full suite at the end. If it exposes a bug in an earlier step, fix it in a new
  commit (`PROJ-123-fix ...`). With tests last, commit the fix before the tests so the tests
  commit is green.

## Procedure

### 1. Get oriented

```bash
git status --short     # anything already modified is not yours: never stage it
git branch --show-current
git rev-parse HEAD     # remember as START for the final summary
git log -5 --oneline   # also shows the existing message style
```

Read the project's guidance (README, CONTRIBUTING, AGENTS.md) and the code around the change.
Find the build, lint and test commands and how to run them non-interactively.

### 2. Find the ticket

1. A ticket the user gave, e.g. `/skill:atomic-git-commits PROJ-123 add POST /users`.
2. Otherwise the branch name: the first match of `[A-Z][A-Z0-9]+-[0-9]+`
   (`feat/PROJ-123-create-user` gives `PROJ-123`).
3. Otherwise ask the user. If there is no ticket, use a short kebab-case task name of at
   least two words, e.g. `create-user-endpoint`.

Use the same prefix on every commit of the task, including refactors, dependencies and docs.

### 3. Define the behavior

Write down what "done" means: inputs and outputs, the success case, every failure case, who
may use it, what is stored, what the user sees.

### 4. List the work

Every piece the change needs, including the easy-to-miss ones: migrations, configuration,
dependencies, security rules, error handling, translations, documentation.

### 5. Plan the commits

- Move structural changes to the front.
- Order the rest by dependency: pieces nothing depends on first, the entry point last. When
  several orders work, go from the core domain outward to the interface.
- Merge pieces that cannot stand alone, e.g. a model and the migration the framework
  generates from it, or a route and the security rule that opens it.
- Put the tests commit first or last.

Show the plan as a table (`#`, subject, contents) and continue without waiting for approval.
If the work later needs something unplanned, give it its own commit at the right point
instead of slipping it into an unrelated one.

### 6. Build and commit one step at a time

For each step:

1. Implement only this step. Keep later steps out of the working tree, so what you check is
   exactly what you commit.
2. Build or type-check and run the existing tests, non-interactively (no watch mode, no
   blocking dev server). In a TDD sequence the new tests are expected to fail until the
   exposing commit.
3. Stage explicit paths: `git add path/a path/b`. Never `git add -A`, `git add .` or
   `git add -u`.
4. Review what will be committed:
   ```bash
   git diff --cached --stat
   git diff --cached
   ```
   Look for files from other steps, unrelated formatting, debug output, focused tests
   (`.only`), secrets, `.env` files, build output and unrelated lockfile churn. Unstage a
   mistake with `git restore --staged <path>`.
5. Commit (format below), then run `git status --short` to confirm the result.

### 7. Finish and report

Run the full build and test suite, then show the history:

```bash
git log --oneline --reverse START..HEAD
```

Report the commits, the commands actually run with their results, and anything left out or
still failing. Never say a check passed if it was not run.

### When the code is already written

If asked to commit work that already exists, plan the steps the same way and stage them file
by file in plan order. If one file mixes changes from several steps, merge those steps rather
than splitting the file. Intermediate commits cannot be built without changing the working
tree, so check by reading instead: no commit may reference anything that is still unstaged.
Say in the report that intermediate commits were not built.

## Git boundaries

This skill only creates commits.

- **Allowed:** `status`, `diff`, `log`, `show`, `branch --show-current`, `rev-parse`,
  `add <paths>`, `restore --staged <path>`, `commit`.
- **Not allowed:** `commit --amend`, `rebase`, `reset`, `revert`, `stash`, `cherry-pick`,
  `push`, creating or switching branches, changing hooks or git config.
- A wrong commit is fixed forward with a new commit that corrects it, and mentioned in the
  report.
- If a file you must change already has someone else's uncommitted edits, stop and ask: your
  part cannot be staged safely on its own.

## Commit message format

```
<TICKET>-<description>

<body: why, wrapped at 72 columns>

<optional footer>
```

**Subject**

- Ticket, a hyphen, then the description, with no spaces around the hyphen:
  `PROJ-123-add UserRepository`.
- The description starts with a lowercase imperative verb and completes the sentence
  "This commit will ...". Code identifiers keep their own case.
- At most 72 characters in total (aim for a description of about 50), no trailing period,
  no type prefix such as `feat:`.

**Body:** why the change is needed, constraints, trade-offs, and what is deliberately left
out. The diff already shows what changed. Structural commits say "No behavior change." A TDD
tests commit says the tests fail until the implementation lands.

**Footer (optional):** `BREAKING CHANGE: ...`, `Co-authored-by: Name <email>`, related
tickets. The task's own ticket is already in the subject.

Since there is no type prefix, the opening verb signals the kind of change:

| Change | Start the description with |
|---|---|
| New behavior | add, expose, support, allow |
| Bug fix | fix, handle, prevent, reject |
| Structure only | extract, rename, move, inline, simplify |
| Dependencies | add ... dependency, upgrade, bump |
| Tests or docs only | test, cover, document |
| Removal | remove, drop, delete |

| Avoid | Prefer |
|---|---|
| `updated user files` | `PROJ-123-add UserService.createUser` |
| `PROJ-123 fix bug` | `PROJ-123-reject emails differing only in case` |
| `PROJ-123-Added validation.` | `PROJ-123-validate create-user request payload` |
| `PROJ-123-WIP`, `PROJ-123-misc changes` | A subject that names what the step does |

Commit without an editor:

```bash
git commit -F - <<'EOF'
PROJ-123-add UserRepository

Provide save, findByEmail and existsByEmail for User. Lookups go
through the case-insensitive unique index, so the database decides
whether an email is taken.
EOF
```

## Sizing

- **Too big:** the subject needs "and"; reverting it would take unrelated work with it; the
  diff is too large to hold in your head (several hundred non-test lines is a warning sign).
- **Too small:** it does not compile on its own, or it only makes sense together with the
  next commit. Merge it with that commit.

## Anti-patterns

- One commit for the whole feature.
- Top-down order, where early commits call code that does not exist yet.
- Refactors, formatting or import shuffles mixed into a behavior change.
- Exposing the entry point before validation, security and error handling exist.
- Messages that repeat the diff ("change UserService") instead of explaining why.
- Committing secrets, `.env` files, build output or IDE settings.

## Before each commit

- [ ] One intent; the subject has no "and"
- [ ] Uses only code from this or earlier commits; it builds; existing tests pass
- [ ] Only this step's files are staged, and none of anyone else's uncommitted work
- [ ] No unrelated formatting, debug code, focused tests, secrets or build output
- [ ] Nothing user-visible changes unless this is the exposing commit
- [ ] Subject is `<TICKET>-<description>` and the body explains why
