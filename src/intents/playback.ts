import type { SpotifyApi } from "@spotify/web-api-ts-sdk";
import { SpotifyError, mapError } from "../client/error.js";
import { withRateLimit, type RetryHooks } from "../safety/ratelimit.js";
import { toNowPlaying, type NowPlaying } from "../state/nowPlaying.js";
import { resolveMood } from "../moods.js";

/** Uniform intent result. */
export type IntentOk = { ok: true; now_playing: NowPlaying };
export type IntentErr = { ok: false; error: string; message: string };
export type IntentResult = IntentOk | IntentErr;

/** Serialisable device summary (no SDK types leak out). */
export interface DeviceInfo {
  id: string | null;
  name: string | null;
  type: string | null;
  is_active: boolean;
  volume_pct: number | null;
}

/** list_devices result — the available Spotify Connect devices, serialisable. */
export type DevicesOk = { ok: true; devices: DeviceInfo[] };
export type DevicesResult = DevicesOk | IntentErr;

/** The slice of SpotifyApi the intents use — lets tests pass a tiny mock instead of the real SDK. */
export type PlaybackApi = Pick<SpotifyApi, "player" | "search">;

export interface IntentDeps {
  api: PlaybackApi;
  retry?: RetryHooks; // test seam for the 429 backoff sleep
  now?: () => number;
}

const fail = (e: unknown): IntentErr => {
  const m = mapError(e);
  return { ok: false, error: m.code, message: m.message };
};

/** Serialisable track hit for search — no SDK types leak out. */
export interface TrackHit {
  name: string;
  artist: string;
  album: string | null;
  uri: string;
}
export type SearchOk = { ok: true; results: TrackHit[] };
export type SearchResult = SearchOk | IntentErr;

/**
 * Search Spotify for tracks by name and return the top matches WITHOUT playing. Used to resolve a song name
 * to a spotify: URI (e.g. to then play it on a Sonos room via mcp-sonos, which can't reach Spotify's API).
 */
export async function searchTracks(deps: IntentDeps, query: string): Promise<SearchResult> {
  try {
    const q = String(query ?? "").trim();
    if (!q) return { ok: false, error: "NOT_FOUND", message: "No search query given." };
    const res = await withRateLimit(() => deps.api.search(q, ["track"], undefined, 5), deps.retry);
    const items = res?.tracks?.items ?? [];
    if (!items.length) return { ok: false, error: "NOT_FOUND", message: `No tracks found for "${q}".` };
    const results: TrackHit[] = items.map((t) => ({
      name: t.name,
      artist: (t.artists ?? []).map((a) => a.name).join(", "),
      album: t.album?.name ?? null,
      uri: t.uri,
    }));
    return { ok: true, results };
  } catch (e) {
    return fail(e);
  }
}

