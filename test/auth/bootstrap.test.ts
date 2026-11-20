import { describe, it, expect, vi } from "vitest";
import { buildAuthorizeUrl, exchangeCode } from "../../src/auth/bootstrap.js";
import { challengeFromVerifier } from "../../src/auth/pkce.js";
import type { AppConfig } from "../../src/config.js";

const config: AppConfig = {
  clientId: "cid-123",
  tokenPath: "/tmp/x.json",
  auditPath: "/tmp/audit",
  callbackPort: 8888,
  redirectUri: "http://127.0.0.1:8888/callback",
};

describe("buildAuthorizeUrl", () => {
  it("builds an S256 PKCE authorize URL with the loopback redirect + scopes", () => {
    const challenge = challengeFromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    const url = new URL(buildAuthorizeUrl(config, challenge, "state-abc"));
    expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid-123");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8888/callback");
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.get("scope")).toContain("user-modify-playback-state");
  });
});

describe("exchangeCode", () => {
  it("posts the code + verifier (no secret) and returns a token with computed expiry", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: "at", token_type: "Bearer", expires_in: 3600, refresh_token: "rt" }), { status: 200 }));
    const tok = await exchangeCode(config, "the-code", "the-verifier", fetchImpl as never);
    expect(tok.access_token).toBe("at");
    expect(tok.refresh_token).toBe("rt");
    expect(tok.expires).toBeGreaterThan(Date.now());
    const body = (fetchImpl.mock.calls[0][1] as RequestInit).body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("the-verifier");
    expect(body.get("client_id")).toBe("cid-123");
    expect(body.has("client_secret")).toBe(false);
  });

  it("throws on a non-OK token response", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 400 }));
    await expect(exchangeCode(config, "c", "v", fetchImpl as never)).rejects.toThrow();
  });
});
