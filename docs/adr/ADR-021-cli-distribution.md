# ADR-021: Marshal CLI Distribution

## Status

Proposed — 2026-07-12

## Context

ADR-001 settled that Marshal ships as an npm package installed globally (`npm i -g sataycat/marshal`). ADR-020 covers onboarding _of dependencies_ (`acpx`, agent CLIs) but says nothing about how the `marshal` binary itself reaches the user's machine. This ADR fills that gap.

The current repo state:

- `package.json` declares `"name": "marshal"`, `"bin": { "marshal": "./bin/marshal" }`, and no `"repository"`, `"publishConfig"`, `"files"`, or `"engines"` field.
- `./bin/marshal` is a thin ESM loader that imports `../dist/cli.js`.
- `dist/` is produced by `pnpm run build` (`tsc` + `cp src/db/schema.sql`) and is not currently git-ignored, but it is also not declared as published output.
- There is no `prepublishOnly`/`postinstall` hook, so a user installing the package would receive source without a build step.

The intended install command is `npm i -g sataycat/marshal`. That token (`user/repo` form) is npm's GitHub shorthand — it clones `github.com/sataycat/marshal` and runs the package's install lifecycle. It is **not** a scoped package name like `@sataycat/marshal`. Both paths are viable; this ADR picks one and pins the package metadata to match.

### Design constraints

- **Single documented install command.** One line goes in the README, ADR-020's final summary, and `docs/PROJECT.md`. Users should not have to choose between npm and GitHub.
- **Build artifacts must be present after install.** The bin points at `dist/cli.js`; whatever channel we ship through must produce `dist/` on the user's machine.
- **No vendored runtime deps for distribution.** `better-sqlite3` is a native module — it compiles on install. The distribution must let `npm install` run its normal lifecycle so native bindings build per-platform.
- **Versioned and reproducible.** Installs resolve to a specific version (semver from `package.json` or a git ref), never "whatever is on `main` right now" for tagged releases.
- **Survives renames and registry moves.** The `repository` field is authoritative for where the code lives; the package name is a stable handle.

## Decisions

### 1. Ship via npm under the name `marshal`, with `repository` pointing at `sataycat/marshal`

The package keeps `"name": "marshal"`. The install command `npm i -g sataycat/marshal` is the **GitHub shorthand** form (`npm i -g user/repo`), which clones the repo and runs the install lifecycle. This matches what `docs/PROJECT.md:40` and ADR-001 already promise.

We do **not** adopt a scoped name (`@sataycat/marshal`). Reasons:

- The shorthand `npm i -g sataycat/marshal` is already documented externally and reads naturally.
- A scope would force `npm i -g @sataycat/marshal`, breaking the documented command.
- The unscoped `marshal` name on the public npm registry is a separate concern (see Open questions); for M0/M1 we route installs through GitHub.

`package.json` gains:

```jsonc
{
  "name": "marshal",
  "repository": {
    "type": "git",
    "url": "https://github.com/sataycat/marshal.git",
  },
  "homepage": "https://github.com/sataycat/marshal",
  "bugs": "https://github.com/sataycat/marshal/issues",
  "engines": { "node": ">=18" },
  "files": ["bin", "dist", "README.md", "LICENSE"],
}
```

### 2. `prepublishOnly` + `postinstall` build guarantee

Because GitHub-shorthand installs clone the repo (including `src/` but not necessarily a fresh `dist/`), we guarantee `dist/` exists via:

- `"prepublishOnly": "pnpm run build"` — safety net for any future `npm publish` path; never produces a tag without `dist/`.
- `"postinstall": "node scripts/postinstall.js"` (or a no-op when `dist/` is already present) — for GitHub-shorthand installs where `dist/` is missing, run the build. The script must:
  - Skip silently if `dist/cli.js` already exists (idempotent; avoids rebuilding on every `npm ci` in dev).
  - Skip when `npm_config_production=false` is not set and `devDependencies` are unavailable — print a warning instead of failing.
  - Never run `pnpm install` recursively; it invokes `tsc` directly via `node_modules/.bin/tsc` or `npx tsc`.

`dist/db/schema.sql` is copied by the build script alongside the compiled JS, matching the existing `pnpm run build` behavior.

### 3. `bin/marshal` stays as the ESM entrypoint

`./bin/marshal` remains a 5-line `#!/usr/bin/env node` stub that dynamic-imports `../dist/cli.js`. We do not switch to a bundled single-file binary (no `esbuild`/`tsx` in the runtime dependency tree) for M0/M1. Reasons:

