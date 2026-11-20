import type { IntentResult } from "../intents/playback.js";
import type { AuditLogger } from "../safety/audit.js";

/** Wrap an IntentResult as an MCP text content block (JSON). */
export function toContent(result: IntentResult) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

/** Audit a playback write (metadata only). Never throws into the tool path. */
export async function auditResult(
  audit: AuditLogger,
  tool: string,
  action: string,
  result: IntentResult,
  detail?: string,
): Promise<void> {
  try {
    await audit.log({
      tool,
      action,
      success: result.ok,
      detail,
      error: result.ok ? undefined : result.error,
    });
  } catch {
    /* audit is best-effort */
  }
}
