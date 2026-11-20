/**
 * Song-level popularity from two free, keyless sources:
 *  - ListenBrainz  POST /1/popularity/recording  (500 MusicBrainz recording ids per call): listens + listeners
 *    among ListenBrainz users (music enthusiasts; skews to what people actively track).
 *  - Deezer        GET  /track/isrc:<ISRC>       (one per song, quota 50 per 5 s): `rank`, Deezer's streaming
 *    popularity, plus `bpm` when Deezer has analysed the track (rare).
 *  - Last.fm       track.getInfo (one per song, needs a free API key): global listeners + play count; and
 *    user.getTopTracks (1,000 per page) for YOUR play counts, scrobbled from Spotify since you connected.
 * `popularity` (0-100) is the song's percentile WITHIN THIS FILE, averaged over the sources that know it, so it
 * ranks your own library against itself ("the classics vs. the lesser heroes"), not against the world.
 */

export interface PopCache {
  lb: Record<string, { listens: number; users: number } | null>;
  dz: Record<string, { rank: number; bpm: number } | null>;
  /** key: lfKey(artist, title) */
  lf: Record<string, { listeners: number; plays: number } | null>;
}
export const emptyPopCache = (): PopCache => ({ lb: {}, dz: {}, lf: {} });

/** Spotify titles carry edition noise ("- Remastered 2009", "(Mono Version)") that Last.fm does not. */
export function cleanTitle(t: string): string {
  return t
    .replace(/\s+-\s+[^-]*\b(remaster(ed)?|version|edition|mono|stereo|single|deluxe|digital|mastering|bonus)\b.*$/i, "")
    .replace(/\s*[([][^)\]]*\b(remaster(ed)?|version|edition|mono|stereo|deluxe|bonus)\b[^)\]]*[)\]]/gi, "")
    .trim();
}
export const lfKey = (artist: string, title: string) => `${artist.trim().toLowerCase()}|${cleanTitle(title).toLowerCase()}`;
const firstArtist = (r: Record<string, string>) => (r.artists ?? "").split(";")[0].trim();

const LF = "https://ws.audioscrobbler.com/2.0/";

/** Global Last.fm listeners + plays per song. ~4 calls/s (Last.fm suspends keys that hammer it). */
export async function lastfmTracks(
  rows: Record<string, string>[],
  cache: PopCache,
  deps: PopDeps & { apiKey: string; intervalMs?: number },
): Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? realSleep;
  const todo = new Map<string, { artist: string; title: string }>();
  for (const r of rows) {
    const k = lfKey(firstArtist(r), r.track ?? "");
    if (firstArtist(r) && r.track && !(k in cache.lf) && !todo.has(k)) todo.set(k, { artist: firstArtist(r), title: cleanTitle(r.track) });
  }
  let done = 0;
  for (const [k, { artist, title }] of todo) {
    const q = new URLSearchParams({ method: "track.getInfo", api_key: deps.apiKey, artist, track: title, autocorrect: "1", format: "json" });
    for (let attempt = 0; ; attempt++) {
      const res = await f(`${LF}?${q}`, { headers: { "User-Agent": deps.userAgent } });
      const j = (await res.json().catch(() => ({}))) as { error?: number; message?: string; track?: { listeners?: string; playcount?: string } };
      if ((j.error === 29 || j.error === 16 || j.error === 11 || res.status >= 500) && attempt < 6) {
        await sleep(5000 * (attempt + 1));
        continue;
      }
      if (j.error === 10 || j.error === 26 || j.error === 9) throw new Error(`Last.fm rejected the API key (${j.error}: ${j.message})`);
      cache.lf[k] = j.track ? { listeners: Number(j.track.listeners) || 0, plays: Number(j.track.playcount) || 0 } : null;
      break;
    }
    done++;
    if (done % 250 === 0 || done === todo.size) {
      deps.log?.(`  last.fm ${done}/${todo.size}`);
      await deps.checkpoint?.();
    }
    await sleep(deps.intervalMs ?? 250);
  }
}

/** Your own Last.fm play counts (all time), keyed like lfKey. Always fetched fresh: it grows as you listen. */
export async function lastfmMyPlays(deps: PopDeps & { apiKey: string; user: string }): Promise<Map<string, number>> {
  const f = deps.fetchImpl ?? fetch;
  const out = new Map<string, number>();
  for (let page = 1; ; page++) {
    const q = new URLSearchParams({ method: "user.getTopTracks", api_key: deps.apiKey, user: deps.user, period: "overall", limit: "1000", page: String(page), format: "json" });
    const j = (await (await f(`${LF}?${q}`, { headers: { "User-Agent": deps.userAgent } })).json()) as {
      toptracks?: { track?: { name: string; playcount: string; artist: { name: string } }[]; "@attr"?: { totalPages?: string } };
    };
    for (const t of j.toptracks?.track ?? []) {
      const k = lfKey(t.artist.name, t.name);
      out.set(k, (out.get(k) ?? 0) + (Number(t.playcount) || 0));
    }
    if (page >= Number(j.toptracks?.["@attr"]?.totalPages ?? 1)) break;
  }
  return out;
}

type Fetch = typeof fetch;
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface PopDeps {
  userAgent: string;
  fetchImpl?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
  checkpoint?: () => Promise<void>;
}

