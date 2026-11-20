import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlaybackApi } from "../intents/playback.js";
import type { AuditLogger } from "../safety/audit.js";
import { listDevices } from "../intents/playback.js";

/** List the available Spotify Connect devices (id, name, type, is_active, volume_pct). */
export function registerListDevices(
  server: McpServer,
  getApi: () => Promise<PlaybackApi>,
  audit: AuditLogger,
): void {
  server.tool(
    "list_devices",
    "List the available Spotify Connect devices (id, name, type, is_active, volume_pct). Use to discover device names — e.g. linked Sonos rooms — before playing or transferring to one.",
    {},
    async () => {
      const result = await listDevices({ api: await getApi() });
      try {
        await audit.log({
          tool: "list_devices",
          action: "list",
          success: result.ok,
          detail: result.ok ? String(result.devices.length) : undefined,
          error: result.ok ? undefined : result.error,
        });
      } catch {
        /* audit is best-effort */
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
