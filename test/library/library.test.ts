import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpotifyError } from "../../src/client/error.js";
import { RateLimitedError, SpotifyHttp, type Http } from "../../src/client/http.js";
import { csvField, toCsv } from "../../src/library/csv.js";
import { keyName } from "../../src/library/enrich.js";
import { exportLibrary } from "../../src/library/export.js";
import { addToPlaylist, createPlaylist, listPlaylists, parsePlaylistId, resolvePlaylist } from "../../src/library/library.js";

const ID = (c: string) => c.repeat(22);

/** Fake Http: GET routes by path (query string included), POSTs recorded. */
function fakeHttp(routes: Record<string, unknown>) {
  const posts: { path: string; body: unknown }[] = [];
  const http: Http = {
    async get<T>(p: string) {
      const key = p.replace("https://api.spotify.com/v1", "");
      if (!(key in routes)) throw new SpotifyError(404, "NOT_FOUND", `no route ${key}`);
      const v = routes[key];
      if (v instanceof Error) throw v;
      return v as T;
    },
    async post<T>(path: string, body: unknown) {
      posts.push({ path, body });
      // like the live API: a new playlist comes back public whatever was asked
      return { id: ID("n"), name: (body as { name?: string }).name, uri: `spotify:playlist:${ID("n")}`, public: true, snapshot_id: "snap" } as T;
    },
    async put<T>(path: string, body: unknown) {
      posts.push({ path: `PUT ${path}`, body });
      return undefined as T;
    },
  };
  return { http, posts };
}

const tokens = { getOrCreateAccessToken: async () => ({ access_token: "tok" }) };
const me = { id: "user1", display_name: "Alex" };
const own = { id: ID("a"), name: "Running", uri: `spotify:playlist:${ID("a")}`, owner: { id: "user1", display_name: "Alex" }, items: { total: 2 } };
const followed = { id: ID("b"), name: "Today's Top Hits", uri: `spotify:playlist:${ID("b")}`, owner: { id: "spotify" }, tracks: { total: 50 } };
const track = (id: string, artistId: string, extra: object = {}) => ({
  id: ID(id), uri: `spotify:track:${ID(id)}`, name: `Song ${id}`, type: "track", duration_ms: 185_000, explicit: false,
  artists: [{ id: ID(artistId), name: `Artist ${artistId}` }],
  album: { name: "Album, \"Live\"", album_type: "album", release_date: "1999-03-01" },
  external_ids: { isrc: `NL${id}` }, ...extra,
});

