import { parseCsv, toCsv } from "../../src/library/csv.js";
import { createMbClient, emptyCache, enrichWithMusicBrainz, toGenres, type MbClient } from "../../src/enrich/musicbrainz.js";

/** Fake MB: answers by URL prefix, records every call. */
function fakeMb(answer: (url: string) => unknown) {
  const calls: string[] = [];
  const mb: MbClient = { async get<T>(u: string) { calls.push(decodeURIComponent(u)); return answer(decodeURIComponent(u)) as T; } };
  return { mb, calls };
}

const genresPage = { genres: [{ name: "jazz" }, { name: "hard bop" }, { name: "pop" }], "genre-count": 3 };

describe("csv round trip", () => {
  it("parses what toCsv writes, including quotes, commas and newlines", () => {
    const rows = [{ a: 'x,"y"', b: "line1\nline2" }, { a: "é", b: "" }];
    expect(parseCsv(toCsv(["a", "b"], rows)).rows).toEqual(rows);
  });
});

describe("toGenres", () => {
  it("keeps voted vocabulary tags, most votes first", () => {
    const vocab = new Set(["jazz", "hard bop"]);
    expect(toGenres([{ name: "jazz", count: 2 }, { name: "seen live", count: 9 }, { name: "Hard Bop", count: 5 }, { name: "jazz", count: 0 }], vocab))
      .toEqual(["hard bop", "jazz"]);
  });
});

describe("enrichWithMusicBrainz", () => {
  it("matches by ISRC (earliest recording wins), falls back to exact artist name, and fills ratings", async () => {
    const { mb, calls } = fakeMb((u) => {
      if (u.startsWith("/genre/all")) return genresPage;
      if (u.startsWith("/recording")) {
        return {
          count: 2,
          recordings: [
            { id: "rec-late", "first-release-date": "1999-01-01", isrcs: ["USSM10203010"], "artist-credit": [{ artist: { id: "monk", name: "Thelonious Monk" } }], releases: [] },
            {
              id: "rec-orig", "first-release-date": "1963-01-01", isrcs: ["USSM10203010"], tags: [{ name: "hard bop", count: 1 }],
              "artist-credit": [{ artist: { id: "monk", name: "Thelonious Monk" } }],
              releases: [{ "release-group": { id: "rg-live", "primary-type": "Album", "secondary-types": ["Live"] } }, { "release-group": { id: "rg-dream", "primary-type": "Album" } }],
            },
          ],
        };
      }
      if (u.startsWith("/artist") && u.includes("arid:")) {
        return { artists: [{ id: "monk", name: "Thelonious Monk", type: "Person", country: "US", area: { name: "United States" }, "begin-area": { name: "Rocky Mount" }, "life-span": { begin: "1917-10-10", end: "1982-02-17" }, tags: [{ name: "jazz", count: 7 }] }] };
      }
      if (u.startsWith("/artist")) {
        return { artists: [{ id: "abba", name: "ABBA", score: 100, type: "Group", country: "SE", tags: [{ name: "pop", count: 20 }] }, { id: "abba-tribute", name: "ABBA Tribute", score: 80 }] };
      }
      if (u.startsWith("/release-group/rg-dream")) return { rating: { value: 4.3, "votes-count": 12 } };
      throw new Error(`unexpected ${u}`);
    });
    const rows = [
      { track: "Monk's Dream", artists: "Thelonious Monk", isrc: "USSM10203010" },
      { track: "Dancing Queen", artists: "ABBA; Someone", isrc: "" },
      { track: "Unknown", artists: "Nobody At All", isrc: "" },
    ];
    const cache = emptyCache();
    const res = await enrichWithMusicBrainz(mb, rows, cache, { ratings: true });
    const [monk, abba, nobody] = res.rows;
    expect(monk).toMatchObject({
      original_year: "1963", primary_genre: "hard bop", artist_country: "US", artist_begin_area: "Rocky Mount",
      artist_active_from: "1917", artist_active_to: "1982", mb_release_group_id: "rg-dream", album_rating: "4.3", album_rating_votes: "12", mb_match: "isrc",
    });
    expect(abba).toMatchObject({ artist_country: "SE", primary_genre: "pop", mb_artist_id: "abba", mb_match: "artist-name", original_year: "" });
    expect(nobody).toMatchObject({ mb_match: "none", artist_country: "" });

    // A second run is free: everything comes from the cache except the genre vocabulary.
    calls.length = 0;
    await enrichWithMusicBrainz(mb, rows, cache, { ratings: true });
    expect(calls.every((c) => c.startsWith("/genre/all"))).toBe(true);
  });
});

describe("createMbClient", () => {
  it("backs off on 503 and sends the User-Agent", async () => {
    const seen: string[] = [];
    const replies = [new Response("", { status: 503, headers: { "retry-after": "1" } }), new Response('{"ok":1}', { status: 200 })];
    const sleeps: number[] = [];
    const mb = createMbClient({
      userAgent: "test-agent/1",
      minIntervalMs: 0,
      sleep: async (ms) => void sleeps.push(ms),
      fetchImpl: (async (_u: string, init: RequestInit) => { seen.push((init.headers as Record<string, string>)["User-Agent"]); return replies.shift()!; }) as unknown as typeof fetch,
    });
    expect(await mb.get("/x")).toEqual({ ok: 1 });
    expect(seen).toEqual(["test-agent/1", "test-agent/1"]);
    expect(sleeps).toContain(1000);
  });
});
