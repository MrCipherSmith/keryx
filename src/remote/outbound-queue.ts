// The durable outbound queue to the Bot API (flow 376, block 1).
//
// Every message bound for Telegram is written to disk first and sent second, so
// "serve was down" and "Telegram refused for a minute" are the same case: the
// entry stays queued and goes out on the next flush, including after a restart.
//
//   - Bounded at 200 entries; the oldest is dropped first and reported.
//   - A 429 pauses the whole queue until `retry_after` has passed.
//   - A network error or 5xx keeps the entry and stops the flush (retry later).
//   - Any other 4xx (the topic is gone, the bot was kicked) will never succeed:
//     the entry is dropped and reported rather than blocking the queue forever.
//
// Text is stored as the plain Markdown-ish text `formatReply` produced and rendered
// to Telegram HTML only when it is sent (`sendHtml`). If Telegram refuses the markup
// (400 "can't parse entities") that one part is resent once as plain text and
// `onFallback` records it; a restart never sees stale HTML on disk.
//
// A crash between a successful send and its ack resends that one message on the
// next start. Telegram offers no idempotency key, so outbound is at-least-once.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { redactSensitiveText } from "../security/service";
import { DurableLog, type LoadReport } from "./durable-log";
import { ensureRemoteDir, OUTBOUND_FILE } from "./paths";
import { formatReply } from "./format";
import { sendHtml } from "./format-html";
import { type BotApi, type InlineKeyboard, isBotApiError, isRetryable } from "./types";

export const OUTBOUND_MAX_ENTRIES = 200;

export interface OutboundEntry {
  id: string;
  chatId: number;
  threadId?: number;
  text: string;
  keyboard?: InlineKeyboard;
  createdAt: number;
}

export interface OutboundMessage {
  chatId: number;
  threadId?: number;
  text: string;
  keyboard?: InlineKeyboard;
}

export interface FlushResult {
  sent: number;
  dropped: number;
  remaining: number;
  /** Set when entries remain and a retry is worthwhile: wait this long. */
  retryInMs?: number;
  /** Redacted description of the failure that stopped the flush, if any. */
  stoppedBy?: string;
}

export interface OutboundQueueOptions {
  api: BotApi;
  dir?: string;
  now: () => number;
  maxEntries?: number;
  /** Called for an entry that was discarded: bound overflow or a permanent refusal. */
  onDrop?: (entry: OutboundEntry, reason: string) => void;
  /** Called when Telegram refused the HTML of an entry and it was resent as plain text. */
  onFallback?: (entry: OutboundEntry) => void;
  /** Default retry delay for a network or server error. */
  retryDelayMs?: number;
}

function parseEntry(value: unknown): OutboundEntry | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    typeof raw.chatId !== "number" ||
    typeof raw.text !== "string" ||
    typeof raw.createdAt !== "number"
  ) {
    return undefined;
  }
  if (raw.threadId !== undefined && typeof raw.threadId !== "number") {
    return undefined;
  }
  if (raw.keyboard !== undefined && !Array.isArray(raw.keyboard)) {
    return undefined;
  }
  return raw as unknown as OutboundEntry;
}

export class OutboundQueue {
  private readonly api: BotApi;
  private readonly now: () => number;
  private readonly log: DurableLog<OutboundEntry>;
  private readonly onDrop: (entry: OutboundEntry, reason: string) => void;
  private readonly onFallback: (entry: OutboundEntry) => void;
  private readonly retryDelayMs: number;
  private blockedUntil = 0;
  private flushing: Promise<FlushResult> | undefined;

  constructor(options: OutboundQueueOptions) {
    this.api = options.api;
    this.now = options.now;
    this.onDrop = options.onDrop ?? (() => undefined);
    this.onFallback = options.onFallback ?? (() => undefined);
    this.retryDelayMs = options.retryDelayMs ?? 5_000;
    const directory = ensureRemoteDir(options.dir);
    this.log = new DurableLog<OutboundEntry>({
      file: path.join(directory, OUTBOUND_FILE),
      maxEntries: options.maxEntries ?? OUTBOUND_MAX_ENTRIES,
      parse: parseEntry,
    });
  }

  load(): LoadReport {
    return this.log.load();
  }

  get size(): number {
    return this.log.size;
  }

  pending(): OutboundEntry[] {
    return this.log.pending();
  }

  /**
   * Write to disk, then return. Sending is `flush()`'s job. The text goes through
   * `formatReply`: a long one becomes several numbered entries (the keyboard rides
   * on the last, next to the question it answers) and a blank one becomes none.
   */
  enqueue(message: OutboundMessage): OutboundEntry[] {
    const parts = formatReply(message.text);
    const entries: OutboundEntry[] = [];
    parts.forEach((text, index) => {
      const entry: OutboundEntry = {
        id: randomUUID(),
        chatId: message.chatId,
        ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
        text,
        ...(message.keyboard === undefined || index !== parts.length - 1 ? {} : { keyboard: message.keyboard }),
        createdAt: this.now(),
      };
      const { dropped } = this.log.add(entry);
      for (const gone of dropped) {
        this.onDrop(gone, "outbound queue is full; oldest message dropped");
      }
      entries.push(entry);
    });
    return entries;
  }

  /** Forget everything queued for one topic (the topic is being deleted). */
  discardForThread(chatId: number, threadId: number): number {
    let removed = 0;
    for (const entry of this.log.pending()) {
      if (entry.chatId === chatId && entry.threadId === threadId) {
        this.log.ack(entry.id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Send what can be sent. Single-flight: concurrent callers share one run. */
  flush(): Promise<FlushResult> {
    if (this.flushing === undefined) {
      this.flushing = this.run().finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  private async run(): Promise<FlushResult> {
    let sent = 0;
    let dropped = 0;
    for (;;) {
      const entry = this.log.pending()[0];
      if (entry === undefined) {
        return { sent, dropped, remaining: 0 };
      }
      const wait = this.blockedUntil - this.now();
      if (wait > 0) {
        return { sent, dropped, remaining: this.log.size, retryInMs: wait, stoppedBy: "rate limited" };
      }
      try {
        await sendHtml(
          this.api,
          {
            chatId: entry.chatId,
            text: entry.text,
            ...(entry.threadId === undefined ? {} : { messageThreadId: entry.threadId }),
            ...(entry.keyboard === undefined ? {} : { inlineKeyboard: entry.keyboard }),
          },
          () => this.onFallback(entry),
        );
        this.log.ack(entry.id);
        sent += 1;
      } catch (error) {
        const description = describe(error);
        if (isBotApiError(error) && error.kind === "rate-limited") {
          const retryMs = Math.max(1, error.retryAfterSec ?? 1) * 1000;
          this.blockedUntil = this.now() + retryMs;
          return { sent, dropped, remaining: this.log.size, retryInMs: retryMs, stoppedBy: description };
        }
        if (isRetryable(error)) {
          return { sent, dropped, remaining: this.log.size, retryInMs: this.retryDelayMs, stoppedBy: description };
        }
        this.log.ack(entry.id);
        dropped += 1;
        this.onDrop(entry, description);
      }
    }
  }
}

function describe(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
