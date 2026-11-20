import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlaybackApi } from "../intents/playback.js";
import type { AuditLogger } from "../safety/audit.js";
import { toContent, auditResult } from "./shared.js";
import { playByName } from "../intents/playback.js";

/** C1 — play a track by name. */
export function registerPlay(
  server: McpServer,
  getApi: () => Promise<PlaybackApi>,
  audit: AuditLogger,
): void {
  server.tool(
    "play",
    "Search Spotify for a track by name and start playing it. Plays on the active device, or on a named device (e.g. a Sonos room) when 'device' is given. Returns the now_playing state.",
    {
      query: z.string().describe("Track name (and optionally artist) to search and play"),
      device: z
        .string()
        .optional()
        .describe("Optional device name to play on (partial match), e.g. Kitchen, Bedroom"),
    },
    async (args) => {
      const result = await playByName({ api: await getApi() }, args.query, { device: args.device });
      await auditResult(audit, "play", "play", result, args.query);
      return toContent(result);
    },
  );
}
