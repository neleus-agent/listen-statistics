import type { Http } from "../client/http.js";
import { SpotifyError } from "../client/error.js";

/**
 * Library read + write over the February 2026 Web API surface:
 *   GET  /me/playlists                 (GET /users/{id}/playlists was removed)
 *   GET  /playlists/{id}/items         (was /tracks; only for playlists the user OWNS or COLLABORATES on)
 *   GET  /me/tracks                    (Liked Songs)
 *   POST /me/playlists                 (POST /users/{id}/playlists was removed)
 *   POST /playlists/{id}/items         (was /tracks; max 100 URIs per call)
 * Field renames are read tolerantly (`items` and the legacy `tracks`, `item` and the legacy `track`).
 */

interface Page<T> {
  items: T[];
  next: string | null;
  total?: number;
}

export interface Me {
  id: string;
  display_name: string | null;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  owner_id: string;
  owner_name: string | null;
  owned: boolean;
  collaborative: boolean;
  public: boolean | null;
  total: number | null;
  uri: string;
}

/** A track or episode as returned inside a playlist / library entry (only the fields we use). */
export interface RawTrack {
  id: string | null;
  uri: string;
  name: string;
  type?: string;
  is_local?: boolean;
  duration_ms?: number;
  explicit?: boolean;
  artists?: { id: string | null; name: string }[];
  album?: { id?: string | null; name?: string; album_type?: string; release_date?: string };
  show?: { name?: string; publisher?: string };
  release_date?: string;
  external_ids?: { isrc?: string };
}

export interface LibraryEntry {
  added_at: string | null;
  track: RawTrack | null;
}

interface RawPlaylist {
  id: string;
  name: string;
  uri: string;
  collaborative?: boolean;
  public?: boolean | null;
  owner?: { id?: string; display_name?: string | null };
  items?: { total?: number };
  tracks?: { total?: number };
}

const URI_RE = /^spotify:(track|episode):[A-Za-z0-9]{22}$/;
const ID_RE = /^[A-Za-z0-9]{22}$/;

/** Follow `next` links until the collection is exhausted. */
export async function paginate<T>(http: Http, first: string): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = first;
  while (url) {
    const page: Page<T> = await http.get<Page<T>>(url);
    out.push(...(page?.items ?? []));
    url = page?.next ?? null;
  }
  return out;
}

export async function getMe(http: Http): Promise<Me> {
  const me = await http.get<{ id: string; display_name?: string | null }>("/me");
  return { id: me.id, display_name: me.display_name ?? null };
}

export async function listPlaylists(http: Http, me: Me): Promise<PlaylistSummary[]> {
  const raw = await paginate<RawPlaylist | null>(http, "/me/playlists?limit=50");
  return raw
    .filter((p): p is RawPlaylist => !!p && !!p.id)
    .map((p) => ({
      id: p.id,
      name: p.name,
      owner_id: p.owner?.id ?? "",
      owner_name: p.owner?.display_name ?? null,
      owned: (p.owner?.id ?? "") === me.id,
      collaborative: !!p.collaborative,
      public: p.public ?? null,
      total: p.items?.total ?? p.tracks?.total ?? null,
      uri: p.uri,
    }));
}

/** Normalise one playlist/library entry: `item` (2026) or `track` (legacy). */
function toEntry(e: { added_at?: string | null; item?: RawTrack | null; track?: RawTrack | null }): LibraryEntry {
  return { added_at: e.added_at ?? null, track: e.item ?? e.track ?? null };
}

export async function getPlaylistEntries(http: Http, playlistId: string): Promise<LibraryEntry[]> {
  const raw = await paginate<{ added_at?: string; item?: RawTrack; track?: RawTrack }>(
    http,
    `/playlists/${encodeURIComponent(playlistId)}/items?limit=50&additional_types=track,episode`,
  );
  return raw.map(toEntry);
}

export async function getLikedEntries(http: Http): Promise<LibraryEntry[]> {
  const raw = await paginate<{ added_at?: string; track?: RawTrack }>(http, "/me/tracks?limit=50");
  return raw.map(toEntry);
}

/** Extract a playlist id from an id, a spotify:playlist: URI or an open.spotify.com URL; else null. */
export function parsePlaylistId(ref: string): string | null {
  const s = ref.trim();
  if (ID_RE.test(s)) return s;
  const uri = /^spotify:playlist:([A-Za-z0-9]{22})$/.exec(s);
  if (uri) return uri[1];
  const url = /open\.spotify\.com\/(?:[a-z-]+\/)?playlist\/([A-Za-z0-9]{22})/.exec(s);
  return url ? url[1] : null;
}

