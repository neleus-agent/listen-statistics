import type { PlaybackState } from "@spotify/web-api-ts-sdk";

/** Serialisable now_playing contract (the shape every intent returns). Null when nothing is playing. */
export interface NowPlaying {
  is_playing: boolean;
  track: string | null;
  artist: string | null;
  album: string | null;
  album_art_url: string | null;
  progress_ms: number | null;
  duration_ms: number | null;
  device: { id: string | null; name: string | null; type: string | null };
  volume_pct: number | null;
  last_updated: string;
}

/** Idle snapshot — nothing playing / no device. */
export function idleNowPlaying(now: () => number = Date.now): NowPlaying {
  return {
    is_playing: false,
    track: null,
    artist: null,
    album: null,
    album_art_url: null,
    progress_ms: null,
    duration_ms: null,
    device: { id: null, name: null, type: null },
    volume_pct: null,
    last_updated: new Date(now()).toISOString(),
  };
}

/** Map a raw Spotify PlaybackState (may be null/empty) into the serialisable contract object. */
export function toNowPlaying(
  state: PlaybackState | null | undefined,
  now: () => number = Date.now,
): NowPlaying {
  if (!state || !state.device) return idleNowPlaying(now);
  const item = state.item as
    | { name?: string; duration_ms?: number; artists?: { name: string }[]; album?: { name?: string; images?: { url: string }[] } }
    | null;
  const artists = item?.artists?.map((a) => a.name).filter(Boolean).join(", ") || null;
  const albumArt = item?.album?.images?.[0]?.url ?? null;
  return {
    is_playing: !!state.is_playing,
    track: item?.name ?? null,
    artist: artists,
    album: item?.album?.name ?? null,
    album_art_url: albumArt,
    progress_ms: state.progress_ms ?? null,
    duration_ms: item?.duration_ms ?? null,
    device: {
      id: state.device.id ?? null,
      name: state.device.name ?? null,
      type: state.device.type ?? null,
    },
    volume_pct: state.device.volume_percent ?? null,
    last_updated: new Date(now()).toISOString(),
  };
}

/**
 * Pull-based change tracker (MVP). Feed it successive snapshots; it reports whether the meaningful
 * playback state changed (track / play-pause / device / volume). last_updated is ignored in the diff
 * so a no-op poll does not register as a change. Throttled by the caller (we just compare).
 */
export class NowPlayingTracker {
  private last: NowPlaying | null = null;

  /** Returns true when the new snapshot differs meaningfully from the previous one. */
  update(next: NowPlaying): boolean {
    const changed = !this.last || !sameState(this.last, next);
    this.last = next;
    return changed;
  }

  get current(): NowPlaying | null {
    return this.last;
  }
}

/** Equality over the meaningful fields (everything except last_updated + progress_ms drift). */
export function sameState(a: NowPlaying, b: NowPlaying): boolean {
  return (
    a.is_playing === b.is_playing &&
    a.track === b.track &&
    a.artist === b.artist &&
    a.album === b.album &&
    a.device.id === b.device.id &&
    a.volume_pct === b.volume_pct
  );
}
