import { describe, it, expect, vi } from "vitest";
import { playByName, pauseResume, skip, setVolume, getNowPlaying, playByMood, listDevices, resolveDeviceId, transferTo, searchTracks, type PlaybackApi } from "../../src/intents/playback.js";
import { SpotifyError } from "../../src/client/error.js";

const deviceList = (active = true) => ({
  devices: [{ id: "dev-1", is_active: active, is_private_session: false, is_restricted: false, name: "Desk", type: "Computer", volume_percent: 40 }],
});

/** A multi-device list incl. case-variant + Sonos-room style names. */
const multiDeviceList = () => ({
  devices: [
    { id: "dev-laptop", is_active: true, is_private_session: false, is_restricted: false, name: "OFFICE-LAPTOP", type: "Computer", volume_percent: 60 },
    { id: "dev-kitchen", is_active: false, is_private_session: false, is_restricted: false, name: "Kitchen", type: "Speaker", volume_percent: 30 },
    { id: "dev-bedroom", is_active: false, is_private_session: false, is_restricted: false, name: "Bedroom", type: "Speaker", volume_percent: null },
  ],
});

const stateOf = (over: Record<string, unknown> = {}) => ({
  device: { id: "dev-1", is_active: true, is_private_session: false, is_restricted: false, name: "Desk", type: "Computer", volume_percent: 40 },
  repeat_state: "off", shuffle_state: false, context: null, timestamp: 0, progress_ms: 0, is_playing: true,
  currently_playing_type: "track", actions: {},
  item: { name: "Now Track", duration_ms: 1000, artists: [{ name: "A" }], album: { name: "Al", images: [{ url: "u" }] } },
  ...over,
});

function mockApi(over: Partial<Record<keyof PlaybackApi["player"], unknown>> & { search?: unknown } = {}): PlaybackApi {
  const player = {
    getPlaybackState: vi.fn(async () => stateOf()),
    getAvailableDevices: vi.fn(async () => deviceList()),
    startResumePlayback: vi.fn(async () => undefined),
    pausePlayback: vi.fn(async () => undefined),
    skipToNext: vi.fn(async () => undefined),
    skipToPrevious: vi.fn(async () => undefined),
    setPlaybackVolume: vi.fn(async () => undefined),
    transferPlayback: vi.fn(async () => undefined),
    ...over,
  };
  const search = over.search ?? vi.fn(async () => ({ tracks: { items: [{ uri: "spotify:track:abc", name: "Found" }] } }));
  return { player, search } as unknown as PlaybackApi;
}

