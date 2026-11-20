import { SpotifyError } from "../client/error.js";

/**
 * 429 Retry-After backoff. Spotify returns 429 with a Retry-After header (seconds). We retry once
 * after honouring it (capped), so transient throttles self-heal; a second 429 surfaces as RATE_LIMITED.
 */
const MAX_RETRY_DELAY_MS = Number(process.env.SPOTIFY_MAX_RETRY_MS ?? 10_000);

export interface RetryHooks {
  /** test seam — replace the real sleep so 429 backoff tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run an SDK call; on a 429 wait Retry-After (capped) and retry ONCE. A persisting 429 throws
 * SpotifyError(RATE_LIMITED). Non-429 errors propagate unchanged for the intent layer to map.
 */
export async function withRateLimit<T>(
  fn: () => Promise<T>,
  hooks: RetryHooks = {},
): Promise<T> {
  const sleep = hooks.sleep ?? realSleep;
  try {
    return await fn();
  } catch (err) {
    const retryAfter = parseRetryAfter(err);
    if (retryAfter === null) throw err;
    await sleep(Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS));
    try {
      return await fn();
    } catch (err2) {
      if (parseRetryAfter(err2) !== null) {
        throw new SpotifyError(429, "RATE_LIMITED", "Spotify is rate-limiting playback requests. Try again shortly.");
      }
      throw err2;
    }
  }
}

/** Extract a Retry-After (seconds) from a 429-shaped error, else null. Tolerant of several shapes. */
export function parseRetryAfter(err: unknown): number | null {
  const status = statusOf(err);
  if (status !== 429) return null;
  const headers = (err as { headers?: Headers | Record<string, string> })?.headers;
  let ra: string | null | undefined;
  if (headers && typeof (headers as Headers).get === "function") ra = (headers as Headers).get("retry-after");
  else if (headers && typeof headers === "object") ra = (headers as Record<string, string>)["retry-after"] ?? (headers as Record<string, string>)["Retry-After"];
  const n = ra != null ? parseInt(String(ra), 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 1; // a 429 with no/garbled header → back off 1s
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof SpotifyError) return err.status;
  const e = err as { status?: number; statusCode?: number };
  return e?.status ?? e?.statusCode;
}