- Keeps the runtime dependency surface identical between dev (`pnpm run build`) and installed (`marshal`) execution.
- Native module (`better-sqlite3`) compilation already requires a real `node_modules`; bundling would not eliminate the install step.
- A bundled binary is a future optimization once the dependency tree stabilizes (see Open questions).

### 4. Native module: `better-sqlite3` compiles on the user's machine

`better-sqlite3` is a native addon. We rely on npm's standard `install` lifecycle to compile it per-platform. Consequences:

- Users need a working C++ toolchain (`python3`, `make`, `g++`/`clang`) on first install. The README and ADR-020's Phase 1 must list this.
- We do not ship prebuilt binaries for M0/M1. `prebuild-install` (used by `better-sqlite3` upstream) will pull a prebuilt binary when one exists for the user's Node version/platform, which covers the common case without us doing anything.

### 5. Node engine pin

`"engines": { "node": ">=18" }` matches ADR-020's Phase 1 check (Node ≥ ES2022 / v18+). `npm` will warn (not fail) on mismatch by default; ADR-020's `marshal setup` is the hard gate.

### 6. Install command is documented in ADR-020's final summary

ADR-020's "Marshal is ready" banner currently jumps straight to `marshal task create`. We prepend the install line so the onboarding doc is self-contained:

```
Install:
  npm i -g sataycat/marshal

Then:
  marshal setup
  marshal task create --slug my-feature --title "My feature" --spec-file spec.md
```

### 7. No `brew` / `curl|sh` / standalone binary for M0/M1

Consistent with ADR-001. A Homebrew formula or `pkg`-packed standalone binary is out of scope until the npm path is proven and the native-module requirement becomes a real friction point.

## Consequences

- `npm i -g sataycat/marshal` works on any machine with Node ≥18 and a C++ toolchain, producing a working `marshal` binary on PATH.
- The package ships source + built `dist/` via the GitHub shorthand; `postinstall` rebuilds `dist/` if absent. Dev installs (`pnpm install` inside the repo) are unaffected because `dist/` will already exist or be rebuilt by the dev's own `pnpm run build`.
- `better-sqlite3`'s native compile is the main install friction. Prebuilt binaries cover the common platforms; the README must call out the toolchain requirement for the long tail.
- Future migration to the public npm registry under the name `marshal` (if available) or `@sataycat/marshal` is a one-line `name` change plus a `prepublishOnly` build; the `repository` field and install docs would update accordingly.
- The `bin/marshal` stub means the installed package still requires a `node_modules` tree at runtime (for `commander`, `hono`, `better-sqlite3`, etc.). This is standard for global npm CLIs and matches user expectations.

## Open questions (deferred)

- **Public npm registry publish.** If we want `npm i -g marshal` (no GitHub shorthand), the unscoped name `marshal` on npmjs.com may be taken. Reserve `@sataycat/marshal` as a fallback. Deferred until we decide to publish rather than ship via Git.
- **Single-file bundled binary.** `esbuild` or `bun build` could produce a single `dist/marshal.js` with all JS deps inlined (native modules still external). Reduces install surface and startup time. Deferred — current install is "good enough" and bundling adds a build-time dep.
- **Prebuilt native binaries for `better-sqlite3`.** Upstream `prebuild-install` already handles common platforms. If the long-tail toolchain requirement bites users, we could publish `marshal` with `npm_config_build_from_source=false` guidance or vendor prebuilds. Deferred.
- **Homebrew formula.** A `brew install sataycat/tap/marshal` formula would skip Node for users who don't have it — but Marshal still needs Node at runtime for the daemon, so the formula would just depend on `node` anyway. Limited win for M0/M1.
- **Auto-update.** Whether `marshal` should self-update (like `npm` does) or rely on `npm update -g sataycat/marshal`. Deferred — `npm update -g` is sufficient for now.

## Related

- `docs/PROJECT.md:40` — the documented install command this ADR formalizes.
- `docs/adr/archived/ADR-001-node-backend-and-embedded-react.md` §2 — distribution: npm package.
- `docs/adr/ADR-020-onboarding-and-setup.md` — onboarding flow that this ADR's install command feeds into.
- `package.json` — `name`, `bin`, `engines`, `files`, `repository`, `prepublishOnly`, `postinstall` fields this ADR adds.
- `bin/marshal` — the ESM entrypoint stub.
- `src/db/schema.sql` — copied into `dist/` by the build script (consumed at runtime by `openDb`).
