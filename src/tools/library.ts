import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Http } from "../client/http.js";
import { SpotifyError } from "../client/error.js";
import type { AuditLogger } from "../safety/audit.js";
import { getMe, listPlaylists, resolvePlaylist, getPlaylistEntries, createPlaylist, addToPlaylist } from "../library/library.js";
import { exportLibrary } from "../library/export.js";
import { baseDir } from "../config.js";

type Json = Record<string, unknown>;
const ok = (body: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ...body }, null, 2) }] });
const err = (e: unknown) => {
  const code = e instanceof SpotifyError ? e.code : "UNKNOWN";
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: code, message }, null, 2) }] };
};

/** Default export folder: ~/Downloads/spotify-export-YYYY-MM-DD (override with SPOTIFY_EXPORT_DIR). */
export function defaultExportDir(now = new Date()): string {
  const base = process.env.SPOTIFY_EXPORT_DIR || join(homedir(), "Downloads");
  return join(base, `spotify-export-${now.toISOString().slice(0, 10)}`);
}

/** Library tools: read playlists, export to CSV, create playlists, add tracks. Writes are audited. */
export function registerLibrary(server: McpServer, getHttp: () => Promise<Http>, audit: AuditLogger): void {
  server.tool(
    "list_playlists",
    "List the user's Spotify playlists (owned and followed) with id, owner, track count and whether their tracks are readable (owned or collaborative).",
    {},
    async () => {
      try {
        const http = await getHttp();
        const me = await getMe(http);
        const playlists = await listPlaylists(http, me);
        return ok({
          user: me.display_name ?? me.id,
          count: playlists.length,
          playlists: playlists.map((p) => ({ name: p.name, id: p.id, owner: p.owner_name ?? p.owner_id, tracks: p.total, readable: p.owned || p.collaborative })),
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "playlist_tracks",
    "List the tracks of one playlist (by name, id, spotify: URI or open.spotify.com URL). Only playlists the user owns or collaborates on are readable.",
    {
      playlist: z.string().describe("Playlist name (partial ok), id, URI or URL"),
      limit: z.number().int().min(1).max(500).optional().describe("Max tracks to return (default 100)"),
    },
    async (args) => {
      try {
        const http = await getHttp();
        const me = await getMe(http);
        const pl = await resolvePlaylist(http, me, args.playlist);
        const entries = await getPlaylistEntries(http, pl.id);
        const tracks = entries.filter((e) => e.track).slice(0, args.limit ?? 100).map((e, i) => ({
          n: i + 1,
          name: e.track!.name,
          artists: (e.track!.artists ?? []).map((a) => a.name).join(", "),
          album: e.track!.album?.name ?? null,
          uri: e.track!.uri,
        }));
        return ok({ playlist: pl.name, id: pl.id, total: entries.length, returned: tracks.length, tracks });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "export_playlists",
    "Export all readable playlists (plus Liked Songs) to CSV files enriched with album, year, ISRC, genres and, where Spotify still allows, tempo/key. Writes tracks.csv + playlists.csv and returns their paths and a summary. Can take minutes for large libraries.",
    {
      out_dir: z.string().optional().describe("Folder to write to (default ~/Downloads/spotify-export-<date>)"),
      include_liked: z.boolean().optional().describe("Include Liked Songs (default true)"),
      enrich: z.boolean().optional().describe("Fetch genres + audio features (default true)"),
    },
    async (args) => {
      try {
        const summary = await exportLibrary(await getHttp(), {
          outDir: args.out_dir || defaultExportDir(),
          includeLiked: args.include_liked,
          enrich: args.enrich,
          genreCachePath: join(baseDir(), "artist-genres.json"),
        });
        return ok({ ...summary });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "create_playlist",
    "Create a new playlist in the user's account (private by default). Returns its id and URL.",
    {
      name: z.string().describe("Playlist name"),
      description: z.string().optional(),
      public: z.boolean().optional().describe("Make it public (default false)"),
    },
    async (args) => {
      try {
        const pl = await createPlaylist(await getHttp(), args);
        await audit.log({ tool: "create_playlist", action: "create", success: true, detail: `${pl.name} (${pl.id})` }).catch(() => {});
        return ok({ playlist: pl });
      } catch (e) {
        await audit.log({ tool: "create_playlist", action: "create", success: false, detail: args.name, error: String(e) }).catch(() => {});
        return err(e);
      }
    },
  );

  server.tool(
    "add_to_playlist",
    "Add tracks to a playlist the user owns or collaborates on, by spotify:track: URIs (resolve names first with `search`). Appends in order unless a position is given.",
    {
      playlist: z.string().describe("Playlist name (partial ok), id, URI or URL"),
      uris: z.array(z.string()).min(1).max(1000).describe("spotify:track:... or spotify:episode:... URIs"),
      position: z.number().int().min(0).optional().describe("0-based insert position (default: append)"),
    },
    async (args) => {
      try {
        const http = await getHttp();
        const pl = await resolvePlaylist(http, await getMe(http), args.playlist);
        const res = await addToPlaylist(http, pl.id, args.uris, args.position);
        await audit.log({ tool: "add_to_playlist", action: "add", success: true, detail: `${res.added} -> ${pl.name} (${pl.id})` }).catch(() => {});
        return ok({ playlist: pl.name, id: pl.id, ...res });
      } catch (e) {
        await audit.log({ tool: "add_to_playlist", action: "add", success: false, detail: args.playlist, error: String(e) }).catch(() => {});
        return err(e);
      }
    },
  );
}
