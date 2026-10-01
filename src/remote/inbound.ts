// Durable inbound queues and the poller's offset (flow 376, block 1).
//
// What makes delivery survive a crash between "received" and "acknowledged":
//
//   1. An update is appended to its topic's queue file BEFORE the poller confirms
//      it to Telegram (an `offset` on the next getUpdates call), which is the
//      moment Telegram forgets the update.
//   2. The ids this machine has taken are remembered ({@link PollerState}) before
//      that confirmation, so an update Telegram re-serves is recognised.
//   3. An entry leaves the queue only on `ack`, which the hub issues after the
//      consumer's `deliver` has resolved.
//
// So at every instant the update is in Telegram, on disk, or delivered; never in
// none. A restart replays unacked entries; an update Telegram resends is dropped
// by EXACT id (the pending queue, plus a bounded memory of recent ids). There is
// deliberately no high-water mark: `update_id` is not a key that stays monotonic
// for the life of a bot (Telegram can restart its numbering), and a stored mark
// would then discard every new message as a repeat. A crash AFTER `deliver`
// resolved but BEFORE the ack is written replays that entry once more, which is
// why the consumer receives the `updateId` and is expected to drop a repeat:
// delivery is at-least-once on the wire and exactly-once at the consumer.
//
// A topic's queue is bounded ({@link MAX_INBOUND_PER_TOPIC}): a session that is
// away for a long time must not let a chat grow a file without limit. The oldest
// are dropped, and the hub says so in the topic.

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

/** Unprocessed messages one topic may hold. Past it, the oldest are dropped. */
export const MAX_INBOUND_PER_TOPIC = 500;
/** How many recently taken update ids are remembered, to recognise a re-served update. */
export const RECENT_UPDATE_IDS = 1000;

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
      log = new DurableLog<InboundEntry>({ file: this.fileFor(bindingKey), parse: parseEntry, maxEntries: MAX_INBOUND_PER_TOPIC });
      log.load();
      this.logs.set(bindingKey, log);
    }
    return log;
  }

  /** Append; `added` is false when this update was already queued under the binding. `dropped` counts the oldest pushed out by the cap. */
  append(bindingKey: string, entry: InboundEntry): { added: boolean; dropped: number } {
    const result = this.log(bindingKey).add(entry);
    return { added: result.added, dropped: result.dropped.length };
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

/**
 * The update ids this machine has already taken, bounded and persisted.
 *
 * What Telegram re-serves (a crash between taking a batch and confirming it, a
 * restart) is recognised by EXACT id. Nothing here is an offset: the poller sends
 * none until it has a batch to confirm, so a Telegram whose numbering restarted
 * is never mistaken for a quiet one.
 */
export class PollerState {
  private readonly file: string;
  private readonly ids = new Set<number>();
  private top = 0;

  constructor(options: { dir?: string }) {
    this.file = path.join(ensureRemoteDir(options.dir), POLLER_STATE_FILE);
  }

  load(): void {
    this.ids.clear();
    this.top = 0;
    const read = readConfigFile(this.file);
    if (!read.ok) {
      return;
    }
    try {
      const doc = JSON.parse(read.text) as { recent?: unknown; highWater?: unknown };
      if (Array.isArray(doc.recent)) {
        for (const id of doc.recent) {
          if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) {
            this.add(id);
          }
        }
      } else if (typeof doc.highWater === "number" && Number.isSafeInteger(doc.highWater) && doc.highWater > 0) {
        // The state of an older build: its mark is one id we certainly took.
        this.add(doc.highWater);
      }
    } catch {
      // A damaged file is recoverable: the pending queues still dedupe, and Telegram
      // only re-serves what it was never told we hold.
      this.ids.clear();
      this.top = 0;
    }
  }

  /** Whether this exact id was already taken. */
  seen(updateId: number): boolean {
    return this.ids.has(updateId);
  }

  /** The highest id remembered; 0 when none. */
  get highest(): number {
    return this.top;
  }

  /** Remember these ids (oldest forgotten past the bound) and persist. */
  record(updateIds: number[]): void {
    if (updateIds.length === 0) {
      return;
    }
    for (const id of updateIds) {
      this.add(id);
    }
    this.persist();
  }

  /** Forget everything: the numbering restarted, so old ids say nothing about new ones. */
  reset(): void {
    this.ids.clear();
    this.top = 0;
    this.persist();
  }

  private add(updateId: number): void {
    this.ids.delete(updateId);
    this.ids.add(updateId);
    this.top = Math.max(this.top, updateId);
    while (this.ids.size > RECENT_UPDATE_IDS) {
      const oldest = this.ids.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.ids.delete(oldest);
    }
  }

  private persist(): void {
    writeOwnerOnlyFileAtomic(this.file, `${JSON.stringify({ version: 2, recent: [...this.ids] })}\n`);
  }
}