/** Read current playback into the contract object (C4). */
export async function getNowPlaying(deps: IntentDeps): Promise<IntentResult> {
  try {
    const state = await withRateLimit(() => deps.api.player.getPlaybackState(), deps.retry);
    return { ok: true, now_playing: toNowPlaying(state, deps.now) };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Resolve the active device id, or throw NO_ACTIVE_DEVICE. We check GET /me/player/devices first (the spec
 * edge mapping) and prefer the already-active device, else the first available one.
 */
async function ensureDeviceId(deps: IntentDeps): Promise<string> {
  const devices = await withRateLimit(() => deps.api.player.getAvailableDevices(), deps.retry);
  const list = devices?.devices ?? [];
  const active = list.find((d) => d.is_active && d.id) ?? list.find((d) => d.id);
  if (!active || !active.id) {
    throw new SpotifyError(
      404,
      "NO_ACTIVE_DEVICE",
      "No active Spotify device. Open Spotify on a device (phone, desktop, or web) and try again.",
    );
  }
  return active.id;
}

/** Snapshot now_playing after a successful write so the caller always gets fresh state. */
async function snapshot(deps: IntentDeps): Promise<NowPlaying> {
  const state = await withRateLimit(() => deps.api.player.getPlaybackState(), deps.retry);
  return toNowPlaying(state, deps.now);
}

/** List the available Spotify Connect devices as serialisable summaries (lets us see e.g. Sonos rooms). */
export async function listDevices(deps: IntentDeps): Promise<DevicesResult> {
  try {
    const devices = await withRateLimit(() => deps.api.player.getAvailableDevices(), deps.retry);
    const list = (devices?.devices ?? []).map(
      (d): DeviceInfo => ({
        id: d.id ?? null,
        name: d.name ?? null,
        type: d.type ?? null,
        is_active: !!d.is_active,
        volume_pct: d.volume_percent ?? null,
      }),
    );
    return { ok: true, devices: list };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Resolve a device id from a name query against the available devices. Prefers an exact (case-insensitive)
 * name match, else a case-insensitive partial (substring) match. Throws NO_MATCHING_DEVICE (message listing
 * the available names) when nothing matches.
 */
export async function resolveDeviceId(deps: IntentDeps, nameQuery: string): Promise<string> {
  const q = String(nameQuery ?? "").trim();
  const devices = await withRateLimit(() => deps.api.player.getAvailableDevices(), deps.retry);
  const list = (devices?.devices ?? []).filter((d): d is typeof d & { id: string } => !!d.id);
  const names = list.map((d) => d.name).filter((n): n is string => !!n);
  if (!q) {
    throw new SpotifyError(
      404,
      "NO_MATCHING_DEVICE",
      `No device name given. Available devices: ${names.join(", ") || "(none)"}.`,
    );
  }
  const lower = q.toLowerCase();
  const exact = list.find((d) => (d.name ?? "").toLowerCase() === lower);
  const partial = list.find((d) => (d.name ?? "").toLowerCase().includes(lower));
  const hit = exact ?? partial;
  if (!hit) {
    throw new SpotifyError(
      404,
      "NO_MATCHING_DEVICE",
      `No device matching "${q}". Available devices: ${names.join(", ") || "(none)"}.`,
    );
  }
  return hit.id;
}

/** Move playback to the named device via transfer-playback (PUT /me/player). Returns now_playing. */
export async function transferTo(
  deps: IntentDeps,
  nameQuery: string,
  opts: { play?: boolean } = {},
): Promise<IntentResult> {
  try {
    const deviceId = await resolveDeviceId(deps, nameQuery);
    await withRateLimit(
      () => deps.api.player.transferPlayback([deviceId], opts.play ?? true),
      deps.retry,
    );
    return { ok: true, now_playing: await snapshot(deps) };
  } catch (e) {
    return fail(e);
  }
}

/** Pick the target device: resolve a named device when given, else the active/first-available one. */
async function pickDeviceId(deps: IntentDeps, device?: string): Promise<string> {
  const name = String(device ?? "").trim();
  return name ? resolveDeviceId(deps, name) : ensureDeviceId(deps);
}

/** C1 — play a track by name: search (type=track, limit=1) -> pick device -> start playback. */
export async function playByName(
  deps: IntentDeps,
  queryText: string,
  opts: { device?: string } = {},
): Promise<IntentResult> {
  try {
    const q = String(queryText ?? "").trim();
    if (!q) return { ok: false, error: "NOT_FOUND", message: "No track name given." };
    const results = await withRateLimit(() => deps.api.search(q, ["track"], undefined, 1), deps.retry);
    const track = results?.tracks?.items?.[0];
    if (!track) return { ok: false, error: "NOT_FOUND", message: `No track found for "${q}".` };
    const deviceId = await pickDeviceId(deps, opts.device);
    await withRateLimit(() => deps.api.player.startResumePlayback(deviceId, undefined, [track.uri]), deps.retry);
    return { ok: true, now_playing: await snapshot(deps) };
  } catch (e) {
    return fail(e);
  }
}

/** C2 — pause / resume / toggle. action defaults to toggle (inverts is_playing). */
export async function pauseResume(
  deps: IntentDeps,
  action: "pause" | "resume" | "toggle" = "toggle",
): Promise<IntentResult> {
  try {
    const state = await withRateLimit(() => deps.api.player.getPlaybackState(), deps.retry);
    const isPlaying = !!state?.is_playing;
    const want = action === "toggle" ? (isPlaying ? "pause" : "resume") : action;
    const deviceId = await ensureDeviceId(deps);
    if (want === "pause") {
      if (isPlaying) await withRateLimit(() => deps.api.player.pausePlayback(deviceId), deps.retry);
    } else {
      if (!isPlaying) await withRateLimit(() => deps.api.player.startResumePlayback(deviceId), deps.retry);
    }
    return { ok: true, now_playing: await snapshot(deps) };
  } catch (e) {
    return fail(e);
  }
}

/** C3 — skip next / previous. */
export async function skip(deps: IntentDeps, direction: "next" | "previous"): Promise<IntentResult> {
  try {
    const deviceId = await ensureDeviceId(deps);
    if (direction === "previous") {
      await withRateLimit(() => deps.api.player.skipToPrevious(deviceId), deps.retry);
    } else {
      await withRateLimit(() => deps.api.player.skipToNext(deviceId), deps.retry);
    }
    return { ok: true, now_playing: await snapshot(deps) };
  } catch (e) {
    return fail(e);
  }
}

/** C5 — set volume. Absolute (level) or relative (delta), clamped to 0-100. */
export async function setVolume(
  deps: IntentDeps,
  opts: { level?: number; delta?: number },
): Promise<IntentResult> {
  try {
    let target: number;
    if (typeof opts.level === "number") {
      target = opts.level;
    } else if (typeof opts.delta === "number") {
      const state = await withRateLimit(() => deps.api.player.getPlaybackState(), deps.retry);
      const current = state?.device?.volume_percent ?? 50;
      target = current + opts.delta;
    } else {
      return { ok: false, error: "NOT_FOUND", message: "Provide a volume level (0-100) or a delta." };
    }
    target = Math.max(0, Math.min(100, Math.round(target)));
    const deviceId = await ensureDeviceId(deps);
    await withRateLimit(() => deps.api.player.setPlaybackVolume(target, deviceId), deps.retry);
    return { ok: true, now_playing: await snapshot(deps) };
  } catch (e) {
    return fail(e);
  }
}

/** C6 — play by mood. Mood hit -> play its playlist context; miss -> fall back to C1 search on the query. */
export async function playByMood(
  deps: IntentDeps,
  mood: string,
  opts: { device?: string } = {},
): Promise<IntentResult> {
  try {
    const seed = resolveMood(mood);
    if (!seed) return playByName(deps, mood, opts); // total miss: treat the word as a search
    if (seed.contextUri) {
      try {
        const deviceId = await pickDeviceId(deps, opts.device);
        await withRateLimit(
          () => deps.api.player.startResumePlayback(deviceId, seed.contextUri),
          deps.retry,
        );
        return { ok: true, now_playing: await snapshot(deps) };
      } catch (e) {
        // A NO_ACTIVE_DEVICE / premium error is real — surface it. Only fall back on a NOT_FOUND context.
        const m = mapError(e);
        if (m.code !== "NOT_FOUND") return { ok: false, error: m.code, message: m.message };
      }
    }
    return playByName(deps, seed.query, opts); // no context, or context unavailable -> search fallback
  } catch (e) {
    return fail(e);
  }
}
