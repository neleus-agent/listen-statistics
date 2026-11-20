import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseCsv, toCsv } from "../library/csv.js";
import { readZipEntries } from "./zip.js";

/**
 * Spotify "Extended streaming history" -> ONE aggregated per-track file (tracks-history.csv).
 *
 * PRIVACY CONTRACT (tested): each stream is reduced to KEPT_FIELDS the moment it is parsed. Every other
 * field Spotify includes (network address, device, country, client, episode fields, ...) is never copied
 * into anything we keep, and only per-track aggregates are written; no raw stream rows ever reach disk.
 */
export const KEPT_FIELDS = [
  "spotify_track_uri",
  "ts",
  "ms_played",
  "skipped",
  "master_metadata_track_name",
  "master_metadata_album_artist_name",
  "master_metadata_album_album_name",
] as const;

/** Spotify's own threshold for a counted play. */
export const PLAY_MS = 30_000;

export const HISTORY_FILE = "tracks-history.csv";

export const HIST_COLUMNS = [
  "hist_plays",
  "hist_streams",
  "hist_minutes",
  "hist_skip_rate",
  "hist_first_played",
  "hist_last_played",
  "hist_peak_year",
  "hist_plays_by_year",
  "in_library",
] as const;

export interface Stream {
  uri: string;
  ts: string;
  ms: number;
  skipped: boolean;
  track: string;
  artist: string;
  album: string;
}

const isHistoryFile = (name: string) => /^Streaming_History_Audio_.*\.json$/i.test(basename(name));
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Allowlist one raw stream record. Returns null for podcasts, audiobooks and anything without a track URI. */
export function pickStream(raw: unknown): Stream | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const uri = str(r.spotify_track_uri);
  if (!uri.startsWith("spotify:track:")) return null;
  const ms = Number(r.ms_played);
  return {
    uri,
    ts: str(r.ts),
    ms: Number.isFinite(ms) && ms > 0 ? ms : 0,
    skipped: r.skipped === true,
    track: str(r.master_metadata_track_name),
    artist: str(r.master_metadata_album_artist_name),
    album: str(r.master_metadata_album_album_name),
  };
}

export interface TrackAgg {
  plays: number;
  streams: number;
  ms: number;
  skips: number;
  first: string;
  last: string;
  track: string;
  artist: string;
  album: string;
  years: Map<string, number>;
}

/** Fold streams into per-track aggregates (same semantics as the original reference script). */
export function aggregate(streams: Iterable<Stream>, agg = new Map<string, TrackAgg>()): Map<string, TrackAgg> {
  for (const s of streams) {
    let a = agg.get(s.uri);
    if (!a) {
      a = { plays: 0, streams: 0, ms: 0, skips: 0, first: "", last: "", track: "", artist: "", album: "", years: new Map() };
      agg.set(s.uri, a);
    }
    a.streams++;
    a.ms += s.ms;
    if (s.ms >= PLAY_MS) {
      a.plays++;
      const y = s.ts.slice(0, 4);
      if (y) a.years.set(y, (a.years.get(y) ?? 0) + 1);
    }
    if (s.skipped) a.skips++;
    if (s.ts && (!a.first || s.ts < a.first)) a.first = s.ts;
    if (s.ts > a.last) a.last = s.ts;
    a.track = s.track || a.track;
    a.artist = s.artist || a.artist;
    a.album = s.album || a.album;
  }
  return agg;
}

/** The history columns for one track (zero plays + blanks when it was never played). */
export function histColumns(a: TrackAgg | undefined, inLibrary: boolean): Record<string, string | number> {
  if (!a) {
    return { hist_plays: 0, hist_streams: 0, hist_minutes: 0, hist_skip_rate: "", hist_first_played: "", hist_last_played: "", hist_peak_year: "", hist_plays_by_year: "", in_library: String(inLibrary) };
  }
  const years = [...a.years.entries()].sort((x, y) => x[0].localeCompare(y[0]));
  let peak = "";
  let best = 0;
  for (const [y, n] of years) if (n > best) { best = n; peak = y; } // ties -> earliest year
  return {
    hist_plays: a.plays,
    hist_streams: a.streams,
    hist_minutes: Math.round(a.ms / 60000),
    hist_skip_rate: a.streams ? Math.round((a.skips / a.streams) * 100) / 100 : "",
    hist_first_played: a.first.slice(0, 10),
    hist_last_played: a.last.slice(0, 10),
    hist_peak_year: peak,
    hist_plays_by_year: years.map(([y, n]) => `${y}:${n}`).join(";"),
    in_library: String(inLibrary),
  };
}

