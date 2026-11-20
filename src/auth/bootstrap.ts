import http from "node:http";
import { URL } from "node:url";
import { spawn } from "node:child_process";
import { generateVerifier, challengeFromVerifier, generateState } from "./pkce.js";
import { TokenStore, withExpiry, type StoredToken } from "./tokenStore.js";
import { SCOPES, type AppConfig } from "../config.js";

const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

/** Open a URL in the default browser (best-effort, per-platform). Auth still works if the user pastes it. */
export function openBrowser(url: string): void {
  const platform = process.platform;
  // Windows: NOT `cmd /c start` — cmd splits the URL at every `&`, so Spotify only saw client_id
  // ("response_type must be code"). rundll32 hands the whole URL to the default browser untouched.
  const cmd = platform === "win32" ? "rundll32" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref(); // cmd.exe would flash a console without windowsHide
  } catch {
    /* user can paste the URL manually */
  }
}

/** Exchange the authorization code + PKCE verifier for tokens (no client secret). */
export async function exchangeCode(
  config: AppConfig,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredToken> {
  const params = new URLSearchParams({
    client_id: config.clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const text = await res.text();
  if (!res.ok) {
    // Redact: response bodies can echo back code/verifier; log status + a truncated snippet only.
    throw new Error(`Token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text) as Omit<StoredToken, "expires">;
  return withExpiry(json);
}

/** Build the Spotify authorize URL for Authorization Code + PKCE (S256). */
export function buildAuthorizeUrl(config: AppConfig, challenge: string, state: string): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", config.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", config.redirectUri);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("state", state);
  u.searchParams.set("scope", SCOPES.join(" "));
  return u.toString();
}

/**
 * One-time interactive consent. Spins a loopback server on 127.0.0.1:<port>/callback, opens the browser to
 * the authorize URL, waits for the redirect, exchanges the code, and persists the token atomically.
 * This is the ONLY step that needs the live Client ID + a human at the keyboard.
 */
export async function bootstrapAuth(config: AppConfig, store: TokenStore): Promise<void> {
  const verifier = generateVerifier();
  const challenge = challengeFromVerifier(verifier);
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl(config, challenge, state);

  const CONSENT_TIMEOUT_MS = 5 * 60_000; // give the human 5 minutes to complete consent

  const code = await new Promise<string>((resolve, reject) => {
    // Don't wait forever for a callback that may never arrive (tab closed, no consent).
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Spotify consent timed out (no callback within 5 minutes)."));
    }, CONSENT_TIMEOUT_MS);
    const done = (fn: () => void): void => {
      clearTimeout(timer);
      fn();
    };
    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url ?? "/", config.redirectUri);
        if (reqUrl.pathname !== "/callback") {
          res.writeHead(404).end("not found");
          return;
        }
        const err = reqUrl.searchParams.get("error");
        const returnedState = reqUrl.searchParams.get("state");
        const returnedCode = reqUrl.searchParams.get("code");
        if (err) {
          res.writeHead(400, { "content-type": "text/html" }).end(`<h1>Authorization failed</h1><p>${err}</p>`);
          server.close();
          done(() => reject(new Error(`Authorization denied: ${err}`)));
          return;
        }
        if (returnedState !== state) {
          res.writeHead(400, { "content-type": "text/html" }).end("<h1>State mismatch</h1>");
          server.close();
          done(() => reject(new Error("OAuth state mismatch — possible CSRF; aborted.")));
          return;
        }
        if (!returnedCode) {
          res.writeHead(400, { "content-type": "text/html" }).end("<h1>No code returned</h1>");
          server.close();
          done(() => reject(new Error("No authorization code in callback.")));
          return;
        }
        res.writeHead(200, { "content-type": "text/html" }).end(
          "<h1>Spotify connected.</h1><p>You can close this tab and return to the terminal.</p>",
        );
        server.close();
        done(() => resolve(returnedCode));
      } catch (e) {
        server.close();
        done(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    });
    server.on("error", (e) => done(() => reject(e)));
    server.listen(config.callbackPort, "127.0.0.1", () => {
      process.stderr.write(`
[mcp-spotify] Opening browser for Spotify consent...
`);
      process.stderr.write(`[mcp-spotify] If it does not open, paste this URL:
${authorizeUrl}

`);
      openBrowser(authorizeUrl);
    });
  });

  const token = await exchangeCode(config, code, verifier);
  await store.save(token);
  process.stderr.write(`[mcp-spotify] Token saved to ${store.filePath}
`);
}
