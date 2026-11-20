import { describe, it, expect } from "vitest";
import { resolveMood, moodKeys } from "../src/moods.js";

describe("resolveMood", () => {
  it("resolves a direct mood key to a seed with a context + query", () => {
    const seed = resolveMood("focus");
    expect(seed?.contextUri).toMatch(/^spotify:playlist:/);
    expect(seed?.query).toBeTruthy();
  });
  it("is case-insensitive and trims", () => {
    expect(resolveMood("  CHILL ")?.query).toBe(resolveMood("chill")?.query);
  });
  it("resolves an alias (relaxed -> chill)", () => {
    expect(resolveMood("relaxed")).toEqual(resolveMood("chill"));
  });
  it("returns null on a total miss", () => {
    expect(resolveMood("asdf-not-a-mood-xyz")).toBeNull();
    expect(resolveMood("")).toBeNull();
  });
  it("exposes the curated keys", () => {
    expect(moodKeys().length).toBeGreaterThan(5);
  });
});
