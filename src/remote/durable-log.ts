// A small durable "add / ack" log, the storage under both queues (flow 376).
//
// One JSON document per line: `{"op":"add","entry":{...}}` appends an entry,
// `{"op":"ack","id":"..."}` retires it. What is pending is the adds minus the
// acks, in insertion order. Appending is the only write on the hot path, so a
// crash leaves at most one torn trailing line, and that line damages itself
// only: the loader counts and skips any line it cannot read.
//
// A torn tail has one more consequence the loader must handle: the next append
// would be glued onto the torn bytes and lose a good entry with them. So a load
// that saw a torn tail, a corrupt line or any ack rewrites the file compacted
// (temp file + rename) before anything is appended.
//
// Durability stops at the OS: appends are not fsynced, so this survives a
// killed process, which is what the serve side must tolerate, not a power cut.

import { renameSync } from "node:fs";
import { appendOwnerOnlyLine, readTurnFile, writeOwnerOnlyFileAtomic } from "../lib/config-dir";

export interface LogEntry {
  id: string;
}

export interface DurableLogOptions<T extends LogEntry> {
  /** Absolute file path; its directory must exist. */
  file: string;
  /** Pending entries beyond this are dropped, oldest first. Default unbounded. */
  maxEntries?: number;
  /** Narrow a parsed `entry` to T; return undefined to treat the line as corrupt. */
  parse: (value: unknown) => T | undefined;
}

export interface LoadReport {
  corruptLines: number;
  /** The file existed but could not be read and was moved aside. */
  movedAside: boolean;
}

export class DurableLog<T extends LogEntry> {
  private readonly file: string;
  private readonly maxEntries: number;
  private readonly parse: (value: unknown) => T | undefined;
  private readonly entries = new Map<string, T>();
  private lineCount = 0;

  constructor(options: DurableLogOptions<T>) {
    this.file = options.file;
    this.maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
    this.parse = options.parse;
  }

  /** Read the file into memory. Safe to call once, before any add or ack. */
  load(): LoadReport {
    this.entries.clear();
    this.lineCount = 0;
    const read = readTurnFile(this.file);
    if (!read.ok) {
      if (read.reason === "absent") {
        return { corruptLines: 0, movedAside: false };
      }
      // Unreadable, oversized or not a regular file: keep the bytes for a human
      // and start empty rather than append behind something we cannot read.
      try {
        renameSync(this.file, `${this.file}.unreadable-${Date.now()}`);
      } catch {
        // Nothing more can be done; the next append will still be attempted.
      }
      return { corruptLines: 0, movedAside: true };
    }
    let corrupt = 0;
    let acks = 0;
    const lines = read.text.split("\n");
    const tornTail = read.text.length > 0 && !read.text.endsWith("\n");
    for (const line of lines) {
      if (line.length === 0) {
        continue;
      }
      let doc: unknown;
      try {
        doc = JSON.parse(line);
      } catch {
        corrupt += 1;
        continue;
      }
      if (typeof doc !== "object" || doc === null) {
        corrupt += 1;
        continue;
      }
      const record = doc as { op?: unknown; entry?: unknown; id?: unknown };
      if (record.op === "add") {
        const entry = this.parse(record.entry);
        if (entry === undefined) {
          corrupt += 1;
          continue;
        }
        this.entries.set(entry.id, entry);
      } else if (record.op === "ack" && typeof record.id === "string") {
        this.entries.delete(record.id);
        acks += 1;
      } else {
        corrupt += 1;
      }
    }
    this.enforceBound((dropped) => {
      acks += dropped.length;
    });
    this.lineCount = this.entries.size;
    if (corrupt > 0 || tornTail || acks > 0) {
      this.compact();
    }
    return { corruptLines: corrupt, movedAside: false };
  }

  pending(): T[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): T | undefined {
    return this.entries.get(id);
  }

  /** Append an entry. Returns the entries pushed out by the bound, oldest first. */
  add(entry: T): { added: boolean; dropped: T[] } {
    if (this.entries.has(entry.id)) {
      return { added: false, dropped: [] };
    }
    appendOwnerOnlyLine(this.file, JSON.stringify({ op: "add", entry }));
    this.lineCount += 1;
    this.entries.set(entry.id, entry);
    const dropped: T[] = [];
    this.enforceBound((gone) => {
      dropped.push(...gone);
    });
    for (const gone of dropped) {
      appendOwnerOnlyLine(this.file, JSON.stringify({ op: "ack", id: gone.id }));
      this.lineCount += 1;
    }
    return { added: true, dropped };
  }

  /** Retire an entry. Unknown ids are ignored. */
  ack(id: string): void {
    if (!this.entries.has(id)) {
      return;
    }
    appendOwnerOnlyLine(this.file, JSON.stringify({ op: "ack", id }));
    this.lineCount += 1;
    this.entries.delete(id);
    if (this.lineCount > this.entries.size * 2 + 200) {
      this.compact();
    }
  }

  /** Rewrite the file to hold only the pending adds. */
  compact(): void {
    const body = [...this.entries.values()].map((entry) => JSON.stringify({ op: "add", entry })).join("\n");
    writeOwnerOnlyFileAtomic(this.file, body.length === 0 ? "" : `${body}\n`);
    this.lineCount = this.entries.size;
  }

  private enforceBound(onDropped: (dropped: T[]) => void): void {
    if (this.entries.size <= this.maxEntries) {
      return;
    }
    const dropped: T[] = [];
    for (const entry of this.entries.values()) {
      if (this.entries.size - dropped.length <= this.maxEntries) {
        break;
      }
      dropped.push(entry);
    }
    for (const entry of dropped) {
      this.entries.delete(entry.id);
    }
    onDropped(dropped);
  }
}