describe("C1 playByName", () => {
  it("searches, ensures a device, starts playback, returns now_playing", async () => {
    const api = mockApi();
    const r = await playByName({ api }, "some song");
    expect(r.ok).toBe(true);
    expect((api.player.startResumePlayback as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("dev-1", undefined, ["spotify:track:abc"]);
  });

  it("returns NOT_FOUND on a search miss", async () => {
    const api = mockApi({ search: vi.fn(async () => ({ tracks: { items: [] } })) });
    const r = await playByName({ api }, "nonexistent xyzzy");
    expect(r).toMatchObject({ ok: false, error: "NOT_FOUND" });
  });
});

describe("search (name → URI, no play)", () => {
  it("returns top track hits with uris and does not play", async () => {
    const api = mockApi({
      search: vi.fn(async () => ({
        tracks: { items: [{ uri: "spotify:track:abc", name: "Children of the Grave", artists: [{ name: "Black Sabbath" }], album: { name: "Master of Reality" } }] },
      })),
    });
    const r = await searchTracks({ api }, "children of the grave");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results[0]).toMatchObject({ uri: "spotify:track:abc", artist: "Black Sabbath", album: "Master of Reality" });
    expect(api.player.startResumePlayback as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
  it("returns NOT_FOUND on a search miss", async () => {
    const api = mockApi({ search: vi.fn(async () => ({ tracks: { items: [] } })) });
    const r = await searchTracks({ api }, "zzz nothing");
    expect(r).toMatchObject({ ok: false, error: "NOT_FOUND" });
  });
});

describe("NO_ACTIVE_DEVICE mapping", () => {
  it("play returns NO_ACTIVE_DEVICE when no device is available", async () => {
    const api = mockApi({ getAvailableDevices: vi.fn(async () => ({ devices: [] })) });
    const r = await playByName({ api }, "song");
    expect(r).toMatchObject({ ok: false, error: "NO_ACTIVE_DEVICE" });
  });
  it("skip returns NO_ACTIVE_DEVICE when no device is available", async () => {
    const api = mockApi({ getAvailableDevices: vi.fn(async () => ({ devices: [] })) });
    const r = await skip({ api }, "next");
    expect(r).toMatchObject({ ok: false, error: "NO_ACTIVE_DEVICE" });
  });
});

describe("PREMIUM_REQUIRED (403) mapping", () => {
  it("maps a 403 from the SDK to PREMIUM_REQUIRED", async () => {
    const api = mockApi({ pausePlayback: vi.fn(async () => { throw new SpotifyError(403, "forbidden", "Player command failed: Premium required"); }) });
    const r = await pauseResume({ api }, "pause");
    expect(r).toMatchObject({ ok: false, error: "PREMIUM_REQUIRED" });
  });
});

describe("C2 pauseResume toggle", () => {
  it("toggles to pause when playing", async () => {
    const api = mockApi({ getPlaybackState: vi.fn(async () => stateOf({ is_playing: true })) });
    await pauseResume({ api }, "toggle");
    expect(api.player.pausePlayback).toHaveBeenCalled();
  });
  it("toggles to resume when paused", async () => {
    const api = mockApi({ getPlaybackState: vi.fn(async () => stateOf({ is_playing: false })) });
    await pauseResume({ api }, "toggle");
    expect(api.player.startResumePlayback).toHaveBeenCalled();
  });
});

describe("C5 setVolume clamp", () => {
  it("clamps an absolute level above 100 down to 100", async () => {
    const api = mockApi();
    await setVolume({ api }, { level: 150 });
    expect(api.player.setPlaybackVolume).toHaveBeenCalledWith(100, "dev-1");
  });
  it("applies a relative delta from current volume and clamps at 0", async () => {
    const api = mockApi({ getPlaybackState: vi.fn(async () => stateOf({ device: { id: "dev-1", is_active: true, is_private_session: false, is_restricted: false, name: "D", type: "C", volume_percent: 5 } })) });
    await setVolume({ api }, { delta: -20 });
    expect(api.player.setPlaybackVolume).toHaveBeenCalledWith(0, "dev-1");
  });
});

describe("C4 getNowPlaying", () => {
  it("returns the mapped now_playing", async () => {
    const api = mockApi();
    const r = await getNowPlaying({ api });
    expect(r).toMatchObject({ ok: true, now_playing: { track: "Now Track", volume_pct: 40 } });
  });
});

describe("C6 playByMood resolve hit + fallback", () => {
  it("plays the mood playlist context on a known mood (hit)", async () => {
    const api = mockApi();
    const r = await playByMood({ api }, "focus");
    expect(r.ok).toBe(true);
    const call = (api.player.startResumePlayback as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call[1])).toMatch(/^spotify:playlist:/); // context_uri argument
  });

  it("falls back to a track search when the mood is unknown (miss)", async () => {
    const search = vi.fn(async () => ({ tracks: { items: [{ uri: "spotify:track:zzz", name: "X" }] } }));
    const api = mockApi({ search });
    const r = await playByMood({ api }, "completely-unknown-vibe");
    expect(r.ok).toBe(true);
    expect(search).toHaveBeenCalled(); // routed through C1 search
  });
});

describe("listDevices serialisation", () => {
  it("maps the SDK device list to the serialisable {id,name,type,is_active,volume_pct} shape", async () => {
    const api = mockApi({ getAvailableDevices: vi.fn(async () => multiDeviceList()) });
    const r = await listDevices({ api });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.devices).toEqual([
      { id: "dev-laptop", name: "OFFICE-LAPTOP", type: "Computer", is_active: true, volume_pct: 60 },
      { id: "dev-kitchen", name: "Kitchen", type: "Speaker", is_active: false, volume_pct: 30 },
      { id: "dev-bedroom", name: "Bedroom", type: "Speaker", is_active: false, volume_pct: null },
    ]);
  });

  it("returns an empty list (no SDK types) when no devices are available", async () => {
    const api = mockApi({ getAvailableDevices: vi.fn(async () => ({ devices: [] })) });
    const r = await listDevices({ api });
    expect(r).toEqual({ ok: true, devices: [] });
  });
});

describe("resolveDeviceId", () => {
  it("resolves a case-insensitive partial match (kitchen -> Kitchen)", async () => {
    const api = mockApi({ getAvailableDevices: vi.fn(async () => multiDeviceList()) });
    expect(await resolveDeviceId({ api }, "kitchen")).toBe("dev-kitchen");
  });

  it("resolves a partial match across casing (laptop -> OFFICE-LAPTOP)", async () => {
    const api = mockApi({ getAvailableDevices: vi.fn(async () => multiDeviceList()) });
    expect(await resolveDeviceId({ api }, "laptop")).toBe("dev-laptop");
  });

  it("prefers an exact (case-insensitive) match over a partial one", async () => {
    const list = {
      devices: [
        { id: "dev-partial", is_active: false, is_private_session: false, is_restricted: false, name: "Kitchenette", type: "Speaker", volume_percent: 10 },
        { id: "dev-exact", is_active: false, is_private_session: false, is_restricted: false, name: "Kitchen", type: "Speaker", volume_percent: 20 },
      ],
    };
    const api = mockApi({ getAvailableDevices: vi.fn(async () => list) });
    expect(await resolveDeviceId({ api }, "KITCHEN")).toBe("dev-exact");
  });

  it("throws NO_MATCHING_DEVICE listing the available names on a miss", async () => {
    const api = mockApi({ getAvailableDevices: vi.fn(async () => multiDeviceList()) });
    await expect(resolveDeviceId({ api }, "garage")).rejects.toMatchObject({
      code: "NO_MATCHING_DEVICE",
    });
    await expect(resolveDeviceId({ api }, "garage")).rejects.toThrow(/OFFICE-LAPTOP, Kitchen, Bedroom/);
  });
});

describe("transferTo", () => {
  it("resolves the named device and transfers playback to it (play=true)", async () => {
    const api = mockApi({ getAvailableDevices: vi.fn(async () => multiDeviceList()) });
    const r = await transferTo({ api }, "kitchen", { play: true });
    expect(r.ok).toBe(true);
    expect(api.player.transferPlayback as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(["dev-kitchen"], true);
  });

  it("surfaces NO_MATCHING_DEVICE when the name does not match", async () => {
    const api = mockApi({ getAvailableDevices: vi.fn(async () => multiDeviceList()) });
    const r = await transferTo({ api }, "garage");
    expect(r).toMatchObject({ ok: false, error: "NO_MATCHING_DEVICE" });
  });
});

describe("play on a named device", () => {
  it("playByName with a device option starts playback on the resolved device id", async () => {
    const api = mockApi({ getAvailableDevices: vi.fn(async () => multiDeviceList()) });
    const r = await playByName({ api }, "some song", { device: "kitchen" });
    expect(r.ok).toBe(true);
    expect(api.player.startResumePlayback as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("dev-kitchen", undefined, ["spotify:track:abc"]);
  });
});
