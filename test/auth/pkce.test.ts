import { describe, it, expect } from "vitest";
import { challengeFromVerifier, generateVerifier, base64url } from "../../src/auth/pkce.js";

describe("PKCE S256", () => {
  it("computes the known RFC 7636 challenge for the known verifier", () => {
    // The canonical example from RFC 7636 Appendix B.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(challengeFromVerifier(verifier)).toBe(expected);
  });

  it("produces URL-safe base64 without padding", () => {
    const v = generateVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(v).not.toContain("=");
  });

  it("base64url maps + / and strips padding", () => {
    // 0xfb 0xff 0xbf -> base64 +/+/ style bytes
    const out = base64url(Buffer.from([0xfb, 0xff, 0xbe]));
    expect(out).not.toMatch(/[+/=]/);
  });
});
