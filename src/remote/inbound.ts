// Durable inbound queues and the poller's offset (flow 376, block 1).
//
// What makes delivery survive a crash between "received" and "acknowledged":
//
//   1. An update is appended to its topic's queue file BEFORE `highWater`
//      (the poller's confirmed offset) moves past it.
//   2. `highWater` is persisted before the next getUpdates call carries it as
//      `offset`, which is the moment Telegram forgets the update.
//   3. An entry leaves the queue only on `ack`, which the hub issues after the
//      consumer's `deliver` has resolved.
//
// So at every instant the update is in Telegram, on disk, or delivered; never in
// none. A restart replays unacked entries; updates at or below `highWater` that
// Telegram might resend are discarded by id. A crash AFTER `deliver` resolved
// but BEFORE the ack is written replays that entry once more, which is why the
// consumer receives the `updateId` and is expected to drop a repeat: delivery is
// at-least-once on the wire and exactly-once at the consumer.

import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import path from "node:path";
import { readConfigFile, writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { DurableLog } from "./durable-log";
import { ensureRemoteDir, INBOUND_DIRNAME, POLLER_STATE_FILE } from "./paths";

export interface InboundEntry {
  /** `u<update_id>`. */
  id: string;
  updateId: number;
  kind: "text" | "callback";
  fromId: number;
  receivedAt: number;
  /** The user's line, for `kind: "text"`. */
  text?: string;
  /** The pressed button, for `kind: "callback"`. */
  callback?: { id: string; data: string; messageId?: number };
}

function parseEntry(value: unknown): InboundEntry | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    typeof raw.updateId !== "number" ||
    typeof raw.fromId !== "number" ||
    typeof raw.receivedAt !== "number"
  ) {
    return undefined;
  }
  if (raw.kind === "text") {
    return typeof raw.text === "string" ? (raw as unknown as InboundEntry) : undefined;
  }
  if (raw.kind === "callback") {
    const callback = raw.callback as Record<string, unknown> | undefined;
    return typeof callback?.id === "string" && typeof callback.data === "string"
      ? (raw as unknown as InboundEntry)
      : undefined;
  }
  return undefined;
}

export function inboundEntryId(updateId: number): string {
  return `u${updateId}`;
}

/** One queue file per topic binding, loaded lazily and cached. */
export class InboundQueues {
  private readonly dir: string | undefined;
  private readonly directory: string;
  private readonly logs = new Map<string, DurableLog<InboundEntry>>();

  constructor(options: { dir?: string }) {
    this.dir = options.dir;
    this.directory = ensureRemoteDir(this.dir, INBOUND_DIRNAME);
  }

  private fileFor(bindingKey: string): string {
    const name = createHash("sha256").update(bindingKey).digest("hex").slice(0, 32);
    return path.join(this.directory, `${name}.jsonl`);
  }

  private log(bindingKey: string): DurableLog<InboundEntry> {
    let log = this.logs.get(bindingKey);
    if (log === undefined) {
      log = new DurableLog<InboundEntry>({ file: this.fileFor(bindingKey), parse: parseEntry });
      log.load();
      this.logs.set(bindingKey, log);
    }
    return log;
  }

  /** Append; false when this update was already queued under the binding. */
  append(bindingKey: string, entry: InboundEntry): boolean {
    return this.log(bindingKey).add(entry).added;
  }

  has(bindingKey: string, updateId: number): boolean {
    return this.log(bindingKey).has(inboundEntryId(updateId));
  }

  pending(bindingKey: string): InboundEntry[] {
    return this.log(bindingKey).pending();
  }

  ack(bindingKey: string, id: string): void {
    this.log(bindingKey).ack(id);
  }

  /** Drop a binding's whole queue, file included. */
  remove(bindingKey: string): void {
    this.logs.delete(bindingKey);
    try {
      unlinkSync(this.fileFor(bindingKey));
    } catch {
      // No queue file was ever written for this binding.
    }
  }
}

/** The highest update id already persisted: the poller's confirmed offset. */
export class PollerState {
  private readonly file: string;
  private mark = 0;

  constructor(options: { dir?: string }) {
    this.file = path.join(ensureRemoteDir(options.dir), POLLER_STATE_FILE);
  }

  load(): number {
    const read = readConfigFile(this.file);
    if (read.ok) {
      try {
        const doc = JSON.parse(read.text) as { highWater?: unknown };
        if (typeof doc.highWater === "number" && Number.isSafeInteger(doc.highWater) && doc.highWater >= 0) {
          this.mark = doc.highWater;
        }
      } catch {
        // A damaged offset file is recoverable: dedupe by queue content still holds.
      }
    }
    return this.mark;
  }

  get highWater(): number {
    return this.mark;
  }

  advance(updateId: number): void {
    if (updateId <= this.mark) {
      return;
    }
    this.mark = updateId;
    writeOwnerOnlyFileAtomic(this.file, `${JSON.stringify({ version: 1, highWater: this.mark })}\n`);
  }
}
