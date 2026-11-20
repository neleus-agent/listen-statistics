import { mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { HIST_COLUMNS, importHistory, KEPT_FIELDS, pickStream } from "../../src/history/import.js";
import { parseCsv } from "../../src/library/csv.js";
import { DROPPED_KEYS, DROPPED_VALUES, historyFiles, LIBRARY_CSV, makeZip, podcast, stream, uri } from "./synthetic.js";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "history-test-"));
  const files = historyFiles();
  const zip = join(dir, "my_spotify_data.zip");
  await writeFile(zip, makeZip(Object.fromEntries(Object.entries(files).map(([n, rows]) => [n, JSON.stringify(rows)]))));
  const folder = join(dir, "unzipped");
  for (const [n, rows] of Object.entries(files)) {
    await mkdir(dirname(join(folder, n)), { recursive: true });
    await writeFile(join(folder, n), JSON.stringify(rows));
  }
  const lib = join(dir, "export");
  await mkdir(lib);
  await writeFile(join(lib, "tracks.csv"), LIBRARY_CSV);
  return { dir, zip, folder, library: join(lib, "tracks.csv") };
}

const byUri = (rows: Record<string, string>[], u: string) => rows.filter((r) => r.track_uri === u);

describe("pickStream (allowlist)", () => {
  it("keeps only the seven kept fields' values and nothing else", () => {
    const s = pickStream(stream(1, "2020-01-01T00:00:00Z", 45000, { skipped: true }))!;
    expect(Object.keys(s).sort()).toEqual(["album", "artist", "ms", "skipped", "track", "ts", "uri"]);
    expect(JSON.stringify(s)).not.toContain(DROPPED_VALUES.device);
    expect(KEPT_FIELDS).toHaveLength(7);
  });
  it("skips podcasts, audiobooks and junk", () => {
    expect(pickStream(podcast("2020-01-01T00:00:00Z"))).toBeNull();
    expect(pickStream({ ts: "x", spotify_track_uri: "spotify:episode:abc" })).toBeNull();
    expect(pickStream(null)).toBeNull();
    expect(pickStream("text")).toBeNull();
  });
});

describe("importHistory", () => {
  it("aggregates per track and joins onto the library (zip input)", async () => {
    const { zip, library } = await setup();
    const sum = await importHistory({ input: zip, library });
    expect(sum).toMatchObject({ history_files: 2, music_streams: 9, distinct_tracks: 3, counted_plays: 7, library_rows: 4, library_rows_with_history: 3, played_not_in_library: 1 });
    expect(sum.output).toBe(join(dirname(library), "tracks-history.csv"));
    const { headers, rows } = parseCsv(await readFile(sum.output, "utf8"));
    for (const c of HIST_COLUMNS) expect(headers).toContain(c);

    const t1 = byUri(rows, uri(1))[0];
    expect(t1).toMatchObject({ playlist: "Road Trip", hist_plays: "3", hist_streams: "4", hist_minutes: "10", hist_skip_rate: "0.25",
      hist_first_played: "2018-05-01", hist_last_played: "2019-02-01", hist_peak_year: "2018", hist_plays_by_year: "2018:2;2019:1", in_library: "true" });
    // a track in two playlists keeps one row per playlist, both with the same aggregates
    const t2 = byUri(rows, uri(2));
    expect(t2.map((r) => r.playlist)).toEqual(["Road Trip", "Liked Songs"]);
    for (const r of t2) expect(r).toMatchObject({ hist_plays: "2", hist_streams: "3", hist_skip_rate: "0.33", hist_peak_year: "2023", hist_plays_by_year: "2023:1;2024:1" });
    // in the library but never played
    expect(byUri(rows, uri(9))[0]).toMatchObject({ hist_plays: "0", hist_first_played: "", in_library: "true" });
    // played but in no playlist: one appended aggregate row, names from the history
    const t3 = byUri(rows, uri(3));
    expect(t3).toHaveLength(1);
    expect(t3[0]).toMatchObject({ playlist: "", track: "Invented Song 3", artists: "Fictional Band 0", hist_plays: "2", in_library: "false" });
    expect(rows).toHaveLength(5);
  });

  it("reads an unzipped folder the same way", async () => {
    const { folder, library, dir } = await setup();
    const out = join(dir, "out");
    await mkdir(out);
    const sum = await importHistory({ input: folder, library, outDir: out });
    expect(sum.counted_plays).toBe(7);
    expect(sum.output).toBe(join(out, "tracks-history.csv"));
  });

  it("works without a library export when --out is given", async () => {
    const { zip, dir } = await setup();
    const sum = await importHistory({ input: zip, outDir: dir });
    const { rows } = parseCsv(await readFile(sum.output, "utf8"));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.in_library === "false")).toBe(true);
    expect(rows[0].track_uri).toBe(uri(1)); // most plays first
  });

  it("refuses a folder without history files", async () => {
    const { dir } = await setup();
    await expect(importHistory({ input: join(dir, "export"), outDir: dir })).rejects.toThrow(/Streaming_History_Audio/);
  });

  it("PRIVACY: the output never contains a dropped field name or value, and only one file is written", async () => {
    const { zip, library } = await setup();
    const before = await readdir(dirname(library));
    const sum = await importHistory({ input: zip, library });
    const after = await readdir(dirname(library));
    expect(after.filter((f) => !before.includes(f))).toEqual(["tracks-history.csv"]);
    const text = await readFile(sum.output, "utf8");
    for (const k of DROPPED_KEYS) expect(text).not.toContain(k);
    for (const v of Object.values(DROPPED_VALUES)) expect(text).not.toContain(v);
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(text).not.toContain("Imaginary Episode");
    expect(text).not.toContain("2018-05-01T10:00:00Z"); // no raw timestamps, dates only
    expect(JSON.stringify(sum)).not.toContain(DROPPED_VALUES.device);
  });
});
