import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlaybackApi } from "../intents/playback.js";
import type { AuditLogger } from "../safety/audit.js";
import { toContent, auditResult } from "./shared.js";
import { transferTo } from "../intents/playback.js";

/** Transfer playback to a device by name (case-insensitive partial match). Returns now_playing. */
export function registerTransfer(
  server: McpServer,
  getApi: () => Promise<PlaybackApi>,
  audit: AuditLogger,
): void {
  server.tool(
    "transfer",
    "Move playback to a Spotify Connect device by name (case-insensitive partial match, e.g. a Sonos room like 'kitchen'). Returns now_playing.",
    {
      device: z.string().describe("Device name to transfer playback to (partial match), e.g. Kitchen, Bedroom"),
      play: z.boolean().optional().describe("Start playing on the target device (default true)"),
    },
    async (args) => {
      const result = await transferTo({ api: await getApi() }, args.device, { play: args.play });
      await auditResult(audit, "transfer", "transfer", result, args.device);
      return toContent(result);
    },
  );
}
