// The public gate, proven on throwaway git repositories: each planted leak fails it, and it passes again once
// the leak is gone (from the files AND from history). All planted data is invented.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "public-gate.mjs");
const NO_MARKERS = join(tmpdir(), "public-gate-test-no-such-markers.txt");

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "public-gate-test-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  g("init", "-q");
  g("config", "user.name", "Test Author");
  g("config", "user.email", "test@example.invalid");
  g("config", "commit.gpgsign", "false");
  g("config", "core.autocrlf", "false");
  writeFileSync(join(dir, "README.md"), "# demo\nRuns on http://127.0.0.1:8765/\n");
  writeFileSync(join(dir, ".env.example"), "SPOTIFY_CLIENT_ID=\n");
  commit(dir, "init");
  return dir;
}
function commit(dir: string, msg: string) {
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", msg], { cwd: dir, stdio: "pipe" });
}
function git(dir: string, ...a: string[]) { execFileSync("git", a, { cwd: dir, stdio: "pipe" }); }
function gate(root: string, markers = NO_MARKERS) {
  const r = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8", env: { ...process.env, GOLDEN_HOUR_SELECTOR_PRIVATE_MARKERS: markers } });
  return { ok: r.status === 0, out: r.stdout + r.stderr };
}

describe("public gate", { timeout: 30_000 }, () => {
  it("passes a clean repository and says when no markers file exists", () => {
    const dir = repo();
    const r = gate(dir);
    expect(r.out).toContain("PASS");
    expect(r.out).toContain("private markers: none");
    expect(r.ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a CSV fails when staged, when committed, and while it is still in history; passes once history is rewritten", () => {
    const dir = repo();
    writeFileSync(join(dir, "tracks-history.csv"), "track,hist_plays\r\nInvented Song,3\r\n");
    git(dir, "add", "tracks-history.csv");
    expect(gate(dir).ok).toBe(false); // staged: the pre-commit hook would stop here
    commit(dir, "oops");
    expect(gate(dir).out).toContain("tracked file tracks-history.csv");
    git(dir, "rm", "-q", "tracks-history.csv");
    commit(dir, "remove it");
    const still = gate(dir);
    expect(still.ok).toBe(false); // deleting is not enough: it is in history
    expect(still.out).toContain("file in git history tracks-history.csv");
    git(dir, "reset", "-q", "--hard", "HEAD~2");
    expect(gate(dir).ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("other export names fail too, .env.example does not", () => {
    for (const name of ["my_spotify_data.zip", "Streaming_History_Audio_2020_0.json", "musicbrainz-cache.json", ".env", "spotify.json", "listening.tsv"]) {
      const dir = repo();
      writeFileSync(join(dir, name), "{}");
      git(dir, "add", "-f", name);
      expect(gate(dir).ok, name).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a network address or a personal key fails; documentation and loopback addresses pass", () => {
    const dir = repo();
    writeFileSync(join(dir, "notes.md"), `example ${[192, 0, 2, 1].join(".")} and ${["2001", "db8", "", "1"].join(":")} and ${[127, 0, 0, 1].join(".")}\n`);
    commit(dir, "doc ranges");
    expect(gate(dir).ok).toBe(true);
    writeFileSync(join(dir, "fixture.json"), `{"ts": "x", "addr": "${[10, 20, 30, 40].join(".")}"}`);
    git(dir, "add", "fixture.json");
    expect(gate(dir).out).toContain("network address");
    writeFileSync(join(dir, "fixture.json"), `{"${"ip" + "_addr"}": null}`);
    git(dir, "add", "fixture.json");
    expect(gate(dir).out).toContain("personal key");
    writeFileSync(join(dir, "fixture.json"), `{"v6": "${["fd12", "3456", "789a", "1", "", "1"].join(":")}"}`);
    git(dir, "add", "fixture.json");
    expect(gate(dir).ok).toBe(false);
    git(dir, "rm", "-q", "-f", "fixture.json");
    expect(gate(dir).ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a private marker fails in a file and in history; passes once removed from both", () => {
    const dir = repo();
    const markers = join(mkdtempSync(join(tmpdir(), "public-gate-markers-")), "markers.txt");
    writeFileSync(markers, "# names that must never be public\nZebrafinch Quartet\n\n");
    expect(gate(dir, markers).out).toContain("1 checked");
    writeFileSync(join(dir, "hint.ts"), "// play it in the zebrafinch quartet room\n");
    commit(dir, "leak");
    expect(gate(dir, markers).out).toContain("hint.ts: contains private marker #1");
    writeFileSync(join(dir, "hint.ts"), "// play it in a room\n");
    commit(dir, "fix file only");
    const r = gate(dir, markers);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("git history");
    expect(r.out).not.toContain("Zebrafinch"); // the gate never prints the marker itself
    git(dir, "reset", "-q", "--hard", "HEAD~2");
    expect(gate(dir, markers).ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("inside a larger repository it checks only its own folder", () => {
    const dir = repo();
    const pkg = join(dir, "catalogue", "connectors", "demo");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "README.md"), "# pkg\n");
    writeFileSync(join(dir, "elsewhere.csv"), "a,b\r\n");
    commit(dir, "monorepo");
    const ok = gate(pkg);
    expect(ok.out).toContain("folder catalogue/connectors/demo");
    expect(ok.ok).toBe(true);
    writeFileSync(join(pkg, "export.csv"), "a,b\r\n");
    commit(dir, "leak in pkg");
    expect(gate(pkg).ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
