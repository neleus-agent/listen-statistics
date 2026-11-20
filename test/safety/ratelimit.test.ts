import { describe, it, expect, vi } from "vitest";
import { withRateLimit, parseRetryAfter } from "../../src/safety/ratelimit.js";
import { SpotifyError } from "../../src/client/error.js";

const make429 = (retryAfter?: string) => {
  const headers = new Headers();
  if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
  const err = new SpotifyError(429, "RATE_LIMITED", "429") as SpotifyError & { headers: Headers };
  err.headers = headers;
  return err;
};

describe("withRateLimit — 429 Retry-After backoff", () => {
  it("retries once after honouring Retry-After, then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn()
      .mockRejectedValueOnce(make429("2"))
      .mockResolvedValueOnce("ok");
    const out = await withRateLimit(fn as never, { sleep });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("throws RATE_LIMITED when the 429 persists after the retry", async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn().mockRejectedValue(make429("1"));
    await expect(withRateLimit(fn as never, { sleep })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-429 errors", async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn().mockRejectedValue(new SpotifyError(403, "PREMIUM_REQUIRED", "nope"));
    await expect(withRateLimit(fn as never, { sleep })).rejects.toMatchObject({ status: 403 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("parseRetryAfter defaults to 1s on a 429 with no header, null on non-429", () => {
    expect(parseRetryAfter(make429())).toBe(1);
    expect(parseRetryAfter(new SpotifyError(500, "UNKNOWN", "x"))).toBeNull();
  });
});
