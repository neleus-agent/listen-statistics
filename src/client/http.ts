import { SpotifyError } from "./error.js";

const API_BASE = "https://api.spotify.com/v1";

/** Anything that can hand out a fresh access token (the PersistingAuthStrategy does). */
export interface TokenSource {
  getOrCreateAccessToken(): Promise<{ access_token: string }>;
}

/** The minimal HTTP surface the library layer needs; tests pass a fake. */
export interface Http {
  get<T>(pathOrUrl: string): Promise<T>;
  post<T>(pathOrUrl: string, body: unknown): Promise<T>;
  put<T>(pathOrUrl: string, body: unknown): Promise<T>;
}

export interface HttpOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** retries on 429 / 5xx before giving up (bulk export needs more than the playback path's one retry). */
  maxRetries?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_WAIT_MS = 30_000;

/**
 * Thin Web API client for the endpoints the SDK does not cover (the February 2026 renames:
 * /playlists/{id}/items, POST /me/playlists). Shares the token source with the SDK so there is only ONE
 * holder of the rotating refresh token. Honours Retry-After on 429 and retries 5xx with backoff.
 */
export class SpotifyHttp implements Http {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly tokens: TokenSource, opts: HttpOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? realSleep;
    this.maxRetries = opts.maxRetries ?? 5;
  }

  get<T>(pathOrUrl: string): Promise<T> {
    return this.request<T>("GET", pathOrUrl);
  }

  post<T>(pathOrUrl: string, body: unknown): Promise<T> {
    return this.request<T>("POST", pathOrUrl, body);
  }

  put<T>(pathOrUrl: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", pathOrUrl, body);
  }

  private async request<T>(method: string, pathOrUrl: string, body?: unknown): Promise<T> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API_BASE}${pathOrUrl}`;
    for (let attempt = 0; ; attempt++) {
      const { access_token } = await this.tokens.getOrCreateAccessToken();
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${access_token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      const ra = parseInt(res.headers.get("retry-after") ?? "", 10);
      // A long Retry-After (Spotify hands out ~24 h bans per endpoint) is not worth waiting on: fail fast.
      if (res.status === 429 && Number.isFinite(ra) && ra * 1000 > MAX_WAIT_MS) {
        throw new RateLimitedError(ra, `${method} ${url.replace(API_BASE, "")}`);
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        const wait = res.status === 429 && Number.isFinite(ra) ? ra * 1000 : 500 * 2 ** attempt;
        await this.sleep(Math.min(wait, MAX_WAIT_MS));
        continue;
      }
      throw await toError(res, method, url);
    }
  }
}

/** 429 with a Retry-After too long to wait out; carries when the endpoint opens again. */
export class RateLimitedError extends SpotifyError {
  constructor(public readonly retryAfterSec: number, where: string) {
    super(429, "RATE_LIMITED", `Spotify rate-limited ${where} for ${Math.round(retryAfterSec / 60)} min.`);
  }
}

async function toError(res: Response, method: string, url: string): Promise<SpotifyError> {
  let msg = "";
  try {
    const j = JSON.parse(await res.text()) as { error?: { message?: string } | string };
    msg = typeof j.error === "string" ? j.error : (j.error?.message ?? "");
  } catch {
    /* non-JSON body */
  }
  const where = `${method} ${url.replace(API_BASE, "")}`;
  if (res.status === 401) return new SpotifyError(401, "NOT_AUTHENTICATED", `Not authenticated (${where}). Run: mcp-spotify auth`);
  if (res.status === 403 && /scope/i.test(msg)) {
    return new SpotifyError(403, "INSUFFICIENT_SCOPE", `Missing permission for ${where}. Re-run: mcp-spotify auth (new scopes need one fresh consent).`);
  }
  if (res.status === 403) return new SpotifyError(403, "FORBIDDEN", `Spotify refused ${where}: ${msg || "forbidden"}`);
  if (res.status === 404) return new SpotifyError(404, "NOT_FOUND", `Not found: ${where}`);
  if (res.status === 429) return new SpotifyError(429, "RATE_LIMITED", "Spotify is rate-limiting requests. Try again shortly.");
  return new SpotifyError(res.status, "UNKNOWN", `Spotify ${res.status} on ${where}: ${msg}`.trim());
}
