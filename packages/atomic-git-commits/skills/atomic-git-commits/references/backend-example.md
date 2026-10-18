# Backend example: `POST /users`

Ticket `PROJ-123`: let people register by posting an email, name and password.

- **201 Created** with a `Location: /users/{id}` header and the user in the body (never the
  password hash)
- **400** with per-field messages for invalid input
- **409** when the email is already registered
- Open to anonymous callers, because this is the sign-up entry point

Names follow a layered Spring Boot style. The table at the end maps the pieces to other
stacks.

## Work list

- The existing exception handlers each build the error JSON by hand (structural clean-up)
- `users` table with a case-insensitive unique email
- `User` domain model
- `UserRepository`
- Password hashing, which adds a dependency
- `UserService.createUser` with a duplicate-email check
- `CreateUserRequest` with input validation
- Mapping validation and duplicate errors to 400 and 409
- `UserController`, response type, and a security rule that allows anonymous sign-up
- OpenAPI documentation
- Tests

## Dependency order

```
ErrorResponse (structural, independent)

users table ─▶ User ─▶ UserRepository ─┐
                       PasswordHasher ─┼─▶ UserService ─┐
                                                        ├─▶ error mapping ─▶ UserController ─▶ docs
                CreateUserRequest ──────────────────────┘
```

## Commit plan (tests last)

| # | Subject | Contents |
|---|---|---|
| 0 | `PROJ-123-extract shared ErrorResponse body` | One error-body type, used by the existing handlers |
| 1 | `PROJ-123-create users table` | Migration with a unique index on `lower(email)` |
| 2 | `PROJ-123-add User domain model` | Entity; email trimmed and lower-cased; hash kept out of `toString` and JSON |
| 3 | `PROJ-123-add UserRepository` | `save`, `findByEmail`, `existsByEmail` |
| 4 | `PROJ-123-add bcrypt password hasher` | `PasswordHasher` interface, bcrypt implementation, dependency, cost setting |
| 5 | `PROJ-123-add UserService.createUser` | `CreateUserCommand`; normalize, check duplicate, hash, save; unique violation becomes `DuplicateEmailException` |
| 6 | `PROJ-123-validate create-user request payload` | `CreateUserRequest`, validation rules, `toCommand()` |
| 7 | `PROJ-123-map user-creation errors to HTTP responses` | 400 with field errors, 409 for duplicates, both using `ErrorResponse` |
| 8 | `PROJ-123-expose POST /users endpoint` | Controller, `UserResponse`, 201 + `Location`, security rule |
| 9 | `PROJ-123-document POST /users in OpenAPI spec` | Spec entry, changelog |
| 10 | `PROJ-123-test user registration` | All new tests (see below) |

Commits 0 to 7 add code that no client can reach. Commit 8 is the only one that changes what
clients see, so reverting it alone removes the feature without undoing the refactor or the
schema that other work may now rely on.

### Why these boundaries

- **0 stands alone** because it is structural. The existing handler tests pass without any
  change, which proves that behavior is unchanged, and reviewing it takes seconds.
- **1 comes first** because everything depends on the schema. The migration only adds a
  table that nothing reads yet, so it can be deployed ahead of the code.
- **4 is its own commit** because security-sensitive code deserves a focused review. The
  dependency arrives with its first use; give the dependency its own commit only if lockfile
  churn would bury the code.
- **5 takes a `CreateUserCommand`, not the HTTP request type**, so the service does not depend
  on the web layer and could serve another entry point later.
- **5 handles the race:** the `existsByEmail` pre-check gives a clear error in the common
  case, but two concurrent requests can both pass it. The unique index is the real guard, so
  a constraint violation on save becomes the same `DuplicateEmailException`.
- **7 is separate** because it touches error handling that other endpoints share. Skip it if
  the application already maps these errors.
- **8 ships the route and the security rule together**, because neither is meaningful
  without the other.
- **9 disappears** if the docs are generated from annotations; those then arrive in commit 8.

## The tests commit

Commit 10 holds every new test, plus test-only infrastructure such as the Testcontainers
setup:

| Area | What the tests check |
|---|---|
| `User` | Email normalization; the hash never shows up in `toString` or JSON |
| `UserRepository` | Against a real database: save and read back; the same email in a different case violates the unique index |
| `PasswordHasher` | The hash differs from the input; `matches` is true for the right password and false for a wrong one; hashing twice gives different hashes (salted) |
| `UserService` | With fakes: stores the hash, not the plain text; a duplicate throws; a constraint violation on save throws the same exception |
| `CreateUserRequest` | Parameterized: a valid payload passes; each invalid field gives exactly that field's error |
| Error mapping | 400 and 409 response shapes; other endpoints' error responses are unchanged |
| `POST /users` | Through the HTTP stack: 201 + `Location` with no hash in the body; 400; 409; anonymous callers are accepted |

