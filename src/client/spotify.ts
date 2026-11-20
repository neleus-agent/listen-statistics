import { SpotifyApi } from "@spotify/web-api-ts-sdk";
import type { AccessToken, IAuthStrategy, SdkConfiguration } from "@spotify/web-api-ts-sdk";
import { TokenStore, withExpiry, type StoredToken } from "../auth/tokenStore.js";
import { SpotifyError } from "./error.js";
import { SpotifyHttp } from "./http.js";

const TOKEN_URL = "https://accounts.spotify.com/api/token";

/** Low-level refresh against Spotify (PKCE app: client_id, no secret). Exposed for tests. */
export async function refreshAccessToken(
  clientId: string,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Omit<StoredToken, "expires">> {
  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const text = await res.text();
  if (!res.ok) {
    // Redact: the refresh body can echo the rotating refresh token; log status + a truncated snippet only.
    throw new SpotifyError(res.status, res.status === 400 || res.status === 401 ? "NOT_AUTHENTICATED" : "UNKNOWN", `Token refresh failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as Omit<StoredToken, "expires">;
}

/**
 * Auth strategy backed by the persisted token file. On every refresh it carries the rotating refresh token
 * forward (Spotify sometimes omits it) and persists atomically BEFORE the new token is used — a crash can
 * never lose the rotation. Implements the SDK IAuthStrategy interface, so we avoid the SDK internal imports.
 */
export class PersistingAuthStrategy implements IAuthStrategy {
  private token: AccessToken | null = null;

  constructor(
    private readonly clientId: string,
    private readonly store: TokenStore,
    private readonly refreshImpl: typeof refreshAccessToken = refreshAccessToken,
    private readonly now: () => number = Date.now,
  ) {}

  setConfiguration(_config: SdkConfiguration): void {
    /* no SDK-side config needed */
  }

  async getOrCreateAccessToken(): Promise<AccessToken> {
    const token = await this.ensureLoaded();
    const expires = token.expires ?? 0;
    // Refresh slightly early (30s skew) so an in-flight request never races expiry.
    if (expires - 30_000 <= this.now()) {
      return this.refreshAndSave(token);
    }
    return token;
  }

  async getAccessToken(): Promise<AccessToken | null> {
    try {
      return await this.ensureLoaded();
    } catch {
      return null;
    }
  }

  removeAccessToken(): void {
    this.token = null;
  }

  private async ensureLoaded(): Promise<AccessToken> {
    if (this.token) return this.token;
    const stored = await this.store.load();
    if (!stored) {
      throw new SpotifyError(401, "NOT_AUTHENTICATED", "No saved Spotify token. Run: node dist/index.js auth");
    }
    this.token = {
      access_token: stored.access_token,
      token_type: stored.token_type,
      expires_in: stored.expires_in,
      refresh_token: stored.refresh_token,
      expires: stored.expires,
    };
    return this.token;
  }

  private async refreshAndSave(prev: AccessToken): Promise<AccessToken> {
    const raw = await this.refreshImpl(this.clientId, prev.refresh_token);
    const merged: StoredToken = withExpiry(
      {
        access_token: raw.access_token,
        token_type: raw.token_type,
        expires_in: raw.expires_in,
        // carry the rotating refresh token forward when Spotify omits it
        refresh_token: raw.refresh_token || prev.refresh_token,
        scope: (raw as { scope?: string }).scope,
      },
      this.now(),
    );
    await this.store.save(merged); // CRITICAL: persist BEFORE returning
    this.token = {
      access_token: merged.access_token,
      token_type: merged.token_type,
      expires_in: merged.expires_in,
      refresh_token: merged.refresh_token,
      expires: merged.expires,
    };
    return this.token;
  }
}

/**
 * Build the SDK client AND the raw HTTP client over ONE PersistingAuthStrategy, so a single holder rotates
 * the refresh token (two strategies would each refresh and invalidate the other's token).
 */
export async function createClients(
  clientId: string,
  store: TokenStore,
): Promise<{ api: SpotifyApi; http: SpotifyHttp }> {
  const strategy = new PersistingAuthStrategy(clientId, store);
  await strategy.getAccessToken();
  return { api: new SpotifyApi(strategy), http: new SpotifyHttp(strategy) };
}

/** Build an authenticated SpotifyApi from the persisted token + the persisting refresh strategy. */
export async function createSpotifyClient(
  clientId: string,
  store: TokenStore,
  refreshImpl?: typeof refreshAccessToken,
): Promise<SpotifyApi> {
  const strategy = new PersistingAuthStrategy(clientId, store, refreshImpl);
  // Surface a missing token now (clear error) rather than on the first API call.
  await strategy.getAccessToken();
  return new SpotifyApi(strategy);
}
