# pi-packages

Pi skills and extensions, published individually on npm. Each package's README has its
installation and usage instructions.

| Package | Description |
|---|---|
| [`@siriuslan/atomic-git-commits`](packages/atomic-git-commits) | Build multi-part changes as small, dependency-ordered Git commits |
| [`@siriuslan/pi-software-design-philosophy`](packages/pi-software-design-philosophy) | Apply *A Philosophy of Software Design* to design, implementation and review |
| [`@siriuslan/discuss`](packages/discuss) | Moderated discussions between AI participants |

## Publishing

These instructions apply to **any publishable package in this repository**. Each package has
its own `package.json`, npm name and independent version. Publish from that package's folder,
**not the repository root**. The root package and any package marked `"private": true` are
not for publishing.

### 1. Choose the package

Start at the repository root and select the package you want to release:

```bash
PACKAGE_DIR=packages/discuss   # or packages/atomic-git-commits, packages/pi-software-design-philosophy, etc.
cd "$PACKAGE_DIR"
PACKAGE_NAME=$(node -p "require('./package.json').name")
```

Run the remaining commands in the **same shell and package directory**. The commands read the
package name and version from its manifest rather than hard-coding a particular package.

### 2. Check and prepare the release

Install dependencies first if needed (`npm install`), and follow the package's README for
any additional checks. Run the scripts that the package provides:

```bash
npm run typecheck --if-present
npm run test --if-present
npm run build --if-present
npm view "$PACKAGE_NAME" version   # check the latest published version
```

`--if-present` skips scripts that are not defined. The current skill packages need no build;
the discuss extension also needs no build because pi loads its TypeScript directly. For a
first publication, `npm view` returns a not-found error; that is expected.

Bump the version **once per release**, then inspect the package contents:

```bash
npm version patch --no-git-tag-version   # skip if already bumped for this release
VERSION=$(node -p "require('./package.json').version")
npm pack --dry-run
```

`npm version` reads and updates the **local** `package.json`; it does not consult npm or
publish anything. Starting from `0.1.0`:

| Version argument | Result |
|---|---|
| `patch` | `0.1.1` |
| `minor` | `0.2.0` |
| `major` | `1.0.0` |

You can also set an exact version, for example `npm version 0.1.1 --no-git-tag-version`.
The flag prevents npm from automatically creating a Git commit or tag. A `package-lock.json`,
if present, is updated too. Do not bump again when retrying an unpublished release. A version
that has already been published cannot be overwritten.

Check the `npm pack --dry-run` output against the manifest's `files` list. Include the required
code or skills, README and license; exclude secrets, local state and unintended artifacts.

### 3. Commit the release

Commit release changes, including the version bump and any tracked lockfile changes, if not
already committed. From the same package directory:

```bash
git add package.json
# Also stage package-lock.json if it is tracked and changed, plus other intended release changes.
git commit -m "${PACKAGE_NAME##*/}-release $VERSION"
```

### 4. Publish and verify

```bash
npm login                          # skip if already authenticated
npm publish --access public
npm view "$PACKAGE_NAME" version   # verify that it matches $VERSION
```

Optionally tag and push the release. Use a **package-specific tag** because packages have
independent versions:

```bash
TAG="${PACKAGE_NAME##*/}-v$VERSION"
git tag -a "$TAG" -m "Release $PACKAGE_NAME $VERSION"
git push origin main
git push origin "$TAG"
```

For example, the tag could be `discuss-v0.1.1` or `atomic-git-commits-v1.0.1`.

### 5. Update an installed pi package

```bash
pi update "npm:$PACKAGE_NAME"
```

Then run `/reload` inside pi.
