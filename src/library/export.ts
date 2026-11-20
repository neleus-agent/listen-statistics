import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";
import type { Http } from "../client/http.js";
import { SpotifyError } from "../client/error.js";
import { getMe, listPlaylists, getPlaylistEntries, getLikedEntries, type LibraryEntry, type PlaylistSummary } from "./library.js";
import { artistGenres, audioFeatures, keyName, type AudioFeatures } from "./enrich.js";
import { toCsv } from "./csv.js";

export const TRACK_COLUMNS = [
  "playlist", "playlist_id", "position", "added_at",
  "track", "artists", "album", "album_type", "release_date", "year",
  "duration", "duration_ms", "explicit", "isrc", "genres",
  "tempo", "key", "time_signature", "energy", "danceability", "valence",
  "type", "is_local", "track_uri", "track_id",
] as const;

export const PLAYLIST_COLUMNS = [
  "playlist", "playlist_id", "owner", "owned", "collaborative", "public", "tracks_listed", "tracks_exported", "status",
] as const;

export interface ExportOptions {
  outDir: string;
  /** include Liked Songs as a pseudo-playlist (default true). */
  includeLiked?: boolean;
  /** genres + audio features (default true). Off = one pass, no per-artist calls. */
  enrich?: boolean;
  /** JSON file caching artist -> genres across runs, so a rate-limited pass resumes (default: none). */
  genreCachePath?: string;
  /** pause between artist calls in ms (default 250). */
  genreDelayMs?: number;
  /** only these playlist ids (default: all). */
  only?: string[];
  log?: (msg: string) => void;
}

export interface ExportSummary {
  user: string;
  out_dir: string;
  files: string[];
  playlists_found: number;
  playlists_exported: number;
  playlists_skipped: { name: string; id: string; reason: string }[];
  rows: number;
  unique_tracks: number;
  genres: "filled" | "partial" | "skipped";
  /** artists still without genres; re-run export to continue (uses the cache). */
  genres_remaining: number;
  audio_features: "filled" | "unavailable" | "skipped";
  notes: string[];
}

