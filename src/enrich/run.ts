import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseCsv, toCsv } from "../library/csv.js";
import { createMbClient, emptyCache, enrichWithMusicBrainz, MB_COLUMNS, type MbCache } from "./musicbrainz.js";
import { applyPopularity, deezer, emptyPopCache, lastfmMyPlays, lastfmTracks, listenBrainz, POP_COLUMNS, type PopCache } from "./popularity.js";

export interface EnrichFileOptions {
  input: string;
  output?: string;
  cachePath: string;
  /** cache for ListenBrainz + Deezer answers (required with `popularity`). */
  popCachePath?: string;
  popularity?: boolean;
  /** Last.fm key (+ optional user for your own play counts); used with `popularity`. */
  lastfm?: { apiKey: string; user?: string };
  ratings?: boolean;
  maxRatings?: number;
  log?: (m: string) => void;
}

/** MusicBrainz asks every client for an identifying User-Agent; MUSICBRAINZ_CONTACT adds your own contact. */
export function mbUserAgent(): string {
  return `listen-statistics/0.3.0 ( ${process.env.MUSICBRAINZ_CONTACT || "open-source MCP connector"} )`;
}

async function loadJson<T extends object>(path: string | undefined, empty: () => T): Promise<T> {
  if (!path) return empty();
  try {
    return { ...empty(), ...(JSON.parse(await readFile(path, "utf8")) as Partial<T>) };
  } catch {
    return empty();
  }
}

async function saveJson(path: string | undefined, data: unknown): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(data), "utf8");
  await rename(`${path}.tmp`, path);
}

/**
 * tracks.csv -> tracks-enriched.csv (input untouched). Passes: MusicBrainz -> popularity -> WRITE -> album ratings
 * (slow, 1 per second) -> WRITE again, so a usable file exists long before the ratings finish. Caches are
 * checkpointed after every batch, so any pass can be interrupted and resumed.
 */
export async function enrichFile(opts: EnrichFileOptions) {
  const log = opts.log ?? (() => {});
  const { headers, rows } = parseCsv(await readFile(opts.input, "utf8"));
  const cache = await loadJson<MbCache>(opts.cachePath, emptyCache);
  const pop = await loadJson<PopCache>(opts.popCachePath, emptyPopCache);
  const checkpoint = () => saveJson(opts.cachePath, cache);
  const popCheckpoint = () => saveJson(opts.popCachePath, pop);
  const ua = mbUserAgent();
  const mb = createMbClient({ userAgent: ua });
  const out = opts.output ?? join(dirname(opts.input), "tracks-enriched.csv");
  const extra = [...MB_COLUMNS, ...(opts.popularity ? POP_COLUMNS : [])] as string[];
  const cols = [...headers.filter((h) => !extra.includes(h)), ...extra];

  let res = await enrichWithMusicBrainz(mb, rows, cache, { ratings: false, log, checkpoint });
  let myPlays: Map<string, number> | undefined;
  if (opts.popularity) {
    log("Popularity 1/2: ListenBrainz listeners per song...");
    await listenBrainz(res.rows.map((r) => r.mb_recording_id).filter(Boolean), pop, { userAgent: ua, log, checkpoint: popCheckpoint });
    log("Popularity 2/2: Deezer rank per song (about 8 per second)...");
    await deezer(res.rows.map((r) => r.isrc).filter(Boolean), pop, { userAgent: ua, log, checkpoint: popCheckpoint });
    if (opts.lastfm) {
      log("Popularity 3/3: Last.fm listeners per song (about 4 per second)...");
      await lastfmTracks(res.rows, pop, { userAgent: ua, apiKey: opts.lastfm.apiKey, log, checkpoint: popCheckpoint });
      if (opts.lastfm.user) {
        myPlays = await lastfmMyPlays({ userAgent: ua, apiKey: opts.lastfm.apiKey, user: opts.lastfm.user });
        log(`Your Last.fm play counts: ${myPlays.size} songs scrobbled so far.`);
      }
    }
  }
  const finish = async (enriched: Record<string, string>[]) => {
    const final = opts.popularity ? applyPopularity(enriched, pop, myPlays) : enriched;
    await writeFile(out, toCsv(cols, final), "utf8");
    return final;
  };
  let final = await finish(res.rows);
  if (opts.ratings) {
    log(`Wrote ${out}. Now album ratings...`);
    res = await enrichWithMusicBrainz(mb, rows, cache, { ratings: true, maxRatings: opts.maxRatings, log, checkpoint });
    final = await finish(res.rows);
  }
  await checkpoint();
  await popCheckpoint();
  const count = (f: (r: Record<string, string>) => boolean) => final.filter(f).length;
  return {
    output: out,
    rows: final.length,
    matched_by_isrc: count((r) => r.mb_match === "isrc"),
    matched_by_artist_name: count((r) => r.mb_match === "artist-name"),
    unmatched: count((r) => r.mb_match === "none"),
    with_genre: count((r) => !!r.primary_genre),
    with_country: count((r) => !!r.artist_country),
    with_original_year: count((r) => !!r.original_year),
    with_popularity: opts.popularity ? count((r) => !!r.popularity) : undefined,
    with_album_rating: count((r) => !!r.album_rating),
    albums_without_rating_lookup_yet: res.ratingsLeft,
  };
}
