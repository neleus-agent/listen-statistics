import { spawn } from "node:child_process";

export interface LaunchResult {
  ok: boolean;
  launched: boolean;
  platform: string;
  method: string;
  message: string;
}

/**
 * Launch the local Spotify desktop application so it registers as a Spotify Connect device.
 * Best-effort and non-blocking (detached) — on Windows we invoke the `spotify:` protocol handler that
 * both the Store and desktop installers register (mirrors the browser-open in auth/bootstrap.ts).
 * This does NOT guarantee the device is immediately controllable; the caller should poll the devices list.
 */
export function launchSpotifyApp(platform: string = process.platform): LaunchResult {
  try {
    if (platform === "win32") {
      // windowsHide: cmd.exe is a CONSOLE-subsystem binary — without it a console window flashes on every launch.
      spawn("cmd", ["/c", "start", '""', "spotify:"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      return { ok: true, launched: true, platform, method: "spotify: protocol", message: "Launching the Spotify desktop app." };
    }
    if (platform === "darwin") {
      spawn("open", ["-a", "Spotify"], { detached: true, stdio: "ignore" }).unref();
      return { ok: true, launched: true, platform, method: "open -a Spotify", message: "Launching Spotify.app." };
    }
    spawn("xdg-open", ["spotify:"], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, launched: true, platform, method: "xdg-open spotify:", message: "Launching Spotify via xdg-open." };
  } catch (e) {
    return {
      ok: false,
      launched: false,
      platform,
      method: "none",
      message: `Could not launch Spotify: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
