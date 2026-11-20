import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlaybackApi } from "../intents/playback.js";
import type { AuditLogger } from "../safety/audit.js";
import { toContent, auditResult } from "./shared.js";
import { playByMood } from "../intents/playback.js";

/** C6 — play music for a mood (curated seed, else search fallback). */
export function registerPlayMood(
  server: McpServer,
  getApi: () => Promise<PlaybackApi>,
  audit: AuditLogger,
): void {
  server.tool(
    "play_mood",
    "Play music matching a mood (e.g. focus, chill, energetic, happy). Plays on the active device, or on a named device (e.g. a Sonos room) when 'device' is given. Falls back to search on an unknown mood.",
    {
      mood: z.string().describe("Mood word, e.g. focus, chill, energetic, party, sleep"),
      device: z
        .string()
        .optional()
        .describe("Optional device name to play on (partial match), e.g. Kitchen, Bedroom"),
    },
    async (args) => {
      const result = await playByMood({ api: await getApi() }, args.mood, { device: args.device });
      await auditResult(audit, "play_mood", "play", result, args.mood);
      return toContent(result);
    },
  );
}