function fmtDuration(ms: number | undefined): string {
  if (!ms && ms !== 0) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const round = (n: number | null | undefined, d: number) => (n == null ? "" : Number(n.toFixed(d)));

/** One CSV row for a playlist entry (enrichment maps may be empty). */
export function toRow(
  pl: { name: string; id: string },
  position: number,
  e: LibraryEntry,
  genres: Map<string, string[]>,
  features: Map<string, AudioFeatures>,
): Record<string, unknown> {
  const t = e.track!;
  const release = t.album?.release_date ?? t.release_date ?? "";
  const artistIds = (t.artists ?? []).map((a) => a.id).filter((x): x is string => !!x);
  const g = [...new Set(artistIds.flatMap((id) => genres.get(id) ?? []))];
  const f = t.id ? features.get(t.id) : undefined;
  return {
    playlist: pl.name,
    playlist_id: pl.id,
    position,
    added_at: e.added_at ?? "",
    track: t.name,
    artists: (t.artists ?? []).map((a) => a.name).join("; ") || t.show?.publisher || "",
    album: t.album?.name ?? t.show?.name ?? "",
    album_type: t.album?.album_type ?? "",
    release_date: release,
    year: release.slice(0, 4),
    duration: fmtDuration(t.duration_ms),
    duration_ms: t.duration_ms ?? "",
    explicit: t.explicit ? "yes" : "no",
    isrc: t.external_ids?.isrc ?? "",
    genres: g.join("; "),
    tempo: round(f?.tempo, 1),
    key: keyName(f?.key, f?.mode),
    time_signature: f?.time_signature ?? "",
    energy: round(f?.energy, 3),
    danceability: round(f?.danceability, 3),
    valence: round(f?.valence, 3),
    type: t.type ?? "track",
    is_local: t.is_local ? "yes" : "no",
    track_uri: t.uri,
    track_id: t.id ?? "",
  };
}

/**
 * Export every readable playlist (plus Liked Songs) to <outDir>/tracks.csv and <outDir>/playlists.csv.
 * Playlists the user only FOLLOWS (Spotify-made, other users') have no readable items for a dev-mode app since
 * February 2026; they are listed in playlists.csv with status "skipped: ..." rather than silently dropped.
 */
export async function exportLibrary(http: Http, opts: ExportOptions): Promise<ExportSummary> {
  const log = opts.log ?? (() => {});
  const enrich = opts.enrich ?? true;
  const me = await getMe(http);
  let playlists: PlaylistSummary[] = await listPlaylists(http, me);
  if (opts.only?.length) playlists = playlists.filter((p) => opts.only!.includes(p.id));
  log(`Found ${playlists.length} playlists for ${me.display_name ?? me.id}.`);

  const collected: { pl: { name: string; id: string }; entries: LibraryEntry[] }[] = [];
  const plRows: Record<string, unknown>[] = [];
  const skipped: ExportSummary["playlists_skipped"] = [];

  if (opts.includeLiked ?? true) {
    try {
      const liked = await getLikedEntries(http);
      collected.push({ pl: { name: "Liked Songs", id: "liked" }, entries: liked });
      plRows.push({ playlist: "Liked Songs", playlist_id: "liked", owner: me.display_name ?? me.id, owned: "yes", collaborative: "no", public: "no", tracks_listed: liked.length, tracks_exported: liked.filter((e) => e.track).length, status: "exported" });
      log(`Liked Songs: ${liked.length}`);
    } catch (e) {
      if (e instanceof SpotifyError && e.code === "NOT_AUTHENTICATED") throw e;
      const reason = e instanceof Error ? e.message : String(e);
      skipped.push({ name: "Liked Songs", id: "liked", reason });
      plRows.push({ playlist: "Liked Songs", playlist_id: "liked", status: `skipped: ${reason}` });
    }
  }

  for (const [i, p] of playlists.entries()) {
    const base = { playlist: p.name, playlist_id: p.id, owner: p.owner_name ?? p.owner_id, owned: p.owned ? "yes" : "no", collaborative: p.collaborative ? "yes" : "no", public: p.public === null ? "" : p.public ? "yes" : "no", tracks_listed: p.total ?? "" };
    try {
      const entries = await getPlaylistEntries(http, p.id);
      collected.push({ pl: { name: p.name, id: p.id }, entries });
      plRows.push({ ...base, tracks_exported: entries.filter((e) => e.track).length, status: "exported" });
      log(`[${i + 1}/${playlists.length}] ${p.name}: ${entries.length}`);
    } catch (e) {
      if (e instanceof SpotifyError && (e.code === "NOT_AUTHENTICATED" || e.code === "INSUFFICIENT_SCOPE")) throw e;
      const reason = e instanceof SpotifyError && (e.status === 403 || e.status === 404) && !p.owned && !p.collaborative
        ? "not yours: Spotify hides the tracks of followed playlists from development-mode apps"
        : e instanceof Error ? e.message : String(e);
      skipped.push({ name: p.name, id: p.id, reason });
      plRows.push({ ...base, tracks_exported: 0, status: `skipped: ${reason}` });
      log(`[${i + 1}/${playlists.length}] ${p.name}: skipped (${reason})`);
    }
  }

  const tracks = collected.flatMap((c) => c.entries.map((e) => e.track)).filter((t): t is NonNullable<typeof t> => !!t);
  const trackIds = tracks.filter((t) => t.type !== "episode" && !t.is_local && t.id).map((t) => t.id!);
  const artistIds = tracks.flatMap((t) => (t.artists ?? []).map((a) => a.id)).filter((x): x is string => !!x);

  let genres = new Map<string, string[]>();
  let features = new Map<string, AudioFeatures>();
  let featureState: ExportSummary["audio_features"] = "skipped";
  let genreState: ExportSummary["genres"] = "skipped";
  let genresRemaining = 0;
  const notes: string[] = [];
  // Enrichment is best-effort: whatever happens here, the CSV below is still written.
  if (enrich) {
    try {
      const af = await audioFeatures(http, trackIds);
      features = af.features;
      featureState = af.available ? "filled" : "unavailable";
      if (af.note) notes.push(af.note);
    } catch (e) {
      featureState = "unavailable";
      notes.push(`audio features failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const cache = await loadCache(opts.genreCachePath);
    const unique = new Set(artistIds).size;
    log(`Audio features: ${featureState}. Genres for ${unique} artists (${[...new Set(artistIds)].filter((id) => cache.has(id)).length} cached)...`);
    try {
      const g = await artistGenres(http, artistIds, {
        cache,
        delayMs: opts.genreDelayMs,
        onProgress: (d, n) => log(`  genres ${d}/${n}`),
        onCheckpoint: () => saveCache(opts.genreCachePath, cache),
      });
      genres = g.genres;
      genresRemaining = g.remaining;
      genreState = g.remaining ? "partial" : "filled";
      if (g.blockedUntil) {
        notes.push(`Spotify blocked artist lookups until ${g.blockedUntil}; ${g.remaining} artists left. Re-run export after that to fill them (cached artists are not fetched again).`);
      }
    } catch (e) {
      genreState = "partial";
      genresRemaining = unique - genres.size;
      notes.push(`genre lookup stopped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const rows = collected.flatMap(({ pl, entries }) =>
    entries.flatMap((e, idx) => (e.track ? [toRow(pl, idx + 1, e, genres, features)] : [])),
  );

  await mkdir(opts.outDir, { recursive: true });
  const tracksFile = join(opts.outDir, "tracks.csv");
  const playlistsFile = join(opts.outDir, "playlists.csv");
  await writeFile(tracksFile, toCsv(TRACK_COLUMNS, rows), "utf8");
  await writeFile(playlistsFile, toCsv(PLAYLIST_COLUMNS, plRows), "utf8");

  return {
    user: me.display_name ?? me.id,
    out_dir: opts.outDir,
    files: [tracksFile, playlistsFile],
    playlists_found: playlists.length,
    playlists_exported: collected.length,
    playlists_skipped: skipped,
    rows: rows.length,
    unique_tracks: new Set(rows.map((r) => r.track_uri)).size,
    genres: genreState,
    genres_remaining: genresRemaining,
    audio_features: featureState,
    notes,
  };
}

async function loadCache(path?: string): Promise<Map<string, string[]>> {
  if (!path) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(await readFile(path, "utf8")) as Record<string, string[]>));
  } catch {
    return new Map();
  }
}

async function saveCache(path: string | undefined, cache: Map<string, string[]>): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(Object.fromEntries(cache)), "utf8");
  await rename(`${path}.tmp`, path);
}
