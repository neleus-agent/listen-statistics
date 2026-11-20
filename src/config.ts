import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Static OAuth + runtime config. Authorization Code + PKCE — no client secret.
 * Redirect URI is fixed to the loopback literal Spotify requires (127.0.0.1, not localhost).
 */
export const SCOPES = [
  "user-modify-playback-state",
  "user-read-playback-state",
  "user-read-currently-playing",
  // library (read): playlists + Liked Songs, for list/export
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
  // library (write): create playlists, add tracks
  "playlist-modify-private",
  "playlist-modify-public",
] as const;

export interface AppConfig {
  clientId: string;
  tokenPath: string;
  auditPath: string;
  callbackPort: number;
  redirectUri: string;
}

export function baseDir(): string {
  const aiBase = process.env.MCP_BASE_DIR || join(homedir(), ".ai");
  return join(aiBase, "mcp-spotify");
}

/** Default token-store path: ~/.ai/mcp-spotify/spotify.json (gitignored, outside any repo). */
export function defaultTokenPath(): string {
  return process.env.SPOTIFY_TOKEN_PATH || join(baseDir(), "spotify.json");
}

/** Resolve config. clientId is required for auth + live serving; some sub-commands tolerate its absence. */
export function loadConfig(requireClientId = true): AppConfig {
  const clientId = process.env.SPOTIFY_CLIENT_ID ?? "";
  if (requireClientId && !clientId) {
    throw new Error(
      "SPOTIFY_CLIENT_ID is required. Create a Spotify app (developer.spotify.com), " +
        "register redirect URI http://127.0.0.1:8888/callback, and set SPOTIFY_CLIENT_ID.",
    );
  }
  const callbackPort = parseInt(process.env.SPOTIFY_CALLBACK_PORT ?? "8888", 10) || 8888;
  return {
    clientId,
    tokenPath: defaultTokenPath(),
    auditPath: process.env.SPOTIFY_AUDIT_PATH ?? join(baseDir(), "audit"),
    callbackPort,
    redirectUri: `http://127.0.0.1:${callbackPort}/callback`,
  };
}
