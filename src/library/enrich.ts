import type { Http } from "../client/http.js";
import { SpotifyError } from "../client/error.js";
import { RateLimitedError } from "../client/http.js";

/**
 * Enrichment that still works for a development-mode app after February 2026:
 *  - genres: GET /artists/{id} one by one (the batch GET /artists was removed; genres are deprecated but
 *    still returned, often empty for small artists). Paced + cached: see artistGenres;
 *  - audio features (tempo, key, ...): GET /audio-features?ids= — closed to apps registered after
 *    2024-11-27. We try once; any 403/404/410 marks it unavailable and the columns stay empty.
 */

export interface AudioFeatures {
  tempo: number | null;
  key: number | null;
  mode: number | null;
  time_signature: number | null;
  energy: number | null;
  danceability: number | null;
  valence: number | null;
}

const PITCH = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Spotify pitch class + mode -> "C# minor"; empty when unknown (-1 / null). */
export function keyName(key: number | null | undefined, mode: number | null | undefined): string {
  if (key == null || key < 0 || key > 11) return "";
  const m = mode === 1 ? " major" : mode === 0 ? " minor" : "";
  return `${PITCH[key]}${m}`;
}

export interface GenreResult {
  genres: Map<string, string[]>;
  /** artists still without genres because the pass stopped early. */
  remaining: number;
  /** set when Spotify blocked the artist endpoint; resume after this time. */
  blockedUntil?: string;
}

/**
 * Genres per artist via GET /artists/{id}, sequential and paced (Spotify bans a burst of ~600 artist calls
 * for ~24 h). `cache` is read first and filled as we go, so an interrupted pass resumes where it stopped;
 * a long rate-limit ends the pass cleanly with partial results instead of throwing.
 */
export async function artistGenres(
  http: Http,
  artistIds: string[],
  opts: {
    cache?: Map<string, string[]>;
    delayMs?: number;
    maxCalls?: number;
    sleep?: (ms: number) => Promise<void>;
    onProgress?: (done: number, total: number) => void;
    /** called every 50 fetched artists (and at the end) so the caller can persist the cache. */
    onCheckpoint?: () => Promise<void>;
  } = {},
): Promise<GenreResult> {
  const cache = opts.cache ?? new Map<string, string[]>();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delay = opts.delayMs ?? 250;
  const ids = [...new Set(artistIds.filter(Boolean))];
  const todo = ids.filter((id) => !cache.has(id));
  const genres = new Map<string, string[]>();
  for (const id of ids) if (cache.has(id)) genres.set(id, cache.get(id)!);
  let done = 0;
  let blockedUntil: string | undefined;
  for (const id of todo) {
    if (opts.maxCalls !== undefined && done >= opts.maxCalls) break;
    try {
      const a = await http.get<{ genres?: string[] }>(`/artists/${id}`);
      const g = a?.genres ?? [];
      cache.set(id, g);
      genres.set(id, g);
    } catch (e) {
      if (e instanceof SpotifyError && e.code === "RATE_LIMITED") {
        const sec = e instanceof RateLimitedError ? e.retryAfterSec : 60;
        blockedUntil = new Date(Date.now() + sec * 1000).toISOString();
        break;
      }
      if (e instanceof SpotifyError && e.code === "NOT_AUTHENTICATED") throw e;
      cache.set(id, []); // a missing artist must not sink the pass
      genres.set(id, []);
    }
    done++;
    if (done % 50 === 0) {
      opts.onProgress?.(ids.length - todo.length + done, ids.length);
      await opts.onCheckpoint?.();
    }
    if (delay) await sleep(delay);
  }
  await opts.onCheckpoint?.();
  return { genres, remaining: ids.length - genres.size, blockedUntil };
}

export async function audioFeatures(
  http: Http,
  trackIds: string[],
): Promise<{ available: boolean; features: Map<string, AudioFeatures>; note?: string }> {
  const features = new Map<string, AudioFeatures>();
  const ids = [...new Set(trackIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 100) {
    let res: { audio_features?: (AudioFeatures & { id: string } | null)[] };
    try {
      res = await http.get(`/audio-features?ids=${ids.slice(i, i + 100).join(",")}`);
    } catch (e) {
      if (i === 0 && e instanceof SpotifyError && [403, 404, 410].includes(e.status)) {
        return { available: false, features, note: `audio features unavailable to this app (${e.status}); tempo/key left empty` };
      }
      throw e;
    }
    for (const f of res?.audio_features ?? []) {
      if (!f) continue;
      features.set(f.id, {
        tempo: f.tempo ?? null, key: f.key ?? null, mode: f.mode ?? null, time_signature: f.time_signature ?? null,
        energy: f.energy ?? null, danceability: f.danceability ?? null, valence: f.valence ?? null,
      });
    }
  }
  return { available: true, features };
}
