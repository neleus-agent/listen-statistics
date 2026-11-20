import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlaybackApi } from "../intents/playback.js";
import type { AuditLogger } from "../safety/audit.js";
import { toContent, auditResult } from "./shared.js";
import { setVolume } from "../intents/playback.js";

/** C5 — set volume (absolute level or relative delta), clamped 0-100. */
export function registerVolume(
  server: McpServer,
  getApi: () => Promise<PlaybackApi>,
  audit: AuditLogger,
): void {
  server.tool(
    "volume",
    "Set Spotify volume on the active device: absolute level (0-100) or relative delta. Returns now_playing.",
    {
      level: z.number().min(0).max(100).optional().describe("Absolute volume 0-100"),
      delta: z.number().optional().describe("Relative change, e.g. -10 or 15"),
    },
    async (args) => {
      const result = await setVolume({ api: await getApi() }, { level: args.level, delta: args.delta });
      await auditResult(audit, "volume", "set", result, JSON.stringify({ level: args.level, delta: args.delta }));
      return toContent(result);
    },
  );
}
