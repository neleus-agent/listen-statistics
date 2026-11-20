/** RFC 4180 CSV: quote a field when it holds the delimiter, a quote, or a line break; double inner quotes. */
export function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header + rows as CSV text with CRLF line ends and a UTF-8 BOM (so Excel reads accents correctly). */
export function toCsv(headers: readonly string[], rows: Record<string, unknown>[]): string {
  const lines = [headers.map(csvField).join(",")];
  for (const r of rows) lines.push(headers.map((h) => csvField(r[h])).join(","));
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

/** Parse RFC 4180 CSV (quoted fields, doubled quotes, CRLF or LF, optional BOM) into header-keyed rows. */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const s = text.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let field = "";
  let rec: string[] = [];
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { rec.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      rec.push(field); records.push(rec); rec = []; field = "";
    } else field += c;
  }
  if (field !== "" || rec.length) { rec.push(field); records.push(rec); }
  const [headers = [], ...body] = records.filter((r) => !(r.length === 1 && r[0] === ""));
  return { headers, rows: body.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))) };
}
