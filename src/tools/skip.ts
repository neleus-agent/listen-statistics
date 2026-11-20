import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlaybackApi } from "../intents/playback.js";
import type { AuditLogger } from "../safety/audit.js";
import { toContent, auditResult } from "./shared.js";
import { skip } from "../intents/playback.js";

/** C3 — skip to next or previous track. */
export function registerSkip(
  server: McpServer,
  getApi: () => Promise<PlaybackApi>,
  audit: AuditLogger,
): void {
  server.tool(
    "skip",
    "Skip to the next or previous track on the active Spotify device. Returns the now_playing state.",
    { direction: z.enum(["next", "previous"]).describe("Skip direction") },
    async (args) => {
      const result = await skip({ api: await getApi() }, args.direction);
      await auditResult(audit, "skip", args.direction, result);
      return toContent(result);
    },
  );
}
