import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface AuditEntry {
  timestamp: string;
  tool: string;
  action: string;
  success: boolean;
  detail?: string;
  error?: string;
}

/**
 * Append-only JSONL audit of playback WRITES (play/pause/skip/volume/mood). Metadata only —
 * track names + device, never tokens. Files rotate monthly: YYYY-MM.jsonl.
 */
export class AuditLogger {
  constructor(private readonly basePath: string) {}

  async log(entry: Omit<AuditEntry, "timestamp">): Promise<void> {
    const now = new Date();
    const full: AuditEntry = { timestamp: now.toISOString(), ...entry };
    const fileName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}.jsonl`;
    await mkdir(this.basePath, { recursive: true });
    await appendFile(join(this.basePath, fileName), JSON.stringify(full) + "\n", "utf-8");
  }
}
