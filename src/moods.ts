/**
 * Small curated mood -> seed map (MVP). A hit gives a Spotify URI (a public editorial playlist) to play as
 * context; a miss falls back to a free-text search query (C6 -> C1). Keep this short + obvious — it is a
 * convenience layer, not a recommendation engine.
 *
 * Playlist URIs are well-known Spotify-owned editorial playlists. If one is unavailable in a market the
 * intent layer degrades to the search query.
 */
export interface MoodSeed {
  /** spotify:playlist:... context to play, when we have a good editorial match. */
  contextUri?: string;
  /** fallback free-text search query (always present, so a miss still resolves). */
  query: string;
}

const MOODS: Record<string, MoodSeed> = {
  focus: { contextUri: "spotify:playlist:37i9dQZF1DWZeKCadgRdKQ", query: "deep focus instrumental" },
  chill: { contextUri: "spotify:playlist:37i9dQZF1DX4WYpdgoIcn6", query: "chill relaxing" },
  energetic: { contextUri: "spotify:playlist:37i9dQZF1DX76Wlfdnj7AP", query: "upbeat energetic workout" },
  happy: { contextUri: "spotify:playlist:37i9dQZF1DXdPec7aLTmlC", query: "happy feel good" },
  sad: { contextUri: "spotify:playlist:37i9dQZF1DX7qK8ma5wgG1", query: "sad melancholy" },
  calm: { contextUri: "spotify:playlist:37i9dQZF1DWZqd5JICZI0u", query: "calm peaceful piano" },
  party: { contextUri: "spotify:playlist:37i9dQZF1DXaXB8fQg7xif", query: "party dance hits" },
  sleep: { contextUri: "spotify:playlist:37i9dQZF1DWZd79rJ6a7lp", query: "sleep ambient" },
  jazz: { contextUri: "spotify:playlist:37i9dQZF1DXbITWG1ZJKYt", query: "jazz classics" },
  coding: { contextUri: "spotify:playlist:37i9dQZF1DX5trt9i14X7j", query: "coding lo-fi beats" },
};

/** Normalise + resolve a mood word to a seed. Returns null on a miss (caller falls back to search). */
export function resolveMood(mood: string): MoodSeed | null {
  const key = String(mood ?? "").trim().toLowerCase();
  if (!key) return null;
  if (MOODS[key]) return MOODS[key];
  // light alias matching so "relaxed" -> chill, "study" -> focus, etc.
  for (const [name, seed] of Object.entries(MOODS)) {
    if (key.includes(name) || name.includes(key)) return seed;
  }
  const ALIASES: Record<string, string> = {
    relaxed: "chill", relax: "chill", study: "focus", concentrate: "focus",
    workout: "energetic", gym: "energetic", run: "energetic", upbeat: "happy",
    melancholy: "sad", peaceful: "calm", code: "coding", program: "coding",
  };
  const alias = ALIASES[key];
  return alias ? MOODS[alias] : null;
}

/** Exposed for tests / introspection. */
export const moodKeys = (): string[] => Object.keys(MOODS);