describe("csv", () => {
  it("quotes delimiters, quotes and newlines", () => {
    expect(csvField('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(csvField(null)).toBe("");
    expect(toCsv(["x", "y"], [{ x: 1, y: "é" }])).toBe("\uFEFFx,y\r\n1,é\r\n");
  });
});

describe("keyName", () => {
  it("maps pitch class + mode", () => {
    expect(keyName(1, 0)).toBe("C# minor");
    expect(keyName(0, 1)).toBe("C major");
    expect(keyName(-1, 1)).toBe("");
  });
});

describe("playlists", () => {
  it("parses ids from URI and URL", () => {
    expect(parsePlaylistId(`spotify:playlist:${ID("a")}`)).toBe(ID("a"));
    expect(parsePlaylistId(`https://open.spotify.com/intl-nl/playlist/${ID("a")}?si=x`)).toBe(ID("a"));
    expect(parsePlaylistId("Running")).toBeNull();
  });

  it("paginates /me/playlists and reads legacy + 2026 total fields", async () => {
    const { http } = fakeHttp({
      "/me/playlists?limit=50": { items: [own], next: "https://api.spotify.com/v1/me/playlists?offset=50" },
      "/me/playlists?offset=50": { items: [followed, null], next: null },
    });
    const pls = await listPlaylists(http, me);
    expect(pls.map((p) => [p.name, p.owned, p.total])).toEqual([["Running", true, 2], ["Today's Top Hits", false, 50]]);
  });

  it("resolves by partial name", async () => {
    const { http } = fakeHttp({ "/me/playlists?limit=50": { items: [own, followed], next: null } });
    expect((await resolvePlaylist(http, me, "runn")).id).toBe(ID("a"));
    await expect(resolvePlaylist(http, me, "nope")).rejects.toThrow(/No playlist/);
  });

  it("creates via POST /me/playlists, private by default", async () => {
    const { http, posts } = fakeHttp({ [`/playlists/${ID("n")}?fields=public`]: { public: true } });
    const made = await createPlaylist(http, { name: " Road Trip " });
    expect(made.public).toBe(true); // reports what Spotify holds, not what we asked for
    const pl = await createPlaylist(http, { name: "x" }).then(() => posts);
    expect(posts[0]).toEqual({ path: "/me/playlists", body: { name: "Road Trip", description: "", public: false } });
    expect(posts[1]).toEqual({ path: `PUT /playlists/${ID("n")}`, body: { public: false } });
    expect(pl.length).toBe(4);
  });

  it("adds in chunks of 100 to /items and rejects bad URIs", async () => {
    const { http, posts } = fakeHttp({});
    const uris = Array.from({ length: 205 }, (_, i) => `spotify:track:${String(i).padStart(22, "x")}`);
    const res = await addToPlaylist(http, ID("a"), uris);
    expect(res.added).toBe(205);
    expect(posts.map((p) => [p.path, (p.body as { uris: string[] }).uris.length])).toEqual([
      [`/playlists/${ID("a")}/items`, 100], [`/playlists/${ID("a")}/items`, 100], [`/playlists/${ID("a")}/items`, 5],
    ]);
    await expect(addToPlaylist(http, ID("a"), ["Song name"])).rejects.toThrow(/URI/);
  });
});

describe("exportLibrary", () => {
  it("exports owned + liked, skips followed with a reason, enriches genres, survives missing audio features", async () => {
    const { http } = fakeHttp({
      "/me": me,
      "/me/playlists?limit=50": { items: [own, followed], next: null },
      "/me/tracks?limit=50": { items: [{ added_at: "2026-01-01T00:00:00Z", track: track("l", "x") }], next: null },
      [`/playlists/${ID("a")}/items?limit=50&additional_types=track,episode`]: {
        items: [{ added_at: "2025-05-05T00:00:00Z", item: track("t", "x") }, { added_at: null, item: null }], next: null,
      },
      [`/playlists/${ID("b")}/items?limit=50&additional_types=track,episode`]: new SpotifyError(403, "FORBIDDEN", "forbidden"),
      [`/audio-features?ids=${ID("l")},${ID("t")}`]: new SpotifyError(403, "FORBIDDEN", "forbidden"),
      [`/artists/${ID("x")}`]: { genres: ["nederpop", "dance"] },
    });
    const dir = await mkdtemp(join(tmpdir(), "spx-"));
    const s = await exportLibrary(http, { outDir: dir, genreDelayMs: 0 });
    expect(s.rows).toBe(2);
    expect(s.playlists_exported).toBe(2);
    expect(s.audio_features).toBe("unavailable");
    expect(s.playlists_skipped[0]).toMatchObject({ name: "Today's Top Hits" });
    expect(s.playlists_skipped[0].reason).toMatch(/followed playlists/);

    const csv = await readFile(join(dir, "tracks.csv"), "utf8");
    const lines = csv.replace("\uFEFF", "").trim().split("\r\n");
    expect(lines[0].startsWith("playlist,playlist_id,position,added_at,track,artists,album")).toBe(true);
    expect(lines[1]).toContain('Liked Songs,liked,1,2026-01-01T00:00:00Z,Song l,Artist x,"Album, ""Live""",album,1999-03-01,1999,3:05');
    expect(lines[1]).toContain("nederpop; dance");
    const pls = await readFile(join(dir, "playlists.csv"), "utf8");
    expect(pls).toContain("skipped: not yours");
  });
});

describe("genre pass under a long rate limit", () => {
  it("writes the CSV anyway, caches what it got, and resumes from the cache", async () => {
    const routes: Record<string, unknown> = {
      "/me": me,
      "/me/playlists?limit=50": { items: [own], next: null },
      [`/playlists/${ID("a")}/items?limit=50&additional_types=track,episode`]: {
        items: [{ added_at: null, item: track("t", "x") }, { added_at: null, item: track("u", "y") }], next: null,
      },
      [`/audio-features?ids=${ID("t")},${ID("u")}`]: new SpotifyError(403, "FORBIDDEN", "forbidden"),
      [`/artists/${ID("x")}`]: { genres: ["jazz"] },
      [`/artists/${ID("y")}`]: new RateLimitedError(86_156, "GET /artists"),
    };
    const dir = await mkdtemp(join(tmpdir(), "spx-"));
    const cachePath = join(dir, "cache.json");
    const first = await exportLibrary(fakeHttp(routes).http, { outDir: dir, includeLiked: false, genreCachePath: cachePath, genreDelayMs: 0 });
    expect(first.rows).toBe(2);
    expect(first.genres).toBe("partial");
    expect(first.genres_remaining).toBe(1);
    expect(first.notes.join(" ")).toMatch(/blocked artist lookups until/);
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toEqual({ [ID("x")]: ["jazz"] });

    routes[`/artists/${ID("x")}`] = new Error("must not be fetched again");
    routes[`/artists/${ID("y")}`] = { genres: ["soul"] };
    const second = await exportLibrary(fakeHttp(routes).http, { outDir: dir, includeLiked: false, genreCachePath: cachePath, genreDelayMs: 0 });
    expect(second.genres).toBe("filled");
    const csv = await readFile(join(dir, "tracks.csv"), "utf8");
    expect(csv).toContain("jazz");
    expect(csv).toContain("soul");
  });
});

describe("SpotifyHttp", () => {
  it("fails fast on a Retry-After longer than it will wait", async () => {
    const http = new SpotifyHttp(tokens, { fetchImpl: (async () => new Response("{}", { status: 429, headers: { "retry-after": "86156" } })) as typeof fetch, sleep: async () => { throw new Error("should not sleep"); } });
    await expect(http.get("/artists/x")).rejects.toBeInstanceOf(RateLimitedError);
  });

  const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

  it("honours Retry-After on 429 then succeeds", async () => {
    const waits: number[] = [];
    const calls: Response[] = [res(429, { error: { message: "slow" } }, { "retry-after": "2" }), res(200, { ok: 1 })];
    const http = new SpotifyHttp(tokens, { fetchImpl: (async () => calls.shift()!) as typeof fetch, sleep: async (ms) => void waits.push(ms) });
    expect(await http.get("/me")).toEqual({ ok: 1 });
    expect(waits).toEqual([2000]);
  });

  it("maps a scope 403 to INSUFFICIENT_SCOPE", async () => {
    const http = new SpotifyHttp(tokens, { fetchImpl: (async () => res(403, { error: { status: 403, message: "Insufficient client scope" } })) as typeof fetch });
    await expect(http.get("/me/playlists")).rejects.toMatchObject({ code: "INSUFFICIENT_SCOPE" });
  });
});
