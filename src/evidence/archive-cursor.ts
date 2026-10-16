import { createHash } from "node:crypto";
import { decodeSessionTextRecord } from "../session/store";
import { canAppendArchive, createArchiveCheckpoint, type ArchiveCheckpoint } from "./archive-checkpoint";

type RawRecord = Readonly<{ text: string; role: string; timestamp: string | null;
  recordId: string; startByte: number; endByte: number }>;
type Entry = { checkpoint: Readonly<ArchiveCheckpoint>; rows: number;
  records: readonly RawRecord[]; cost: number };
/** Owner-private, bounded, volatile raw projections. NEVER cache scanner decisions. */
export class ArchiveCursor {
  private entries = new Map<string, Entry>();
  private retained = 0;
  private revision = 0;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly maxBytes = 1024 * 1024, private readonly maxEntries = 8) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024 ||
        !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 64) throw Error("invalid archive cursor budget");
  }
  clear() {
    this.entries.clear(); this.retained = 0; this.revision++;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
  }
  prepare(key: string, bytes: Buffer, identity: { dev: number; ino: number },
    maxRecords: number, check: () => void) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100000) throw Error("archive record budget exceeded");
    check();
    const revision = this.revision;
    const candidate = this.entries.get(key);
    const prior = candidate && canAppendArchive(bytes, identity, candidate.checkpoint) ? candidate : undefined;
    let rows = prior?.rows ?? 0, start = prior?.checkpoint.completeBytes ?? 0;
    if (rows > maxRecords) throw Error("archive record budget exceeded");
    const records: RawRecord[] = prior ? [...prior.records] : [];
    let parsedRows = 0;
    for (let end = start; end < bytes.length; end++) {
      if (bytes[end] !== 10) continue;
      check();
      if (++rows > maxRecords) throw Error("archive record budget exceeded");
      const rowStart = start, rowBytes = bytes.subarray(start, end); start = end + 1; parsedRows++;
      let row;
      try { row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rowBytes)); } catch { continue; }
      const projected = decodeSessionTextRecord(row);
      if (!projected) continue;
      records.push(Object.freeze({ ...projected, recordId: `${rowStart}:${createHash("sha256").update(rowBytes).digest("hex")}`,
        startByte: rowStart, endByte: end + 1 }));
    }
    check();
    const frozen = Object.freeze(records);
    const checkpoint = createArchiveCheckpoint(bytes, identity);
    const cost = Buffer.byteLength(key) + 256 + records.reduce((sum, row) => sum +
      Buffer.byteLength(row.text) + Buffer.byteLength(row.role) + Buffer.byteLength(row.timestamp ?? "") + 256, 0);
    let committed = false;
    return Object.freeze({ records: frozen, parsedRows, reusedRows: prior?.rows ?? 0,
      // Owner calls only AFTER scanning, source stability, cancellation and lifecycle checks.
      commit: (guard: () => void) => {
        check(); guard();
        if (committed || revision !== this.revision) return false;
        committed = true; this.revision++;
        const old = this.entries.get(key);
        if (old) { this.retained -= old.cost; this.entries.delete(key); }
        if (cost > this.maxBytes) return false;
        while (this.entries.size >= this.maxEntries || this.retained + cost > this.maxBytes) {
          const first = this.entries.entries().next().value;
          if (!first) break;
          this.retained -= first[1].cost; this.entries.delete(first[0]);
        }
        this.entries.set(key, { checkpoint, rows, records: frozen, cost }); this.retained += cost;
        // Fixed maximum lifetime: active use must not keep older raw text alive.
        if (!this.expiry) {
          this.expiry = setTimeout(() => this.clear(), 30000);
          this.expiry.unref();
        }
        return true;
      },
    });
  }
}

/** Capability supplied by a trusted runtime collection lease, never tool/config input. */
export interface ArchiveCursorAccess { cursor: ArchiveCursor; checkpoint: () => void }
