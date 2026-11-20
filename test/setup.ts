// Vitest global setup. Point the token store + audit at an isolated tmp dir per run so tests never
// touch the real ~/.ai/mcp-spotify store, and keep retry backoff fast.
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MCP_BASE_DIR = join(tmpdir(), `mcp-spotify-test-${process.pid}`);
process.env.SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "test_client_id";
