import { inflateRawSync } from "node:zlib";

/**
 * Minimal in-memory ZIP reader: enough for Spotify's `my_spotify_data.zip` (stored or deflated entries,
 * no encryption). Entries are read into memory only; nothing is extracted to disk.
 * ponytail: no ZIP64 (archives or entries over 4 GB). Spotify's export is far smaller; if one ever is
 * bigger, the error says to unzip it and pass the folder instead.
 */
export function readZipEntries(buf: Buffer, want: (name: string) => boolean): { name: string; data: Buffer }[] {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error("ZIP64 archive: unzip it first and pass the folder");
  const out: { name: string; data: Buffer }[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    if (compSize === 0xffffffff || local === 0xffffffff) throw new Error("ZIP64 entry: unzip it first and pass the folder");
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt zip local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    if (method === 0) out.push({ name, data: Buffer.from(raw) });
    else if (method === 8) out.push({ name, data: inflateRawSync(raw) });
    else throw new Error(`unsupported zip compression method ${method} for ${name}: unzip it first and pass the folder`);
  }
  return out;
}
