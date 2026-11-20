// Guardrail: no test, fixture or example file may carry a network address or a personal streaming field.
// Fixtures are synthetic; real exports are gitignored. If this fails, you pasted real data: remove it.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Built from fragments so this file does not trip its own scan.
const FIELDS = ["ip_" + "addr", "conn_" + "country", "plat" + "form"];
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|\b(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4})?\b/gi;
const LOOPBACK = new Set(["127.0.0.1", "0.0.0.0"]);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/** test/** plus any data-shaped file (csv, json, zip) anywhere in the connector except the npm/ts config. */
async function scanned(): Promise<string[]> {
  const all = await walk(ROOT);
  const config = new Set(["package.json", "package-lock.json", "tsconfig.json"]);
  return all.filter((p) => {
    const rel = relative(ROOT, p).replace(/\\/g, "/");
    if (rel.startsWith("test/")) return true;
    return /\.(csv|json|zip)$/i.test(rel) && !config.has(rel);
  });
}

function findings(text: string): string[] {
  const hits: string[] = [];
  for (const m of text.match(IPV4) ?? []) if (!LOOPBACK.has(m) && m.split(".").every((o) => Number(o) <= 255)) hits.push(`IPv4 ${m}`);
  for (const m of text.match(IPV6) ?? []) hits.push(`IPv6 ${m}`);
  for (const f of FIELDS) {
    // a JSON/JS key (`"f":`, `f:`) or a CSV header cell
    if (new RegExp(`["']?\\b${f}\\b["']?\\s*:`).test(text) || new RegExp(`(^|[,\\r\\n])"?${f}"?(,|\\r?\\n|$)`).test(text)) hits.push(`field ${f}`);
  }
  return hits;
}

describe("privacy: committed fixtures and tests", () => {
  it("the scanner catches what it must", () => {
    expect(findings(`{"${FIELDS[0]}": "x"}`)).toEqual([`field ${FIELDS[0]}`]);
    expect(findings(`ts,${FIELDS[1]},ms\r\n`)).toEqual([`field ${FIELDS[1]}`]);
    expect(findings(`a ${[10, 1, 2, 3].join(".")} b`)).toHaveLength(1);
    expect(findings(`a ${["fe80", "", "1"].join(":")} b`)).toHaveLength(1);
    expect(findings("http://127.0.0.1:8888/callback at 12:34:56 v1.2.3")).toEqual([]);
  });

  it("no test or fixture file contains a network address or a personal streaming field", async () => {
    const files = await scanned();
    expect(files.length).toBeGreaterThan(5);
    const bad: string[] = [];
    for (const f of files) for (const h of findings(await readFile(f, "utf8"))) bad.push(`${relative(ROOT, f)}: ${h}`);
    expect(bad).toEqual([]);
  });

  it(".gitignore blocks exports, CSVs and history JSON", async () => {
    const gi = await readFile(join(ROOT, ".gitignore"), "utf8");
    for (const rule of ["*.csv", "*.json", "my_spotify_data*", "*.zip"]) expect(gi.split(/\r?\n/)).toContain(rule);
  });
});