export async function listenBrainz(ids: string[], cache: PopCache, deps: PopDeps): Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? realSleep;
  const todo = [...new Set(ids)].filter((id) => id && !(id in cache.lb));
  for (let i = 0; i < todo.length; i += 500) {
    const batch = todo.slice(i, i + 500);
    for (let attempt = 0; ; attempt++) {
      const res = await f("https://api.listenbrainz.org/1/popularity/recording", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": deps.userAgent },
        body: JSON.stringify({ recording_mbids: batch }),
      });
      if (res.status === 429 && attempt < 8) {
        await sleep((parseInt(res.headers.get("x-ratelimit-reset-in") ?? "", 10) || 2) * 1000 + 250);
        continue;
      }
      if (!res.ok) throw new Error(`ListenBrainz ${res.status}`);
      const rows = (await res.json()) as { recording_mbid: string; total_listen_count: number | null; total_user_count: number | null }[];
      for (const id of batch) cache.lb[id] = null;
      for (const r of rows) {
        if (r.total_listen_count != null) cache.lb[r.recording_mbid] = { listens: r.total_listen_count, users: r.total_user_count ?? 0 };
      }
      if (res.headers.get("x-ratelimit-remaining") === "0") {
        await sleep((parseInt(res.headers.get("x-ratelimit-reset-in") ?? "", 10) || 1) * 1000 + 250);
      }
      break;
    }
    deps.log?.(`  listenbrainz ${Math.min(i + 500, todo.length)}/${todo.length}`);
    await deps.checkpoint?.();
  }
}

export async function deezer(isrcs: string[], cache: PopCache, deps: PopDeps & { intervalMs?: number }): Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? realSleep;
  const interval = deps.intervalMs ?? 120; // ~8/s, under Deezer's 50 per 5 s
  const todo = [...new Set(isrcs)].filter((i) => i && !(i in cache.dz));
  let done = 0;
  for (const isrc of todo) {
    for (let attempt = 0; ; attempt++) {
      const res = await f(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`, { headers: { "User-Agent": deps.userAgent } });
      const j = (await res.json().catch(() => ({}))) as { rank?: number; bpm?: number; error?: { code?: number } };
      if (j.error?.code === 4 && attempt < 8) { // quota exceeded: wait the 5 s window out
        await sleep(5000);
        continue;
      }
      cache.dz[isrc] = j.error || typeof j.rank !== "number" ? null : { rank: j.rank, bpm: j.bpm ?? 0 };
      break;
    }
    done++;
    if (done % 250 === 0 || done === todo.length) {
      deps.log?.(`  deezer ${done}/${todo.length}`);
      await deps.checkpoint?.();
    }
    await sleep(interval);
  }
}

export const POP_COLUMNS = ["popularity", "deezer_rank", "lb_listeners", "lb_listens", "lastfm_listeners", "lastfm_plays", "my_plays", "bpm"] as const;

/** Percentile (0-100) of each value among the given values; ties share the lower rank. */
function percentiles(values: number[]): Map<number, number> {
  const sorted = [...values].sort((a, b) => a - b);
  const out = new Map<number, number>();
  sorted.forEach((v, i) => { if (!out.has(v)) out.set(v, sorted.length > 1 ? (i / (sorted.length - 1)) * 100 : 100); });
  return out;
}

/** Add the popularity columns to rows (one song may appear in several playlists; percentiles use unique songs). */
export function applyPopularity(rows: Record<string, string>[], cache: PopCache, myPlays?: Map<string, number>): Record<string, string>[] {
  const songs = new Map<string, { dz?: number; lb?: number; lf?: number }>();
  for (const r of rows) {
    const key = r.track_uri || `${r.track}|${r.artists}`;
    if (songs.has(key)) continue;
    const dz = r.isrc ? cache.dz[r.isrc] : null;
    const lb = r.mb_recording_id ? cache.lb[r.mb_recording_id] : null;
    const lf = cache.lf?.[lfKey(firstArtist(r), r.track ?? "")];
    songs.set(key, { dz: dz?.rank || undefined, lb: lb?.users || undefined, lf: lf?.listeners || undefined });
  }
  const pDz = percentiles([...songs.values()].map((s) => s.dz).filter((x): x is number => x !== undefined));
  const pLb = percentiles([...songs.values()].map((s) => s.lb).filter((x): x is number => x !== undefined));
  const pLf = percentiles([...songs.values()].map((s) => s.lf).filter((x): x is number => x !== undefined));
  return rows.map((r) => {
    const s = songs.get(r.track_uri || `${r.track}|${r.artists}`)!;
    const parts = [
      s.dz !== undefined ? pDz.get(s.dz)! : null,
      s.lb !== undefined ? pLb.get(s.lb)! : null,
      s.lf !== undefined ? pLf.get(s.lf)! : null,
    ].filter((x): x is number => x !== null);
    const lf = cache.lf?.[lfKey(firstArtist(r), r.track ?? "")];
    const mine = myPlays?.get(lfKey(firstArtist(r), r.track ?? ""));
    const dz = r.isrc ? cache.dz[r.isrc] : null;
    const lb = r.mb_recording_id ? cache.lb[r.mb_recording_id] : null;
    return {
      ...r,
      popularity: parts.length ? String(Math.round(parts.reduce((a, b) => a + b, 0) / parts.length)) : "",
      deezer_rank: dz?.rank ? String(dz.rank) : "",
      lb_listeners: lb?.users ? String(lb.users) : "",
      lb_listens: lb?.listens ? String(lb.listens) : "",
      lastfm_listeners: lf?.listeners ? String(lf.listeners) : "",
      lastfm_plays: lf?.plays ? String(lf.plays) : "",
      my_plays: myPlays ? String(mine ?? 0) : "",
      bpm: dz?.bpm ? String(Math.round(dz.bpm)) : "",
    };
  });
}