/** Resolve a playlist reference (id / URI / URL / exact-then-partial name among the user's playlists). */
export async function resolvePlaylist(http: Http, me: Me, ref: string): Promise<PlaylistSummary> {
  const all = await listPlaylists(http, me);
  const id = parsePlaylistId(ref);
  if (id) {
    const hit = all.find((p) => p.id === id);
    if (hit) return hit;
    const p = await http.get<RawPlaylist>(`/playlists/${id}?fields=id,name,uri,collaborative,public,owner(id,display_name)`);
    return {
      id: p.id, name: p.name, uri: p.uri, owner_id: p.owner?.id ?? "", owner_name: p.owner?.display_name ?? null,
      owned: (p.owner?.id ?? "") === me.id, collaborative: !!p.collaborative, public: p.public ?? null, total: null,
    };
  }
  const q = ref.trim().toLowerCase();
  const exact = all.filter((p) => p.name.toLowerCase() === q);
  const partial = exact.length ? exact : all.filter((p) => p.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  if (!partial.length) throw new SpotifyError(404, "NOT_FOUND", `No playlist of yours matches "${ref}".`);
  const owned = partial.filter((p) => p.owned);
  if (owned.length === 1) return owned[0];
  throw new SpotifyError(
    409,
    "AMBIGUOUS",
    `"${ref}" matches ${partial.length} playlists: ${partial.slice(0, 8).map((p) => `${p.name} (${p.id})`).join("; ")}. Pass the id.`,
  );
}

export async function createPlaylist(
  http: Http,
  opts: { name: string; description?: string; public?: boolean },
): Promise<PlaylistSummary & { url: string | null }> {
  const name = opts.name.trim();
  if (!name) throw new SpotifyError(400, "BAD_INPUT", "A playlist name is required.");
  const p = await http.post<RawPlaylist & { external_urls?: { spotify?: string } }>("/me/playlists", {
    name,
    description: opts.description ?? "",
    public: opts.public ?? false,
  });
  const wantPublic = opts.public ?? false;
  let isPublic = p.public ?? null;
  // Observed 2026-11-18: POST /me/playlists ignores `public: false` and creates a PUBLIC playlist, and a
  // follow-up PUT is accepted (200) without effect. Try once, then report what Spotify actually holds.
  if (isPublic !== wantPublic) {
    await setPlaylistPublic(http, p.id, wantPublic);
    const now = await http.get<{ public?: boolean | null }>(`/playlists/${encodeURIComponent(p.id)}?fields=public`);
    isPublic = now?.public ?? null;
  }
  return {
    id: p.id, name: p.name, uri: p.uri, owner_id: p.owner?.id ?? "", owner_name: p.owner?.display_name ?? null,
    owned: true, collaborative: !!p.collaborative, public: isPublic, total: 0,
    url: p.external_urls?.spotify ?? null,
  };
}

/** PUT /playlists/{id} { public } — make a playlist you own public or private. */
export async function setPlaylistPublic(http: Http, playlistId: string, isPublic: boolean): Promise<void> {
  await http.put(`/playlists/${encodeURIComponent(playlistId)}`, { public: isPublic });
}

/** Add track/episode URIs to a playlist, 100 per request, in order. Rejects malformed URIs up front. */
export async function addToPlaylist(
  http: Http,
  playlistId: string,
  uris: string[],
  position?: number,
): Promise<{ added: number; snapshot_id: string | null }> {
  const bad = uris.filter((u) => !URI_RE.test(u));
  if (bad.length) {
    throw new SpotifyError(400, "BAD_INPUT", `Not a spotify:track:/spotify:episode: URI: ${bad.slice(0, 5).join(", ")}`);
  }
  if (!uris.length) return { added: 0, snapshot_id: null };
  let snapshot: string | null = null;
  for (let i = 0; i < uris.length; i += 100) {
    const chunk = uris.slice(i, i + 100);
    const body: { uris: string[]; position?: number } = { uris: chunk };
    if (position !== undefined) body.position = position + i;
    const res = await http.post<{ snapshot_id?: string }>(`/playlists/${encodeURIComponent(playlistId)}/items`, body);
    snapshot = res?.snapshot_id ?? snapshot;
  }
  return { added: uris.length, snapshot_id: snapshot };
}
