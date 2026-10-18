# Frontend example: React sign-up page

Ticket `PROJ-124`: a sign-up page that calls the `POST /users` endpoint from
`backend-example.md` (201 on success, 400 with field errors, 409 for a taken email).

Assumed stack: React + TypeScript, React Router, TanStack Query, react-hook-form + zod,
Vitest + Testing Library, MSW for API mocks, Playwright for end-to-end tests. Swap in the
project's equivalents (Jest, Formik, SWR, Cypress, ...); the plan stays the same. Never add a
library the project does not already use just to follow this example.

On the frontend, "safe to ship" means **unreachable**: until a route or link points to the new
code, no user can get to it, and bundlers usually leave unused modules out of the build.

## Work list

- `LoginForm` repeats label, input and error markup for every field (structural clean-up)
- New dependencies: react-hook-form, zod, @hookform/resolvers
- `createUser()` API client with a typed `ApiError`
- Validation schema that mirrors the backend rules, plus confirm-password
- `useCreateUser` mutation hook
- `SignUpForm` presentational component
- Showing server errors on the form (400 field errors, 409 duplicate, anything else)
- `SignUpPage` container that connects the hook to the form
- `/signup` route and a "Create an account" link on the login page
- Tests

## Commit plan (tests last)

| # | Subject | Contents | Builds on |
|---|---|---|---|
| 0 | `PROJ-124-extract TextField from LoginForm` | `TextField` component; `LoginForm` uses it | none |
| 1 | `PROJ-124-add form validation dependencies` | `package.json` and lockfile only | none |
| 2 | `PROJ-124-add createUser API client` | `createUser()`, `ApiError`, request/response types on the shared fetch wrapper | none |
| 3 | `PROJ-124-add sign-up validation schema` | zod schema, inferred `SignUpValues`, `toCreateUserRequest()` | 1 |
| 4 | `PROJ-124-add useCreateUser mutation hook` | TanStack Query mutation around `createUser` | 2 |
| 5 | `PROJ-124-add SignUpForm component` | Form, Storybook stories, `signup.*` i18n keys | 0, 3 |
| 6 | `PROJ-124-show server errors on SignUpForm` | `serverError` prop mapped onto fields or a generic alert | 2, 5 |
| 7 | `PROJ-124-add SignUpPage container` | Hook + form; navigate to `/welcome` on success | 4, 6 |
| 8 | `PROJ-124-expose sign-up page at /signup` | Lazy route, link on the login page | 7 |
| 9 | `PROJ-124-test sign-up flow` | All new tests, MSW handlers, Playwright spec | all |

Commit 8 is the only one users can see, so reverting it alone removes the feature.

### Why these boundaries

- **0 stands alone** because it is structural. `LoginForm`'s existing tests (and snapshots)
  must pass **without edits**; that is the proof it renders the same DOM.
- **1 is only the dependency change**, because lockfile diffs are large and noisy. The
  lockfile may only change in ways the `package.json` change requires; if the package
  manager rewrote unrelated entries, discard them and regenerate.
- **2:** if the client is generated from an OpenAPI spec, the generated code is its own
  commit naming the generator command and spec version, with no hand edits mixed in.
- **3** infers the form type from the schema, so the rules and the type cannot drift apart.
  Client-side rules only give fast feedback; the backend stays the authority.
- **4** gives components pending and error state. It does not navigate or show
  notifications; those are page-level decisions.
- **5 is presentational.** It takes `onSubmit` and `isSubmitting` as props and knows nothing
  about the API, so it can be reviewed in Storybook before any data wiring exists. Stories
  and i18n keys go with the component that uses them.
- **6 is separate** because it is the frontend twin of the backend's error-mapping commit:
  a distinct behavior that can be checked against the API contract.
- **8 ships the route and the link together**, because a route nobody can find, or a link to
  a missing route, is half a change. The link changes the login page, so any existing
  `LoginPage` snapshot is updated **in this commit**.

## The tests commit

Commit 9 holds every new test, plus test-only infrastructure such as the MSW handlers that
encode the agreed API contract:

| Area | What the tests check |
|---|---|
| `createUser` | With MSW: 201 resolves to a `UserResponse`; 400 throws `ApiError` with `fieldErrors`; 409 throws `ApiError` with status 409 |
| Schema | A valid payload passes; each invalid field gives exactly that field's error; mismatched passwords fail on `confirmPassword` |
| `useCreateUser` | `renderHook` with a fresh `QueryClient` (`retry: false`): success returns the user; a 409 shows up as `ApiError` |
| `SignUpForm` | Fields found by accessible label; an invalid submit shows messages and does not call `onSubmit`; a valid submit calls it; the button is disabled while submitting; 400 messages land on their fields, 409 on email, anything else in a `role="alert"` |
| `SignUpPage` | In `MemoryRouter` + `QueryClientProvider` with MSW: success navigates to `/welcome`; 409 shows the email error; the button is disabled while the request is in flight |
| `LoginPage` | The "Create an account" link exists and points to `/signup` |
| End to end | Playwright fills in the form and lands on `/welcome` |

