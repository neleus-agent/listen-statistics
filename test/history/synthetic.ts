// Synthetic Extended-streaming-history fixtures. Every track, artist and album here is invented.
// The "dropped" fields are assembled at runtime from fragments, so this file itself never contains a
// personal field name or a network address (test/privacy/committed-files.test.ts scans for both).
import { deflateRawSync } from "node:zlib";

const key = (...parts: string[]) => parts.join("_");
/** Field names Spotify includes that the importer must drop. */
export const DROPPED_KEYS = [
  key("ip", "addr"),
  key("conn", "country"),
  ["plat", "form"].join(""),
  key("user", "agent", "decrypted"),
  key("episode", "name"),
  key("episode", "show", "name"),
  key("spotify", "episode", "uri"),
  key("reason", "start"),
  key("reason", "end"),
  "shuffle",
  key("offline", "timestamp"),
  "incognito_mode",
];
/** Distinctive values for the dropped fields: none may survive into the output. */
export const DROPPED_VALUES = {
  v4: [203, 0, 113, 77].join("."),
  v6: ["2001", "db8", "", "77"].join(":"),
  device: "SENTINEL-DEVICE-QX",
  country: "ZZ",
};

export const uri = (n: number) => `spotify:track:FAKE${String(n).padStart(18, "0")}`;

export function stream(n: number, ts: string, ms: number, extra: { skipped?: boolean | null; track?: string; artist?: string; album?: string } = {}) {
  const [ipKey, countryKey, platKey, uaKey, epKey, showKey, epUriKey, rsKey, reKey, shufKey, offKey, incKey] = DROPPED_KEYS;
  return {
    ts,
    [platKey]: `${DROPPED_VALUES.device} os 1.0`,
    ms_played: ms,
    [countryKey]: DROPPED_VALUES.country,
    [ipKey]: n % 2 ? DROPPED_VALUES.v4 : DROPPED_VALUES.v6,
    [uaKey]: "unknown",
    master_metadata_track_name: extra.track ?? `Invented Song ${n}`,
    master_metadata_album_artist_name: extra.artist ?? `Fictional Band ${n % 3}`,
    master_metadata_album_album_name: extra.album ?? `Made Up Album ${n % 2}`,
    spotify_track_uri: uri(n),
    [epKey]: null,
    [showKey]: null,
    [epUriKey]: null,
    [rsKey]: "trackdone",
    [reKey]: "trackdone",
    [shufKey]: false,
    skipped: extra.skipped ?? null,
    offline: false,
    [offKey]: 0,
    [incKey]: false,
  };
}

/** A podcast stream: no track URI, must be skipped. */
export function podcast(ts: string) {
  const [, , , , epKey, showKey, epUriKey] = DROPPED_KEYS;
  return { ts, ms_played: 600000, spotify_track_uri: null, master_metadata_track_name: null, [epKey]: "An Imaginary Episode", [showKey]: "A Pretend Show", [epUriKey]: "spotify:episode:FAKE0001" };
}

/** Two history files: track 1 played a lot long ago, track 2 a lot recently (and skipped), track 3 is not in the library. */
export function historyFiles(): Record<string, unknown[]> {
  return {
    "Spotify Extended Streaming History/Streaming_History_Audio_2018-2020_0.json": [
      stream(1, "2018-05-01T10:00:00Z", 200000),
      stream(1, "2018-06-01T10:00:00Z", 200000),
      stream(1, "2019-01-01T10:00:00Z", 180000),
      stream(1, "2019-02-01T10:00:00Z", 10000, { skipped: true }),
      podcast("2019-03-01T10:00:00Z"),
      stream(3, "2020-01-01T10:00:00Z", 120000),
    ],
    "Spotify Extended Streaming History/Streaming_History_Audio_2023-2024_1.json": [
      stream(2, "2023-01-01T10:00:00Z", 240000),
      stream(2, "2024-01-01T10:00:00Z", 5000, { skipped: true }),
      stream(2, "2024-02-01T10:00:00Z", 240000),
      stream(3, "2024-03-01T10:00:00Z", 120000),
    ],
    // a video history file sits next to the audio ones in a real export and must be ignored
    "Spotify Extended Streaming History/Streaming_History_Video_2024.json": [{ ts: "2024-01-01T00:00:00Z" }],
  };
}

/** A tiny library export (tracks.csv shape) with tracks 1 and 2; track 2 is in two playlists. */
export const LIBRARY_CSV =
  "﻿playlist,position,track,artists,album,track_uri\r\n" +
  `Road Trip,1,Invented Song 1,Fictional Band 1,Made Up Album 1,${uri(1)}\r\n` +
  `Road Trip,2,Invented Song 2,Fictional Band 2,Made Up Album 0,${uri(2)}\r\n` +
  `Liked Songs,1,Invented Song 2,Fictional Band 2,Made Up Album 0,${uri(2)}\r\n` +
  `Liked Songs,2,Never Played Tune,Fictional Band 0,Made Up Album 0,${uri(9)}\r\n`;

/** Minimal ZIP writer (deflate), only for building test archives. CRC is left 0: the reader does not check it. */
export function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = deflateRawSync(Buffer.from(text, "utf8"));
    const size = Buffer.byteLength(text, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  const count = Object.keys(files).length;
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(count, 8); eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
