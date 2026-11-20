import { describe, it, expect } from "vitest";
import { toNowPlaying, idleNowPlaying, NowPlayingTracker, sameState } from "../../src/state/nowPlaying.js";

const fixedNow = () => 1_700_000_000_000;

const playbackState = (over: Record<string, unknown> = {}) => ({
  device: { id: "dev-1", is_active: true, is_private_session: false, is_restricted: false, name: "Desk", type: "Computer", volume_percent: 55 },
  repeat_state: "off", shuffle_state: false, context: null, timestamp: 0, progress_ms: 12000, is_playing: true,
  currently_playing_type: "track", actions: {},
  item: {
    name: "Test Track", duration_ms: 200000,
    artists: [{ name: "Artist A" }, { name: "Artist B" }],
    album: { name: "Album X", images: [{ url: "http://art/large.jpg" }, { url: "http://art/small.jpg" }] },
  },
  ...over,
});

describe("toNowPlaying serialisation", () => {
  it("maps a full PlaybackState into the contract object", () => {
    const np = toNowPlaying(playbackState() as never, fixedNow);
    expect(np).toEqual({
      is_playing: true,
      track: "Test Track",
      artist: "Artist A, Artist B",
      album: "Album X",
      album_art_url: "http://art/large.jpg",
      progress_ms: 12000,
      duration_ms: 200000,
      device: { id: "dev-1", name: "Desk", type: "Computer" },
      volume_pct: 55,
      last_updated: new Date(fixedNow()).toISOString(),
    });
  });

  it("returns the idle snapshot for null / device-less state", () => {
    expect(toNowPlaying(null, fixedNow)).toEqual(idleNowPlaying(fixedNow));
    expect(toNowPlaying(undefined, fixedNow).is_playing).toBe(false);
  });
});

describe("NowPlayingTracker change-events", () => {
  it("reports a change on first snapshot, no change on an identical one, change on track switch", () => {
    const tracker = new NowPlayingTracker();
    const a = toNowPlaying(playbackState() as never, fixedNow);
    expect(tracker.update(a)).toBe(true); // first snapshot is a change
    const aAgain = toNowPlaying(playbackState({ progress_ms: 13000 }) as never, () => fixedNow() + 1000);
    expect(tracker.update(aAgain)).toBe(false); // only progress + last_updated drifted
    const b = toNowPlaying(playbackState({ item: { name: "Other", duration_ms: 1, artists: [{ name: "Z" }], album: { name: "Y", images: [] } } }) as never, fixedNow);
    expect(tracker.update(b)).toBe(true); // track changed
    expect(tracker.current?.track).toBe("Other");
  });

  it("sameState ignores progress + last_updated drift", () => {
    const a = toNowPlaying(playbackState() as never, fixedNow);
    const b = toNowPlaying(playbackState({ progress_ms: 99999 }) as never, () => fixedNow() + 5000);
    expect(sameState(a, b)).toBe(true);
  });
});
