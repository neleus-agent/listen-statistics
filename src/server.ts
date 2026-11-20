import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { TokenStore } from "./auth/tokenStore.js";
import { createClients } from "./client/spotify.js";
import type { Http } from "./client/http.js";
import { AuditLogger } from "./safety/audit.js";
import type { PlaybackApi } from "./intents/playback.js";
import { registerPlay } from "./tools/play.js";
import { registerPauseResume } from "./tools/pause-resume.js";
import { registerSkip } from "./tools/skip.js";
import { registerNowPlaying } from "./tools/now-playing.js";
import { registerVolume } from "./tools/volume.js";
import { registerPlayMood } from "./tools/play-mood.js";
import { registerLaunchApp } from "./tools/launch-app.js";
import { registerListDevices } from "./tools/list-devices.js";
import { registerTransfer } from "./tools/transfer.js";
import { registerSearch } from "./tools/search.js";
import { registerLibrary } from "./tools/library.js";

/**
 * Build the MCP server with the playback + launch tools. The Spotify client is created LAZILY per call (and the
 * SDK instance reused once built) so the server starts even before consent — the first tool call surfaces a
 * NOT_AUTHENTICATED result instead of crashing at boot.
 */
export async function createServer(): Promise<McpServer> {
  const config = loadConfig();
  const store = new TokenStore(config.tokenPath);
  const audit = new AuditLogger(config.auditPath);

  let clients: { api: PlaybackApi; http: Http } | null = null;
  const getClients = async () => (clients ??= await createClients(config.clientId, store));
  const getApi = async (): Promise<PlaybackApi> => (await getClients()).api;
  const getHttp = async (): Promise<Http> => (await getClients()).http;

  const server = new McpServer({ name: "mcp-spotify", version: "0.3.0" });

  registerPlay(server, getApi, audit);
  registerPauseResume(server, getApi, audit);
  registerSkip(server, getApi, audit);
  registerNowPlaying(server, getApi, audit);
  registerVolume(server, getApi, audit);
  registerPlayMood(server, getApi, audit);
  registerLaunchApp(server, getApi, audit);
  registerListDevices(server, getApi, audit);
  registerTransfer(server, getApi, audit);
  registerSearch(server, getApi, audit);
  registerLibrary(server, getHttp, audit);

  return server;
}
