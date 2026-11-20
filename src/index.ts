import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, SCOPES, baseDir } from "./config.js";
import { createClients } from "./client/spotify.js";
import { exportLibrary } from "./library/export.js";
import { enrichFile } from "./enrich/run.js";
import { defaultExportDir } from "./tools/library.js";
import { TokenStore } from "./auth/tokenStore.js";
import { bootstrapAuth, openBrowser } from "./auth/bootstrap.js";
import { firstExisting, HISTORY_FILE, importHistory, latestExportDir } from "./history/import.js";
import { startDashboard } from "./dashboard/server.js";

/**
 * Dispatch:
 *   node dist/index.js auth          -> one-time interactive consent (PKCE) + persist token
 *   node dist/index.js auth status   -> report whether a token is saved + its expiry
 *   node dist/index.js auth clear     -> delete the saved token
 *   node dist/index.js export [--out DIR] [--no-liked] [--no-enrich]
 *                                    -> write tracks.csv + playlists.csv of all readable playlists
 *   node dist/index.js enrich <tracks.csv> [--popularity] [--ratings] [--max-ratings N] [--out FILE]
 *                                    -> add MusicBrainz genres, artist country, original year, album ratings;
 *                                       --popularity adds song-level ListenBrainz + Deezer popularity
 *   node dist/index.js viewer        -> open the offline library-stats page (drop the CSV on it)
 *   node dist/index.js import-history <my_spotify_data.zip | folder> [--library CSV] [--out DIR]
 *                                    -> aggregate Extended streaming history per track into tracks-history.csv
 *   node dist/index.js dashboard [CSV] [--port N]
 *                                    -> serve the viewer + your CSV on http://127.0.0.1 only
 *   node dist/index.js               -> start the stdio MCP server
 */
async function main(): Promise<void> {
  const [cmd, sub] = process.argv.slice(2);

  if (cmd === "auth") {
    const config = loadConfig();
    const store = new TokenStore(config.tokenPath);
    if (sub === "status") {
      const token = await store.load();
      if (!token) {
        process.stdout.write(`No token saved at ${store.filePath}. Run: node dist/index.js auth
`);
      } else {
        const valid = token.expires > Date.now();
        process.stdout.write(
          `Token saved at ${store.filePath}
` +
            `  access token ${valid ? "valid" : "expired"} (expires ${new Date(token.expires).toISOString()})
` +
            `  refresh token present: ${token.refresh_token ? "yes" : "no"}
`,
        );
        const granted = new Set((token.scope ?? "").split(/\s+/).filter(Boolean));
        const missing = SCOPES.filter((s) => !granted.has(s));
        process.stdout.write(
          missing.length
            ? `  MISSING scopes: ${missing.join(", ")}
  Re-run: node dist/index.js auth (one fresh consent)
`
            : `  all ${SCOPES.length} scopes granted
`,
        );
      }
      return;
    }
    if (sub === "clear") {
      await store.clear();
      process.stdout.write(`Cleared token at ${store.filePath}
`);
      return;
    }
    await bootstrapAuth(config, store);
    return;
  }

  if (cmd === "viewer") {
    // The offline stats page ships next to dist/ (package "files"); open it in the default browser.
    const page = join(dirname(fileURLToPath(import.meta.url)), "..", "viewer", "index.html");
    openBrowser(pathToFileURL(page).href);
    process.stdout.write(`Opened ${page}. Drop your tracks-enriched.csv on it.
`);
    return;
  }

  if (cmd === "import-history") {
    // Offline: reads Spotify's privacy export, keeps 7 fields per stream, writes per-track aggregates only.
    const args = process.argv.slice(3);
    const flag = (name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
    const input = args.find((a, i) => !a.startsWith("--") && !["--library", "--out"].includes(args[i - 1]));
    if (!input) throw new Error("usage: import-history <my_spotify_data.zip | unzipped folder> [--library tracks-enriched.csv] [--out DIR]");
    const exportBase = dirname(defaultExportDir());
    const library = flag("--library") ?? (await firstExisting(await latestExportDir(exportBase), ["tracks-enriched.csv", "tracks.csv"]));
    const summary = await importHistory({ input, library, outDir: flag("--out") });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\nOpen it with: npm run dashboard\n`);
    return;
  }

  if (cmd === "dashboard") {
    const args = process.argv.slice(3);
    const portIdx = args.indexOf("--port");
    const explicit = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--port");
    const exportBase = dirname(defaultExportDir());
    const csv = explicit ?? (await firstExisting(await latestExportDir(exportBase), [HISTORY_FILE, "tracks-enriched.csv", "tracks.csv"]));
    const page = join(dirname(fileURLToPath(import.meta.url)), "..", "viewer", "index.html");
    const { url } = await startDashboard({ page, csv, port: portIdx >= 0 ? Number(args[portIdx + 1]) : undefined });
    openBrowser(url);
    process.stdout.write(`Dashboard on ${url} (this computer only). Showing: ${csv ?? "nothing yet, drop a CSV on the page"}\nPress Ctrl+C to stop.\n`);
    return;
  }

  if (cmd === "enrich") {
    // MusicBrainz only: no Spotify account or quota needed, works on any tracks.csv from `export`.
    const args = process.argv.slice(3);
    const input = args.find((a) => !a.startsWith("--"));
    if (!input) throw new Error("usage: enrich <tracks.csv> [--popularity] [--lastfm] [--ratings] [--max-ratings N] [--out FILE]");
    const flag = (name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
    const summary = await enrichFile({
      input,
      output: flag("--out"),
      cachePath: join(baseDir(), "musicbrainz-cache.json"),
      popCachePath: join(baseDir(), "popularity-cache.json"),
      popularity: args.includes("--popularity") || args.includes("--lastfm"),
      lastfm: args.includes("--lastfm")
        ? { apiKey: process.env.LASTFM_API_KEY ?? "", user: process.env.LASTFM_USER || undefined }
        : undefined,
      ratings: args.includes("--ratings"),
      maxRatings: flag("--max-ratings") ? Number(flag("--max-ratings")) : undefined,
      log: (m) => process.stderr.write(`[mcp-spotify] ${m}
`),
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}
`);
    return;
  }

  if (cmd === "export") {
    const args = process.argv.slice(3);
    const outIdx = args.indexOf("--out");
    const config = loadConfig();
    const { http } = await createClients(config.clientId, new TokenStore(config.tokenPath));
    const summary = await exportLibrary(http, {
      outDir: outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : defaultExportDir(),
      includeLiked: !args.includes("--no-liked"),
      enrich: !args.includes("--no-enrich"),
      genreCachePath: join(baseDir(), "artist-genres.json"),
      log: (m) => process.stderr.write(`[mcp-spotify] ${m}
`),
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}
`);
    return;
  }

  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mcp-spotify] Server started on stdio\n");
}

main().catch((error) => {
  process.stderr.write(`[mcp-spotify] Fatal error: ${error}
`);
  process.exit(1);
});
