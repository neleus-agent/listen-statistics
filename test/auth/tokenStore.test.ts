import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore, withExpiry, type StoredToken } from "../../src/auth/tokenStore.js";
import { PersistingAuthStrategy } from "../../src/client/spotify.js";

const sample = (over: Partial<StoredToken> = {}): StoredToken =>
  withExpiry({
    access_token: "at-1",
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: "rt-1",
    ...over,
  });

describe("TokenStore (atomic, crash-safe)", () => {
  let dir: string;
  let path: string;
  let store: TokenStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-spotify-store-"));
    path = join(dir, "spotify.json");
    store = new TokenStore(path);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a saved token", async () => {
    const t = sample();
    await store.save(t);
    const loaded = await store.load();
    expect(loaded).toEqual(t);
  });

  it("load returns null when the file is absent", async () => {
    expect(await store.load()).toBeNull();
  });

  it("load returns null on a corrupt / torn file rather than throwing", async () => {
    await writeFile(path, "{ this is not valid json", "utf8");
    expect(await store.load()).toBeNull();
  });

  it("leaves no .tmp file behind after a successful save (atomic rename)", async () => {
    await store.save(sample());
    const files = await readdir(dir);
    expect(files).toContain("spotify.json");
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("a FAILED save never clobbers the previously-saved token (no torn write)", async () => {
    // Persist a good token first.
    const original = sample({ refresh_token: "rt-original" });
    await store.save(original);
    // A save whose serialization throws (BigInt is not JSON-serialisable) fails BEFORE the rename, so
    // the atomic write (tmp -> fsync -> rename) never replaces the good file. The original must survive.
    const poisoned = { ...sample({ refresh_token: "rt-new" }), bad: 1n } as unknown as StoredToken;
    await expect(store.save(poisoned)).rejects.toThrow();
    const loaded = await store.load();
    expect(loaded?.refresh_token).toBe("rt-original"); // untouched — rename only happens on a complete tmp
    // And a subsequent good save still works (a leftover .tmp does not block it).
    await store.save(sample({ refresh_token: "rt-final" }));
    expect((await store.load())?.refresh_token).toBe("rt-final");
  });
});

describe("PersistingAuthStrategy — refresh rotation + persist-on-refresh", () => {
  let dir: string;
  let path: string;
  let store: TokenStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-spotify-rot-"));
    path = join(dir, "spotify.json");
    store = new TokenStore(path);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists the ROTATED refresh token atomically on refresh", async () => {
    // expired token forces a refresh on getOrCreateAccessToken
    await store.save(withExpiry({ access_token: "old", token_type: "Bearer", expires_in: -10, refresh_token: "rt-old" }));
    const refreshImpl = vi.fn(async () => ({ access_token: "new-at", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-rotated" }));
    const strat = new PersistingAuthStrategy("cid", store, refreshImpl as never);
    const tok = await strat.getOrCreateAccessToken();
    expect(tok.access_token).toBe("new-at");
    expect(refreshImpl).toHaveBeenCalledOnce();
    // The rotated refresh token must be on disk — the next process can use it.
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk.refresh_token).toBe("rt-rotated");
    expect(onDisk.access_token).toBe("new-at");
  });

  it("carries the old refresh token forward when Spotify omits it on refresh", async () => {
    await store.save(withExpiry({ access_token: "old", token_type: "Bearer", expires_in: -10, refresh_token: "rt-keep" }));
    const refreshImpl = vi.fn(async () => ({ access_token: "new-at", token_type: "Bearer", expires_in: 3600, refresh_token: "" }));
    const strat = new PersistingAuthStrategy("cid", store, refreshImpl as never);
    await strat.getOrCreateAccessToken();
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk.refresh_token).toBe("rt-keep");
  });

  it("does not refresh while the access token is still valid", async () => {
    await store.save(withExpiry({ access_token: "valid", token_type: "Bearer", expires_in: 3600, refresh_token: "rt" }));
    const refreshImpl = vi.fn();
    const strat = new PersistingAuthStrategy("cid", store, refreshImpl as never);
    const tok = await strat.getOrCreateAccessToken();
    expect(tok.access_token).toBe("valid");
    expect(refreshImpl).not.toHaveBeenCalled();
  });
});
