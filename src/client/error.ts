/** Normalised error codes the intent layer maps to {ok:false,error,message}. */
export type SpotifyErrorCode =
  | "NO_ACTIVE_DEVICE"
  | "NO_MATCHING_DEVICE"
  | "PREMIUM_REQUIRED"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "NOT_AUTHENTICATED"
  | "INSUFFICIENT_SCOPE"
  | "FORBIDDEN"
  | "UNKNOWN";

export class SpotifyError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: SpotifyErrorCode | string,
    message: string,
  ) {
    super(message);
    this.name = "SpotifyError";
  }
}

/**
 * Map a raw error (SDK / our SpotifyError) to a normalised {code,message}. The SDK throws Error with a
 * message that embeds the HTTP status + body, so we sniff both an explicit status and the message text.
 */
export function mapError(err: unknown): { code: SpotifyErrorCode; message: string } {
  if (err instanceof SpotifyError && isKnown(err.code)) {
    return { code: err.code, message: err.message };
  }
  const status = statusOf(err);
  const msg = (err as Error)?.message ?? String(err);
  if (status === 401 || /unauthor|invalid.*token|no token/i.test(msg)) {
    return { code: "NOT_AUTHENTICATED", message: "Not authenticated. Run: node dist/index.js auth" };
  }
  if (status === 403 || /premium/i.test(msg)) {
    return { code: "PREMIUM_REQUIRED", message: "This action requires Spotify Premium." };
  }
  if (status === 429 || /rate.?limit/i.test(msg)) {
    return { code: "RATE_LIMITED", message: "Spotify is rate-limiting requests. Try again shortly." };
  }
  if (status === 404 || /not.?found|no active device/i.test(msg)) {
    return { code: "NOT_FOUND", message: msg || "Not found." };
  }
  return { code: "UNKNOWN", message: msg || "Unknown playback error." };
}

function isKnown(code: string): code is SpotifyErrorCode {
  return [
    "NO_ACTIVE_DEVICE",
    "NO_MATCHING_DEVICE",
    "PREMIUM_REQUIRED",
    "RATE_LIMITED",
    "NOT_FOUND",
    "NOT_AUTHENTICATED",
    "INSUFFICIENT_SCOPE",
    "FORBIDDEN",
    "UNKNOWN",
  ].includes(code);
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof SpotifyError) return err.status;
  const e = err as { status?: number; statusCode?: number };
  return e?.status ?? e?.statusCode;
}
