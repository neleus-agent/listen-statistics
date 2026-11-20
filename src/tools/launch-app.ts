import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlaybackApi } from "../intents/playback.js";
import type { AuditLogger } from "../safety/audit.js";
import { launchSpotifyApp } from "../system/launchApp.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wake-device — launch the local Spotify desktop app, then poll until a controllable device appears. */
export function registerLaunchApp(
  server: McpServer,
  getApi: () => Promise<PlaybackApi>,
  audit: AuditLogger,
): void {
  server.tool(
    "launch_app",
    "Launch the local Spotify desktop app so it becomes a controllable device, then wait briefly and report available devices. Use when no active device is available before playing.",
    {},
    async () => {
      const launch = launchSpotifyApp();

      // Poll the devices list for up to ~9s — the app takes a few seconds to register over Connect.
      let devices: string[] = [];
      if (launch.launched) {
        for (let i = 0; i < 6; i++) {
          await sleep(1500);
          try {
            const api = await getApi();
            const d = await api.player.getAvailableDevices();
            devices = (d?.devices ?? []).map((x) => x.name).filter((n): n is string => !!n);
            if (devices.length) break;
          } catch {
            /* token/device not ready yet — keep polling */
          }
        }
      }

      const result = {
        ok: launch.ok,
        launched: launch.launched,
        method: launch.method,
        device_count: devices.length,
        devices,
        message: launch.launched
          ? devices.length
            ? `${launch.message} Device ready: ${devices.join(", ")}.`
            : `${launch.message} No device registered yet — give it a moment, then try playing.`
          : launch.message,
      };

      try {
        await audit.log({
          tool: "launch_app",
          action: "launch",
          success: launch.ok,
          detail: launch.method,
          error: launch.ok ? undefined : "LAUNCH_FAILED",
        });
      } catch {
        /* audit is best-effort */
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
