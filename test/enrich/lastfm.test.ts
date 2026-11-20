import { applyPopularity, cleanTitle, emptyPopCache, lastfmMyPlays, lastfmTracks, lfKey } from "../../src/enrich/popularity.js";

describe("cleanTitle", () => {
  it("drops Spotify edition noise, keeps the song", () => {
    expect(cleanTitle("Blues For Willarene - Rudy Van Gelder Edition / Remastered 2009")).toBe("Blues For Willarene");
    expect(cleanTitle("Watermelon Man - Remastered 2007")).toBe("Watermelon Man");
    expect(cleanTitle("Hey Jude (Remastered 2015)")).toBe("Hey Jude");
    expect(cleanTitle("At Last - Single Version")).toBe("At Last");
    expect(cleanTitle("Creep")).toBe("Creep");
    expect(cleanTitle("Live and Let Die - Live")).toBe("Live and Let Die - Live"); // a live take is a different recording
  });
});

describe("Last.fm", () => {
  const rows = [
    { track: "Creep", artists: "Radiohead", track_uri: "spotify:track:a" },
    { track: "Creep - Remastered", artists: "Radiohead", track_uri: "spotify:track:b" }, // same lookup key
    { track: "Nope", artists: "Nobody", track_uri: "spotify:track:c" },
  ];

  it("looks each song up once, retries on rate limit, caches misses", async () => {
    const urls: string[] = [];
    const replies = [{ error: 29 }, { track: { listeners: "4272904", playcount: "64283562" } }, { error: 6, message: "Track not found" }];
    const cache = emptyPopCache();
    await lastfmTracks(rows, cache, {
      userAgent: "t", apiKey: "k", sleep: async () => {},
      fetchImpl: (async (u: string) => { urls.push(u); return new Response(JSON.stringify(replies.shift())); }) as unknown as typeof fetch,
    });
    expect(urls.length).toBe(3); // 2 songs + 1 retry
    expect(cache.lf[lfKey("Radiohead", "Creep")]).toEqual({ listeners: 4272904, plays: 64283562 });
    expect(cache.lf[lfKey("Nobody", "Nope")]).toBeNull();
  });

  it("stops on a rejected key instead of silently caching nulls", async () => {
    await expect(lastfmTracks(rows, emptyPopCache(), {
      userAgent: "t", apiKey: "bad", sleep: async () => {},
      fetchImpl: (async () => new Response(JSON.stringify({ error: 10, message: "Invalid API key" }))) as unknown as typeof fetch,
    })).rejects.toThrow(/rejected the API key/);
  });

  it("reads my plays across pages and puts them in my_plays", async () => {
    const pages = [
      { toptracks: { track: [{ name: "Creep", playcount: "12", artist: { name: "Radiohead" } }], "@attr": { totalPages: "2" } } },
      { toptracks: { track: [{ name: "Teardrop", playcount: "3", artist: { name: "Massive Attack" } }], "@attr": { totalPages: "2" } } },
    ];
    const mine = await lastfmMyPlays({ userAgent: "t", apiKey: "k", user: "u", fetchImpl: (async () => new Response(JSON.stringify(pages.shift()))) as unknown as typeof fetch });
    expect(mine.size).toBe(2);
    const out = applyPopularity(rows, emptyPopCache(), mine);
    expect(out.map((r) => r.my_plays)).toEqual(["12", "12", "0"]);
  });
});
