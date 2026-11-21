#!/usr/bin/env node
// Public gate: refuses to let listening data or personal details reach a public repository.
// No dependencies. Exit 0 = safe to publish, 1 = blocked.
//
//   node scripts/public-gate.mjs [--root DIR]
//
// Checks, scoped to this package's folder (works at the root of the standalone repo and inside a monorepo):
//   1. no tracked file, and no file anywhere in git history, has a data-export name (csv, zip, tsv, Spotify
//      export names, caches, .env, token files);
//   2. no tracked file contains a network address (loopback and documentation ranges allowed) or a
//      personal streaming-history key;
//   3. no tracked file and no revision in history contains a line from your OPTIONAL private markers file
//      (GOLDEN_HOUR_SELECTOR_PRIVATE_MARKERS, default ~/.ai/golden-hour-selector/private-markers.txt). Put things there
//      that must never be public: your name, usernames, device or room names. The file stays on your machine.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argRoot = process.argv.indexOf("--root");
const ROOT = resolve(argRoot >= 0 ? process.argv[argRoot + 1] : join(dirname(fileURLToPath(import.meta.url)), ".."));
const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 30 });

// Built from fragments so this file never trips its own key scan.
const KEYS = ["ip" + "_addr", "conn" + "_country"];
const FORBIDDEN_NAMES = [
  [/\.(csv|tsv|zip)$/i, "data export (csv/tsv/zip)"],
  [/^Streaming_History/i, "Spotify streaming history"],
  [/^my_spotify_data/i, "Spotify privacy export"],
  [/-cache\.json$/i, "enrichment cache"],
  [/^\.env(\..+)?$/i, ".env file"],
  [/^spotify\.json$/i, "token store"],
  [/token[^/]*\.json$/i, "token file"],
];
const ENV_OK = new Set([".env.example"]);

function forbiddenName(path) {
  const name = basename(path);
  if (ENV_OK.has(name)) return null;
  const hit = FORBIDDEN_NAMES.find(([re]) => re.test(name));
  return hit ? hit[1] : null;
}

const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
const IPV6 = /(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4})?(?![\w:])/gi;
function allowedV4(ip) {
  const o = ip.split(".").map(Number);
  if (o.some((n) => n > 255)) return true; // not an address (a version string or similar)
  return o[0] === 127 || ip === "0.0.0.0" || (o[0] === 192 && o[1] === 0 && o[2] === 2) || (o[0] === 198 && o[1] === 51 && o[2] === 100) || (o[0] === 203 && o[1] === 0 && o[2] === 113);
}
const allowedV6 = (ip) => /^::1?$/.test(ip) || /^2001:0?db8:/i.test(ip);

export function contentFindings(text) {
  const out = [];
  for (const m of text.match(IPV4) ?? []) if (!allowedV4(m)) out.push(`network address ${m}`);
  for (const m of text.match(IPV6) ?? []) if (!allowedV6(m)) out.push(`network address ${m}`);
  for (const k of KEYS) if (new RegExp(`\\b${k}\\b`).test(text)) out.push(`personal key ${k}`);
  return out;
}

function main() {
  const problems = [];
  let top;
  try { top = resolve(git(["rev-parse", "--show-toplevel"]).trim()); } catch { console.error("public-gate: not a git repository: " + ROOT); process.exit(1); }
  const scope = top.toLowerCase() === ROOT.toLowerCase() ? "repository root" : `folder ${ROOT.slice(top.length + 1).replace(/\\/g, "/")} of a larger repository`;

  // 1a. tracked (and staged) files, paths relative to ROOT
  const tracked = git(["ls-files", "-z", "--", "."]).split("\0").filter(Boolean);
  for (const f of tracked) { const why = forbiddenName(f); if (why) problems.push(`tracked file ${f}: ${why}`); }

  // 1b. every path that ever existed in history under ROOT (log prints top-level-relative paths)
  let historyPaths = [];
  try { historyPaths = [...new Set(git(["log", "--all", "--name-only", "-z", "--format=", "--", "."]).split("\0").map((s) => s.trim()).filter(Boolean))]; } catch { /* no commits yet */ }
  for (const f of historyPaths) {
    const why = forbiddenName(f);
    if (why && !tracked.some((t) => f.replace(/\\/g, "/").endsWith(t))) problems.push(`file in git history ${f}: ${why} (rewrite history before publishing)`);
  }

  // 2. content of tracked files
  for (const f of tracked) {
    let buf;
    try { buf = readFileSync(join(ROOT, f)); } catch { continue; } // staged delete
    if (buf.includes(0)) continue; // binary
    for (const p of contentFindings(buf.toString("utf8"))) problems.push(`${f}: ${p}`);
  }

  // 3. private markers, current files and every revision in history
  const markersPath = process.env.GOLDEN_HOUR_SELECTOR_PRIVATE_MARKERS || join(homedir(), ".ai", "golden-hour-selector", "private-markers.txt");
  let markerNote;
  if (!existsSync(markersPath)) {
    markerNote = `private markers: none (no file at ${markersPath}); add one to also block your own names`;
  } else {
    const markers = readFileSync(markersPath, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
    markerNote = `private markers: ${markers.length} checked from ${markersPath}`;
    if (markers.length) {
      const dir = mkdtempSync(join(tmpdir(), "public-gate-"));
      const clean = join(dir, "m.txt");
      writeFileSync(clean, markers.join("\n") + "\n");
      const which = (text) => markers.map((m, i) => (text.toLowerCase().includes(m.toLowerCase()) ? i + 1 : 0)).filter(Boolean);
      try {
        for (const f of tracked) {
          let t; try { t = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }
          for (const n of which(t)) problems.push(`${f}: contains private marker #${n}`);
        }
        let revs = [];
        try { revs = git(["rev-list", "--all", "--", "."]).split(/\s+/).filter(Boolean); } catch { /* no commits */ }
        const seen = new Set();
        for (let i = 0; i < revs.length; i += 100) {
          let out = "";
          try { out = git(["grep", "-I", "-l", "-i", "-F", "-f", clean, ...revs.slice(i, i + 100), "--", "."]); } catch (e) { if (e.status !== 1) throw e; }
          for (const line of out.split(/\r?\n/).filter(Boolean)) {
            const path = line.slice(line.indexOf(":") + 1);
            if (!seen.has(path)) { seen.add(path); problems.push(`git history ${line.slice(0, 12)}...:${path}: contains a private marker (rewrite history before publishing)`); }
          }
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }

  console.log(`public-gate: ${scope}, ${tracked.length} tracked files, ${historyPaths.length} paths in history`);
  console.log(`public-gate: ${markerNote}`);
  if (problems.length) {
    for (const p of problems) console.log(`  BLOCKED ${p}`);
    console.log(`public-gate: FAIL (${problems.length} problem${problems.length === 1 ? "" : "s"}). Nothing here may be published until it is fixed.`);
    process.exit(1);
  }
  console.log("public-gate: PASS");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
