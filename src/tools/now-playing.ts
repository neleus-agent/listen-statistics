import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlaybackApi } from "../intents/playback.js";
import type { AuditLogger } from "../safety/audit.js";
import { toContent, auditResult } from "./shared.js";
import { getNowPlaying } from "../intents/playback.js";

/** C4 — read the current now_playing state. */
export function registerNowPlaying(
  server: McpServer,
  getApi: () => Promise<PlaybackApi>,
  _audit: AuditLogger,
): void {
  server.tool(
    "now_playing",
    "Get the current Spotify playback state: track, artist, album, device, progress, and volume.",
    {},
    async () => {
      const result = await getNowPlaying({ api: await getApi() });
      return toContent(result);
    },
  );
}
