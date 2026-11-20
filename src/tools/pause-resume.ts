import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlaybackApi } from "../intents/playback.js";
import type { AuditLogger } from "../safety/audit.js";
import { toContent, auditResult } from "./shared.js";
import { pauseResume } from "../intents/playback.js";

/** C2 — pause, resume, or toggle playback. */
export function registerPauseResume(
  server: McpServer,
  getApi: () => Promise<PlaybackApi>,
  audit: AuditLogger,
): void {
  server.tool(
    "pause_resume",
    "Pause, resume, or toggle Spotify playback on the active device. Returns the now_playing state.",
    { action: z.enum(["pause", "resume", "toggle"]).optional().describe("Default: toggle") },
    async (args) => {
      const result = await pauseResume({ api: await getApi() }, args.action ?? "toggle");
      await auditResult(audit, "pause_resume", args.action ?? "toggle", result);
      return toContent(result);
    },
  );
}