/** Read every Streaming_History_Audio_*.json from a zip or a folder (recursively), allowlisting as it goes. */
export async function readHistory(path: string): Promise<{ agg: Map<string, TrackAgg>; files: number; streams: number }> {
  const agg = new Map<string, TrackAgg>();
  let files = 0;
  let streams = 0;
  const fold = (text: string, name: string) => {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error(`${name}: expected a JSON array of streams`);
    files++;
    const picked: Stream[] = [];
    for (const raw of parsed) { const s = pickStream(raw); if (s) picked.push(s); }
    streams += picked.length;
    aggregate(picked, agg);
  };
  if ((await stat(path)).isDirectory()) {
    const names = (await readdir(path, { recursive: true })).map(String).filter(isHistoryFile).sort();
    for (const n of names) fold(await readFile(join(path, n), "utf8"), n);
  } else {
    const entries = readZipEntries(await readFile(path), isHistoryFile).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) fold(e.data.toString("utf8"), e.name);
  }
  if (!files) throw new Error(`no Streaming_History_Audio_*.json found in ${path}. Is this the Extended streaming history export?`);
  return { agg, files, streams };
}

/**
 * Library rows (one per playlist entry) get the history columns; tracks you played that are in no exported
 * playlist are appended once each (playlist empty, in_library=false). One aggregated row per track, never raw.
 */
export function joinHistory(lib: { headers: string[]; rows: Record<string, string>[] }, agg: Map<string, TrackAgg>) {
  const base = lib.headers.length ? lib.headers : ["playlist", "track", "artists", "album", "track_uri"];
  const headers = [...base.filter((h) => !(HIST_COLUMNS as readonly string[]).includes(h)), ...HIST_COLUMNS];
  const libUris = new Set(lib.rows.map((r) => r.track_uri).filter(Boolean));
  const rows: Record<string, unknown>[] = lib.rows.map((r) => ({ ...r, ...histColumns(agg.get(r.track_uri), true) }));
  const extra = [...agg.entries()].filter(([u]) => !libUris.has(u)).sort((x, y) => y[1].plays - x[1].plays || y[1].ms - x[1].ms);
  for (const [uri, a] of extra) rows.push({ playlist: "", track: a.track, artists: a.artist, album: a.album, track_uri: uri, ...histColumns(a, false) });
  const matched = lib.rows.filter((r) => agg.has(r.track_uri)).length;
  return { headers, rows, matched, notInLibrary: extra.length };
}

/** Newest `spotify-export-*` folder under the export base, or undefined. */
export async function latestExportDir(base: string): Promise<string | undefined> {
  try {
    const dirs = (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name.startsWith("spotify-export-")).map((d) => d.name).sort();
    return dirs.length ? join(base, dirs[dirs.length - 1]) : undefined;
  } catch {
    return undefined;
  }
}

/** First existing file among `names` in `dir`. */
export async function firstExisting(dir: string | undefined, names: string[]): Promise<string | undefined> {
  if (!dir) return undefined;
  for (const n of names) {
    try { if ((await stat(join(dir, n))).isFile()) return join(dir, n); } catch { /* next */ }
  }
  return undefined;
}

export interface ImportOptions {
  input: string;
  /** library CSV to join onto (tracks-enriched.csv or tracks.csv); without one, only history rows are written. */
  library?: string;
  /** output folder; default = the library CSV's folder. */
  outDir?: string;
}

export async function importHistory(opts: ImportOptions) {
  const { agg, files, streams } = await readHistory(opts.input);
  const lib = opts.library ? parseCsv(await readFile(opts.library, "utf8")) : { headers: [], rows: [] };
  const outDir = opts.outDir ?? (opts.library ? dirname(opts.library) : undefined);
  if (!outDir) throw new Error("no library CSV found: pass --library <tracks-enriched.csv> or --out <folder>");
  const joined = joinHistory(lib, agg);
  const output = join(outDir, HISTORY_FILE);
  await writeFile(output, toCsv(joined.headers, joined.rows), "utf8");
  let plays = 0;
  let ms = 0;
  for (const a of agg.values()) { plays += a.plays; ms += a.ms; }
  return {
    output,
    history_files: files,
    music_streams: streams,
    distinct_tracks: agg.size,
    counted_plays: plays,
    hours: Math.round(ms / 3_600_000),
    library_rows: lib.rows.length,
    library_rows_with_history: joined.matched,
    played_not_in_library: joined.notInLibrary,
  };
}
