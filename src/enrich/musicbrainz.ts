/**
 * MusicBrainz enrichment of an exported tracks.csv. Free, keyless, open data (CC0 core data), no Spotify quota.
 *
 * MusicBrainz allows ONE request per second per client, so everything that can be batched is batched through
 * the search API (Lucene OR-queries, up to 100 hits per page):
 *   1. recordings by ISRC, 40 per query   -> MB recording, original release year, first credited artist,
 *                                            the album (release group) it first appeared on
 *   2. artists by MBID, 40 per query      -> country, area, home town, type, years active, genre tags
 *   3. artists by NAME for rows with no ISRC match (exact-name match only)
 *   4. optional: album ratings, one lookup per release group (the only route that returns ratings)
 * Every answer is cached on disk, so an interrupted run resumes and a re-run costs nothing.
 */

export const MB_BASE = "https://musicbrainz.org/ws/2";

export interface MbRecording {
  id: string;
  title?: string;
  "first-release-date"?: string;
  isrcs?: string[];
  tags?: { name: string; count: number }[];
  "artist-credit"?: { name?: string; artist: { id: string; name: string } }[];
  releases?: { "release-group"?: { id: string; "primary-type"?: string; "secondary-types"?: string[] }; date?: string }[];
}

export interface MbArtist {
  id: string;
  name: string;
  type?: string;
  country?: string;
  area?: { name?: string; type?: string };
  "begin-area"?: { name?: string };
  "life-span"?: { begin?: string; end?: string };
  tags?: { name: string; count: number }[];
  score?: number;
}

/** What we keep per ISRC / artist / release group (small, JSON-cacheable). */
export interface IsrcHit {
  rec: string;
  year: string;
  artist: string | null;
  artistName: string | null;
  rg: string | null;
  tags: string[];
}
export interface ArtistHit {
  name: string;
  type: string;
  country: string;
  area: string;
  beginArea: string;
  begin: string;
  end: string;
  genres: string[];
}
export interface RatingHit {
  value: number | null;
  votes: number;
}

export interface MbCache {
  isrc: Record<string, IsrcHit | null>;
  artist: Record<string, ArtistHit>;
  /** lower-cased artist name -> MBID (null = searched, not found). */
  name: Record<string, string | null>;
  rating: Record<string, RatingHit>;
}

export const emptyCache = (): MbCache => ({ isrc: {}, artist: {}, name: {}, rating: {} });

/** Minimal MB client: JSON GET with pacing and 503 / 429 backoff. Tests pass a fake. */
export interface MbClient {
  get<T>(pathAndQuery: string): Promise<T>;
}

export function createMbClient(opts: {
  userAgent: string;
  minIntervalMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): MbClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = opts.minIntervalMs ?? 1100;
  let last = 0;
  return {
    async get<T>(pathAndQuery: string): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        const wait = last + interval - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        const res = await fetchImpl(`${MB_BASE}${pathAndQuery}`, {
          headers: { "User-Agent": opts.userAgent, Accept: "application/json" },
        });
        if (res.ok) return (await res.json()) as T;
        // MB answers 503 when the shared server is busy, sometimes for a minute or more: be patient, it's free.
        if ((res.status === 503 || res.status === 429 || res.status >= 500) && attempt < 15) {
          const ra = parseInt(res.headers.get("retry-after") ?? "", 10);
          await sleep(Math.min((Number.isFinite(ra) ? ra : 2) * 1000 * (attempt + 1), 30_000));
          continue;
        }
        throw new Error(`MusicBrainz ${res.status} on ${pathAndQuery.slice(0, 80)}`);
      }
    },
  };
}

const q = (s: string) => encodeURIComponent(s);
/** Lucene phrase-escape for a name inside "..." */
const phrase = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;
const chunk = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** The MB genre vocabulary (a curated subset of tags), used to turn noisy tags into genres. */
export async function fetchGenreList(mb: MbClient): Promise<Set<string>> {
  const out = new Set<string>();
  for (let offset = 0; ; offset += 100) {
    const page = await mb.get<{ genres: { name: string }[]; "genre-count": number }>(`/genre/all?fmt=json&limit=100&offset=${offset}`);
    for (const g of page.genres ?? []) out.add(g.name.toLowerCase());
    if (!page.genres?.length || offset + 100 >= page["genre-count"]) break;
  }
  return out;
}

/** Tags -> genres: keep vocabulary hits with at least one vote, most-voted first. */
export function toGenres(tags: { name: string; count: number }[] | undefined, vocab: Set<string>, max = 5): string[] {
  return (tags ?? [])
    .filter((t) => t.count > 0 && (vocab.size === 0 || vocab.has(t.name.toLowerCase())))
    .sort((a, b) => b.count - a.count)
    .slice(0, max)
    .map((t) => t.name.toLowerCase());
}

