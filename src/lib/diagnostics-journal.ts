/** Bounded synchronous evidence, with no in-memory write queue. */
import { lstatSync, renameSync } from "node:fs";
import path from "node:path";
import { appendPrivateRecord, ensureKeryxSubdir, keryxConfigDir } from "./config-dir";

export type JournalResult = { ok: true } | { ok: false; error: string };
export interface DiagnosticsJournal { path(): string; write(row: unknown): JournalResult }
export function createDiagnosticsJournal(opts: {
  sessionId: string; configDir?: string | undefined; maxFileBytes?: number | undefined;
}): DiagnosticsJournal {
  const name = opts.sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "session";
  const file = path.join(keryxConfigDir(opts.configDir), "diagnostics", `${name}.events.ndjson`);
  const cap = opts.maxFileBytes ?? 1_000_000;
  return {
    path: () => file,
    write(row) {
      try {
        const line = JSON.stringify(row);
        if (line === undefined || Buffer.byteLength(line) + 1 > cap) return { ok: false, error: "ROW_TOO_LARGE" };
        ensureKeryxSubdir(["diagnostics"], opts.configDir);
        let size = 0;
        try {
          const info = lstatSync(file);
          if (!info.isFile() || info.nlink !== 1) return { ok: false, error: "UNSAFE_FILE" };
          size = info.size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (size + Buffer.byteLength(line) + 1 > cap) renameSync(file, `${file}.1`);
        appendPrivateRecord(file, line);
        return { ok: true };
      } catch (error) {
        // Never expose raw filesystem errors, which can contain arbitrary paths/content.
        const code = (error as NodeJS.ErrnoException)?.code;
        return { ok: false, error: typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "JOURNAL_WRITE_FAILED" };
      }
    },
  };
}

/** Only numeric/boolean measurements, never UI text or error messages. */
export function diagnosticMeasurements(input: Record<string, unknown>): Record<string, number | boolean> {
  return Object.fromEntries(Object.entries(input).filter(([key, value]) =>
    /^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(key) &&
    (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))),
  )) as Record<string, number | boolean>;
}
