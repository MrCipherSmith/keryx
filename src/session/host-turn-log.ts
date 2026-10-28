import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalDigest, LIMITS } from "../remote-control/protocol";
import { redactSensitiveText } from "../security/service";

export function utf8Bounded(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  return bytes.length <= maxBytes ? text : new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true });
}

/** Retained local progress is bounded independently of critical execution evidence.
 * The live observer still receives all observations; its durable machine outbox has its own quota. */
export function createTurnObservationLog(sessionDir: string, runId: string, maxBytes: number = LIMITS.runLogBytes) {
  const dir = join(sessionDir, "remote-turns"); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = canonicalDigest(runId); const progressPath = join(dir, `${key}.progress.jsonl`); const evidencePath = join(dir, `${key}.evidence.jsonl`);
  if (!existsSync(progressPath)) writeFileSync(progressPath, "", { mode: 0o600 });
  let bytes = statSync(progressPath).size; let truncated = false;
  const marker = `${JSON.stringify({ kind: "retention", reason: "native-log-retention-truncated" })}\n`;
  const reserve = Buffer.byteLength(marker);
  return { progressPath, evidencePath,
    append<T extends { kind: string }>(value: T) {
      const line = `${redactSensitiveText(JSON.stringify(value))}\n`;
      if (value.kind !== "progress") { appendFileSync(evidencePath, line, { mode: 0o600 }); return; }
      const size = Buffer.byteLength(line);
      if (!truncated && bytes + size <= Math.max(0, maxBytes - reserve)) { appendFileSync(progressPath, line); bytes += size; }
      else if (!truncated) { truncated = true; if (bytes + reserve <= maxBytes) { appendFileSync(progressPath, marker); bytes += reserve; } }
    },
  };
}
