import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Persisted token shape. Mirrors @spotify/web-api-ts-sdk AccessToken plus the absolute
 * expiry we compute, so a restart can tell whether the access token is still valid.
 */
export interface StoredToken {
  access_token: string;
  token_type: string;
  /** seconds the access token is valid for (as returned by Spotify). */
  expires_in: number;
  /** rotating refresh token — Spotify rotates this on (most) refreshes; persisting it is critical. */
  refresh_token: string;
  /** absolute epoch-ms expiry, computed at save time. */
  expires: number;
  scope?: string;
}

/**
 * Crash-safe token store. The rotating refresh token is the ONLY way back in without re-consent,
 * so every save is atomic: write to `${path}.tmp`, fsync the file, then rename over the target
 * (rename is atomic on the same filesystem). A torn write would be permanent lockout.
 */
export class TokenStore {
  constructor(private readonly path: string) {}

  /** Load the persisted token, or null if absent/corrupt (never throws on a missing file). */
  async load(): Promise<StoredToken | null> {
    try {
      const raw = await readFile(this.path, "utf8");
      const t = JSON.parse(raw) as StoredToken;
      if (!t || typeof t.refresh_token !== "string" || !t.refresh_token) return null;
      return t;
    } catch {
      return null;
    }
  }

  /**
   * Atomically persist the token. Order: mkdir -> write tmp -> fsync(tmp) -> rename -> (best-effort) cleanup.
   * On any failure the original file is left intact (rename never half-applies).
   */
  async save(token: StoredToken): Promise<void> {
    // 0o700 dir / 0o600 file: the rotating refresh token is owner-only on POSIX (no-op on Windows).
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    const body = JSON.stringify(token, null, 2);
    const fh = await open(tmp, "w", 0o600);
    try {
      await fh.writeFile(body, "utf8");
      await fh.sync(); // fsync — durability before the rename
    } finally {
      await fh.close();
    }
    await rename(tmp, this.path); // atomic replace on same filesystem
    // Best-effort: tighten perms on the live file (chmod is a near-noop on Windows).
    // Must never throw the save path — the token is already safely persisted.
    try {
      await chmod(this.path, 0o600);
    } catch {
      /* perms are best-effort; the atomic write already succeeded */
    }
  }

  /** Remove the persisted token (auth clear). Best-effort. */
  async clear(): Promise<void> {
    try {
      await unlink(this.path);
    } catch {
      /* already gone */
    }
  }

  get filePath(): string {
    return this.path;
  }
}

/** Compute absolute expiry (epoch ms) from a Spotify expires_in (seconds). */
export function withExpiry(
  partial: Omit<StoredToken, "expires">,
  now: number = Date.now(),
): StoredToken {
  return { ...partial, expires: now + partial.expires_in * 1000 };
}