If a test exposes a bug, for example email casing not being normalized in the service, commit
the fix first (`PROJ-123-fix email normalization in createUser`) and the tests after it.

## Tests-first (TDD) order

```
0  PROJ-123-extract shared ErrorResponse body
1  PROJ-123-test user registration          <- red until 9
2  PROJ-123-create users table
3  PROJ-123-add User domain model
...
9  PROJ-123-expose POST /users endpoint      <- suite turns green
10 PROJ-123-document POST /users in OpenAPI spec
```

The structural commit stays in front, so the existing tests can still show it changes
nothing. In Java the new tests reference classes that do not exist yet, so test compilation
fails until they do, while the production code (`./gradlew compileJava`) still builds. Say
this in the commit body.

## Sample messages

```
PROJ-123-extract shared ErrorResponse body

Three exception handlers assembled the same error JSON by hand. Move
it into one ErrorResponse type so the upcoming user-creation errors
can reuse it instead of adding a fourth copy.

No behavior change: response bodies are identical and the existing
handler tests pass unmodified.
```

```
PROJ-123-create users table

Add the table behind user registration. The unique index is on
lower(email), so two sign-ups that differ only in letter case are
rejected by the database even when they arrive at the same time.

Nothing reads the table yet, so the migration can be deployed ahead
of the application code.
```

```
PROJ-123-add UserService.createUser

Normalize the email, reject duplicates, hash the password and save
the user.

The existsByEmail check gives a clear error in the common case, but
two concurrent requests can both pass it, so a unique-constraint
violation on save is turned into the same DuplicateEmailException.
The database index stays the source of truth.

The service takes a CreateUserCommand rather than the HTTP request
type so it does not depend on the web layer.
```

```
PROJ-123-expose POST /users endpoint

Add self-service registration. Success returns 201 with a Location
header and a UserResponse that never contains the password hash;
invalid input gets 400 and a taken email 409.

The route is open to unauthenticated callers because it is the
sign-up entry point. Rate limiting is handled at the gateway
(PROJ-130).
```

```
PROJ-123-test user registration

Cover the registration flow layer by layer: email normalization,
password hashing, the duplicate check including the concurrent-insert
case, payload validation, error mapping, and the endpoint through the
full HTTP stack.

The repository tests run against a real database via Testcontainers
so the case-insensitive unique index is exercised, not mocked.
```

TDD variant of the tests commit body, last paragraph:

```
These tests describe the target behavior and fail until the
implementation commits that follow land; test sources do not compile
until User, UserService and UserController exist.
```

## Resulting history

```
$ git log --oneline --reverse START..HEAD
a1c3e09 PROJ-123-extract shared ErrorResponse body
b27d4f1 PROJ-123-create users table
c84e2a3 PROJ-123-add User domain model
d19f7b6 PROJ-123-add UserRepository
e5a0c48 PROJ-123-add bcrypt password hasher
f3b6d92 PROJ-123-add UserService.createUser
0a7e1c5 PROJ-123-validate create-user request payload
1d92b37 PROJ-123-map user-creation errors to HTTP responses
2e48f60 PROJ-123-expose POST /users endpoint
3f05a14 PROJ-123-document POST /users in OpenAPI spec
4c61b28 PROJ-123-test user registration
```

## Other stacks

Skip any row that is not a separate piece in your framework.

| Piece | Spring Boot | Django / DRF | Node (Express / NestJS) |
|---|---|---|---|
| Migration | Flyway / Liquibase script | `makemigrations` output, committed **with** the model | Prisma / Knex / TypeORM migration; with Prisma, commit schema and migration together |
| Model | `@Entity` class | `models.Model` subclass | Prisma model / TypeORM entity |
| Repository | Spring Data interface | Usually none (model manager), so no commit | Usually none with Prisma; a provider in NestJS |
| Password hashing | `PasswordEncoder` bean | Built-in `make_password`, often settings only | `bcrypt` / `argon2` package |
| Validation | DTO + Bean Validation (`@Valid`) | `Serializer` | zod schema / class-validator DTO |
| Error mapping | `@RestControllerAdvice` | Custom `EXCEPTION_HANDLER` | Error middleware / exception filter |
| Endpoint | `@RestController` | `APIView` / `ViewSet` + `urls.py` | Router / `@Controller` |
| Security rule | `SecurityFilterChain` | `permission_classes = [AllowAny]` | Auth middleware exemption / guard |

## Smaller version

For a small change, merge adjacent layers. Keep the structural commit separate if there is one:

1. `PROJ-123-add User persistence`: migration, model, repository
2. `PROJ-123-add user creation service`: hasher, service
3. `PROJ-123-validate create-user requests`: request validation, 400/409 mapping
4. `PROJ-123-expose POST /users endpoint`: controller, security rule, docs
5. `PROJ-123-test user registration`
