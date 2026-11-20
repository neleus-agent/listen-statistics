import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlaybackApi } from "../intents/playback.js";
import type { AuditLogger } from "../safety/audit.js";
import { searchTracks } from "../intents/playback.js";

/** Search Spotify for tracks by name → returns top matches with their spotify: URIs. Does NOT play. */
export function registerSearch(
  server: McpServer,
  getApi: () => Promise<PlaybackApi>,
  _audit: AuditLogger,
): void {
  server.tool(
    "search",
    "Search Spotify for tracks by name and return the top matches with their spotify: URIs. Does NOT play — use to resolve a song name to a URI (e.g. to then play it on a Sonos room via mcp-sonos).",
    { query: z.string().describe("Track name (and optionally artist) to search for") },
    async (args) => {
      const result = await searchTracks({ api: await getApi() }, args.query);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
