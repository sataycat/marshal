#!/usr/bin/env node
// ADR-021: ensure dist/ exists after install via the `npm i -g sataycat/marshal`
// GitHub-shorthand path, which clones the repo without a fresh build. The script
// is idempotent: it skips silently when dist/cli.js is already present (dev
// installs, npm ci), and skips with a warning when devDependencies (typescript)
// are unavailable so production-only installs don't fail. It never re-runs the
// package manager; it invokes the local tsc directly.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url)); // scripts/
const pkgRoot = dirname(root); // repo / package root
const distCli = join(pkgRoot, "dist", "cli.js");
const schemaSrc = join(pkgRoot, "src", "db", "schema.sql");
const schemaDst = join(pkgRoot, "dist", "db", "schema.sql");

if (existsSync(distCli)) {
  process.exit(0);
}

// `node_modules/.bin/tsc` is a shell-wrapper symlink, not a runnable JS file.
// Invoke the TypeScript compiler's JS entry directly so postinstall works under
// npm/pnpm/yarn without depending on a shell or the PATH.
const tscBin = join(pkgRoot, "node_modules", ".bin", "tsc");
const tscJs = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");
const hasTsc = existsSync(tscJs) || existsSync(tscBin);

if (!hasTsc) {
  console.warn(
    "[marshal postinstall] dist/ is missing and typescript is not installed " +
      "(likely a production-only install without devDependencies). Run " +
      "`pnpm install && pnpm run build` (or `npm install && npm run build`) in " +
      "the package directory to produce the marshal binary.",
  );
  process.exit(0);
}

const tscTarget = existsSync(tscJs) ? tscJs : tscBin;
const result = spawnSync(process.execPath, [tscTarget], {
  cwd: pkgRoot,
  stdio: "inherit",
});
if (result.status !== 0) {
  console.error("[marshal postinstall] tsc build failed");
  process.exit(typeof result.status === "number" ? result.status : 1);
}

// Copy schema.sql alongside the compiled JS, matching `pnpm run build`.
if (existsSync(schemaSrc)) {
  mkdirSync(dirname(schemaDst), { recursive: true });
  copyFileSync(schemaSrc, schemaDst);
}