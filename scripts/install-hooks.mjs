#!/usr/bin/env node
// Install git hooks that run the public gate before every commit and every push.
//   node scripts/install-hooks.mjs [--force]
// Only in a standalone clone of this repository: inside a larger repository it refuses, so it never replaces
// that repository's own hooks. An existing hook that is not ours is left alone unless you pass --force.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const TAG = "# golden-hour-selector public gate";
const OLD_TAGS = ["# listen-statistics public gate"]; // hooks installed under the earlier name are still ours

const top = resolve(git(["rev-parse", "--show-toplevel"]));
if (top.toLowerCase() !== ROOT.toLowerCase()) {
  console.error(`install-hooks: this package is a folder inside ${top}. Hooks are only installed in a standalone clone; wire scripts/public-gate.mjs into that repository's own hooks instead.`);
  process.exit(1);
}
const hooksDir = resolve(ROOT, git(["rev-parse", "--git-path", "hooks"]));
mkdirSync(hooksDir, { recursive: true });
const body = `#!/bin/sh\n${TAG}\nexec node scripts/public-gate.mjs\n`;
let failed = false;
for (const name of ["pre-commit", "pre-push"]) {
  const path = join(hooksDir, name);
  if (existsSync(path) && ![TAG, ...OLD_TAGS].some((t) => readFileSync(path, "utf8").includes(t)) && !process.argv.includes("--force")) {
    console.error(`install-hooks: ${path} already exists and is not ours; left alone (use --force to replace it).`);
    failed = true;
    continue;
  }
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  console.log(`install-hooks: ${name} -> runs the public gate`);
}
process.exit(failed ? 1 : 0);