If a test exposes a bug, commit the fix first (`PROJ-124-fix ...`) and the tests after it.

## Tests-first (TDD) order

```
0  PROJ-124-extract TextField from LoginForm
1  PROJ-124-add form validation dependencies
2  PROJ-124-test sign-up flow                 <- red until 9
3  PROJ-124-add createUser API client
...
9  PROJ-124-expose sign-up page at /signup    <- suite turns green
```

The structural and dependency commits stay in front. `tsc` fails on the new test files until
the modules they import exist; say so in the tests commit body.

## Sample messages

```
PROJ-124-extract TextField from LoginForm

LoginForm wrote label, input and error markup inline for each field.
Move it into a TextField that owns the accessibility wiring (label
association, aria-invalid, aria-describedby for the error) so the
sign-up form gets it for free.

No behavior change: LoginForm renders the same DOM and its tests pass
unmodified.
```

```
PROJ-124-add form validation dependencies

Add react-hook-form, zod and @hookform/resolvers. react-hook-form
keeps inputs uncontrolled, so typing does not re-render the whole
form; zod schemas double as the TypeScript type of the form values.

Dependency and lockfile changes only.
```

```
PROJ-124-show server errors on SignUpForm

Accept an optional serverError and map it onto the form: 400 field
messages go to their fields, 409 shows "This email is already
registered" on the email field, anything else shows a generic alert.

Errors are set through setError, so each one clears as soon as the
user edits that field.
```

```
PROJ-124-expose sign-up page at /signup

Register a lazily loaded /signup route, so the sign-up code ships in
its own chunk, and add a "Create an account" link to the login page.

This is the first commit users can see. It needs the backend
POST /users endpoint (PROJ-123) to be live.
```

```
PROJ-124-test sign-up flow

Cover the API client, schema, mutation hook, form, page and the new
login link, plus one Playwright journey from the form to /welcome.

MSW handlers mirror the POST /users contract (201, 400, 409), so the
tests do not need a running backend.
```

## Resulting history

```
$ git log --oneline --reverse START..HEAD
4b1e7c2 PROJ-124-extract TextField from LoginForm
5c93a0d PROJ-124-add form validation dependencies
6d20f8e PROJ-124-add createUser API client
7e8c41a PROJ-124-add sign-up validation schema
8f57b93 PROJ-124-add useCreateUser mutation hook
90a6d2c PROJ-124-add SignUpForm component
a13e5f7 PROJ-124-show server errors on SignUpForm
b2c48e0 PROJ-124-add SignUpPage container
c3d9a61 PROJ-124-expose sign-up page at /signup
d4ea072 PROJ-124-test sign-up flow
```

## Coordinating with the backend

- In a monorepo, commit the backend series first. Backend and frontend code never share a
  commit.
- Commits 0 to 7 can merge before the backend is live: they are unreachable, and their tests
  use MSW instead of the real API.
- Commit 8 waits until `POST /users` is deployed, unless it is behind a feature flag (wrap
  the route and the link in `useFeatureFlag('user-signup')`). Then turning the feature on is
  a flag change, often made outside the repo.

## Smaller version

Keep the `TextField` refactor as its own commit if there is one:

1. `PROJ-124-add form validation dependencies`
2. `PROJ-124-add create-user data layer`: API client, `ApiError`, mutation hook
3. `PROJ-124-add sign-up form`: schema, form, server-error display, stories
4. `PROJ-124-expose sign-up page at /signup`: page, route, login link
5. `PROJ-124-test sign-up flow`

## Frontend traps

- **Lockfile noise:** never commit lockfile changes that the `package.json` change did not
  require.
- **Format-on-save:** an editor that reformats whole files buries the real change. Format
  only the lines you touched. A needed mass reformat is its own commit, and its hash goes
  into `.git-blame-ignore-revs`.
- **Snapshots and visual baselines:** an existing snapshot changed by a step is updated in
  that step's commit; read the snapshot diff. Snapshots for new components belong in the
  tests commit.
- **Focused tests:** a committed `it.only` / `describe.only` silently skips the rest of the
  suite. Check before every commit:
  `git diff --cached | grep -nE '\.only\(|console\.log|debugger'`
- **Dead-code checks:** with tests last, modules from commits 2 to 7 are not imported by
  anything until their consumer lands. If CI runs an unused-export check (e.g. knip), merge
  such a module into the commit of its first real consumer.
- **Translations:** i18n keys go in with the component that uses them; other locales from a
  translation vendor come later as their own commits.
- **Global styles:** changes to design tokens, the theme or global CSS affect every page and
  get their own commit.
- **Build output:** `dist/`, `build/`, `coverage/`, `storybook-static/` and `.env.local` stay
  out of commits.

## Checks per commit

Use the project's real scripts and run them non-interactively. Never start watch mode or the
dev server as a blocking step.

```bash
npm run typecheck && npm run lint && npx vitest run   # or: CI=true npm test
```

Run Playwright at least once on the final commit.