/** Pick the album a recording belongs to: an Album without secondary types (not live / compilation) first. */
function pickReleaseGroup(rec: MbRecording): string | null {
  const rgs = (rec.releases ?? []).map((r) => r["release-group"]).filter((g): g is NonNullable<typeof g> => !!g);
  const studio = rgs.find((g) => g["primary-type"] === "Album" && !(g["secondary-types"] ?? []).length);
  return (studio ?? rgs.find((g) => g["primary-type"] === "Album") ?? rgs[0])?.id ?? null;
}

/** Resolve ISRCs to recordings in batches. Several recordings can share an ISRC: the earliest release wins. */
export async function resolveIsrcs(
  mb: MbClient,
  isrcs: string[],
  cache: MbCache,
  vocab: Set<string>,
  progress?: (done: number, total: number) => void,
  checkpoint?: () => Promise<void>,
): Promise<void> {
  const todo = [...new Set(isrcs)].filter((i) => i && !(i in cache.isrc));
  let done = 0;
  for (const batch of chunk(todo, 40)) {
    const want = new Set(batch.map((i) => i.toUpperCase()));
    const found = new Map<string, MbRecording>();
    for (let offset = 0; ; offset += 100) {
      const page = await mb.get<{ recordings: MbRecording[]; count: number }>(
        `/recording?fmt=json&limit=100&offset=${offset}&query=${q(batch.map((i) => `isrc:${i}`).join(" OR "))}`,
      );
      for (const rec of page.recordings ?? []) {
        for (const isrc of rec.isrcs ?? []) {
          const k = isrc.toUpperCase();
          if (!want.has(k)) continue;
          const prev = found.get(k);
          const y = rec["first-release-date"] || "9999";
          if (!prev || y < (prev["first-release-date"] || "9999")) found.set(k, rec);
        }
      }
      if (offset + 100 >= (page.count ?? 0) || offset >= 300) break;
    }
    for (const isrc of batch) {
      const rec = found.get(isrc.toUpperCase());
      const credit = rec?.["artist-credit"]?.[0]?.artist;
      cache.isrc[isrc] = rec
        ? {
            rec: rec.id,
            year: (rec["first-release-date"] ?? "").slice(0, 4),
            artist: credit?.id ?? null,
            artistName: credit?.name ?? null,
            rg: pickReleaseGroup(rec),
            tags: toGenres(rec.tags, vocab),
          }
        : null;
    }
    done += batch.length;
    progress?.(done, todo.length);
    await checkpoint?.();
  }
}

function toArtistHit(a: MbArtist, vocab: Set<string>): ArtistHit {
  return {
    name: a.name,
    type: a.type ?? "",
    country: a.country ?? "",
    area: a.area?.name ?? "",
    beginArea: a["begin-area"]?.name ?? "",
    begin: (a["life-span"]?.begin ?? "").slice(0, 4),
    end: (a["life-span"]?.end ?? "").slice(0, 4),
    genres: toGenres(a.tags, vocab),
  };
}

