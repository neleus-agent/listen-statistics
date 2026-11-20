import { applyPopularity, emptyPopCache, deezer } from "../../src/enrich/popularity.js";

describe("applyPopularity", () => {
  it("ranks songs against the library, averaging the sources that know them, once per unique song", () => {
    const cache = emptyPopCache();
    cache.dz = { A: { rank: 900_000, bpm: 0 }, B: { rank: 100_000, bpm: 121.6 }, C: { rank: 500_000, bpm: 0 } };
    cache.lb = { ma: { listens: 50, users: 10 }, mc: { listens: 9_000, users: 3_000 } };
    const rows = [
      { track_uri: "spotify:track:a", isrc: "A", mb_recording_id: "ma" },
      { track_uri: "spotify:track:a", isrc: "A", mb_recording_id: "ma" }, // same song, another playlist
      { track_uri: "spotify:track:b", isrc: "B", mb_recording_id: "" },
      { track_uri: "spotify:track:c", isrc: "C", mb_recording_id: "mc" },
      { track_uri: "spotify:track:d", isrc: "", mb_recording_id: "" },
    ];
    const out = applyPopularity(rows, cache);
    expect(out.map((r) => r.popularity)).toEqual(["50", "50", "0", "75", ""]);
    expect(out[2].bpm).toBe("122");
    expect(out[3].lb_listeners).toBe("3000");
  });
});

describe("deezer", () => {
  it("waits out quota errors and caches misses as null", async () => {
    const replies = [{ error: { code: 4 } }, { rank: 5 }, { error: { code: 800 } }];
    const cache = emptyPopCache();
    const sleeps: number[] = [];
    await deezer(["X", "Y"], cache, { userAgent: "t", sleep: async (ms) => void sleeps.push(ms), fetchImpl: (async () => new Response(JSON.stringify(replies.shift()))) as typeof fetch });
    expect(cache.dz).toEqual({ X: { rank: 5, bpm: 0 }, Y: null });
    expect(sleeps).toContain(5000);
  });
});