/** Fetch artist details for MBIDs in batches of 40. */
export async function resolveArtists(
  mb: MbClient,
  ids: string[],
  cache: MbCache,
  vocab: Set<string>,
  progress?: (done: number, total: number) => void,
  checkpoint?: () => Promise<void>,
): Promise<void> {
  const todo = [...new Set(ids)].filter((id) => id && !(id in cache.artist));
  let done = 0;
  for (const batch of chunk(todo, 40)) {
    const page = await mb.get<{ artists: MbArtist[] }>(`/artist?fmt=json&limit=100&query=${q(batch.map((id) => `arid:${id}`).join(" OR "))}`);
    for (const a of page.artists ?? []) cache.artist[a.id] = toArtistHit(a, vocab);
    done += batch.length;
    progress?.(done, todo.length);
    await checkpoint?.();
  }
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().trim();

/** Find artists by exact name (case-insensitive) for rows MB could not match by ISRC. Best score wins. */
export async function resolveArtistNames(
  mb: MbClient,
  names: string[],
  cache: MbCache,
  vocab: Set<string>,
  progress?: (done: number, total: number) => void,
  checkpoint?: () => Promise<void>,
): Promise<void> {
  const todo = [...new Set(names.map(norm))].filter((n) => n && !(n in cache.name));
  let done = 0;
  for (const batch of chunk(todo, 20)) {
    const page = await mb.get<{ artists: MbArtist[] }>(`/artist?fmt=json&limit=100&query=${q(batch.map((n) => `artist:${phrase(n)}`).join(" OR "))}`);
    for (const n of batch) {
      const hits = (page.artists ?? []).filter((a) => norm(a.name) === n).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const best = hits[0];
      cache.name[n] = best?.id ?? null;
      if (best && !(best.id in cache.artist)) cache.artist[best.id] = toArtistHit(best, vocab);
    }
    done += batch.length;
    progress?.(done, todo.length);
    await checkpoint?.();
  }
}

/** Album ratings: one lookup per release group (1/s). Bounded by `max` per run; resumable via the cache. */
export async function resolveRatings(
  mb: MbClient,
  rgIds: string[],
  cache: MbCache,
  max = Infinity,
  progress?: (done: number, total: number) => void,
  checkpoint?: () => Promise<void>,
): Promise<number> {
  const todo = [...new Set(rgIds)].filter((id) => id && !(id in cache.rating)).slice(0, max);
  let done = 0;
  for (const id of todo) {
    try {
      const rg = await mb.get<{ rating?: { value: number | null; "votes-count": number } }>(`/release-group/${id}?fmt=json&inc=ratings`);
      cache.rating[id] = { value: rg.rating?.value ?? null, votes: rg.rating?.["votes-count"] ?? 0 };
    } catch {
      cache.rating[id] = { value: null, votes: 0 };
    }
    done++;
    if (done % 25 === 0 || done === todo.length) {
      progress?.(done, todo.length);
      await checkpoint?.();
    }
  }
  return todo.length;
}

export const MB_COLUMNS = [
  "original_year", "primary_genre", "mb_genres", "artist_country", "artist_area", "artist_begin_area",
  "artist_type", "artist_active_from", "artist_active_to", "album_rating", "album_rating_votes",
  "mb_recording_id", "mb_artist_id", "mb_release_group_id", "mb_match",
] as const;

const firstArtist = (row: Record<string, string>) => (row.artists ?? "").split(";")[0].trim();

/** Merge cached MB data into one CSV row. Recording-level genres win over artist-level ones. */
export function enrichRow(row: Record<string, string>, cache: MbCache): Record<string, string> {
  const hit = row.isrc ? cache.isrc[row.isrc] : null;
  let artistId = hit?.artist ?? null;
  let match = hit ? "isrc" : "";
  if (!artistId) {
    const byName = cache.name[norm(firstArtist(row))];
    if (byName) { artistId = byName; match = match || "artist-name"; }
  }
  const a = artistId ? cache.artist[artistId] : undefined;
  const genres = hit?.tags?.length ? hit.tags : (a?.genres ?? []);
  const rating = hit?.rg ? cache.rating[hit.rg] : undefined;
  return {
    ...row,
    original_year: hit?.year || "",
    primary_genre: genres[0] ?? "",
    mb_genres: genres.join("; "),
    artist_country: a?.country ?? "",
    artist_area: a?.area ?? "",
    artist_begin_area: a?.beginArea ?? "",
    artist_type: a?.type ?? "",
    artist_active_from: a?.begin ?? "",
    artist_active_to: a?.end ?? "",
    album_rating: rating?.value != null ? String(rating.value) : "",
    album_rating_votes: rating?.votes ? String(rating.votes) : "",
    mb_recording_id: hit?.rec ?? "",
    mb_artist_id: artistId ?? "",
    mb_release_group_id: hit?.rg ?? "",
    mb_match: match || "none",
  };
}

export interface MbRunOptions {
  ratings?: boolean;
  maxRatings?: number;
  log?: (m: string) => void;
  checkpoint?: () => Promise<void>;
}

/** Run every pass over the rows (cache in, cache out) and return the enriched rows. */
export async function enrichWithMusicBrainz(
  mb: MbClient,
  rows: Record<string, string>[],
  cache: MbCache,
  opts: MbRunOptions = {},
): Promise<{ rows: Record<string, string>[]; ratingsLeft: number }> {
  const log = opts.log ?? (() => {});
  const vocab = await fetchGenreList(mb);
  log(`MusicBrainz genre vocabulary: ${vocab.size} genres.`);
  const isrcs = rows.map((r) => r.isrc).filter(Boolean);
  log(`1/4 recordings by ISRC (${new Set(isrcs).size} unique)...`);
  await resolveIsrcs(mb, isrcs, cache, vocab, (d, n) => log(`  isrc ${d}/${n}`), opts.checkpoint);
  const ids = Object.values(cache.isrc).map((h) => h?.artist).filter((x): x is string => !!x);
  log(`2/4 artists by id...`);
  await resolveArtists(mb, ids, cache, vocab, (d, n) => log(`  artists ${d}/${n}`), opts.checkpoint);
  const unmatched = rows.filter((r) => !(r.isrc && cache.isrc[r.isrc]?.artist)).map(firstArtist).filter(Boolean);
  log(`3/4 artists by name for unmatched rows (${new Set(unmatched.map(norm)).size} names)...`);
  await resolveArtistNames(mb, unmatched, cache, vocab, (d, n) => log(`  names ${d}/${n}`), opts.checkpoint);
  let ratingsLeft = 0;
  const rgs = [...new Set(rows.map((r) => (r.isrc ? cache.isrc[r.isrc]?.rg : null)).filter((x): x is string => !!x))];
  if (opts.ratings) {
    log(`4/4 album ratings (${rgs.filter((id) => !(id in cache.rating)).length} albums to look up, ~1 per second)...`);
    await resolveRatings(mb, rgs, cache, opts.maxRatings, (d, n) => log(`  ratings ${d}/${n}`), opts.checkpoint);
  } else log("4/4 album ratings skipped (pass --ratings).");
  ratingsLeft = rgs.filter((id) => !(id in cache.rating)).length;
  return { rows: rows.map((r) => enrichRow(r, cache)), ratingsLeft };
}
