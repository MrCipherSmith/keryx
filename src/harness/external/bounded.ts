// Bounded retention for what an external child writes (flow 292 T14).
//
// The per-LINE ceiling in `./bun-spawn-port.ts` stops one endless line. It does
// not stop a child that writes an endless number of ordinary lines: a probe that
// wrote 32 MB lines to stderr, each with its newline, took keryx from 35 MB to
// 1.5 GB RSS in twelve seconds, because every supervisor kept every line. Two
// shapes cover it:
//
//   - `BoundedTranscript` — for DIAGNOSTIC streams (stderr, and a line-stream
//     child's raw stdout). It keeps the HEAD (where usage errors and argv
//     rejections appear) and the TAIL (where the terminal error appears), drops
//     the middle, and counts what it dropped. A diagnostic is still worth
//     having when truncated; a run is not failed for being chatty on stderr.
//   - `OutputBudget` — for what the run PRODUCES (assistant text, canonical
//     events). That is the result, so it is never silently truncated: passing
//     the budget fails the run with a named reason and the child is killed.
//
// Sizes are measured in UTF-16 code units of the decoded text — the same unit
// the line ceiling and keryx's own ACP framing use. For ASCII that is bytes.
//
// Pure: no process, no clock.

/** Head kept from a diagnostic stream: argv rejections and usage errors print first. */
export const DIAGNOSTIC_HEAD_BYTES = 16 * 1024;
/** Tail kept from a diagnostic stream: the error that ended the run prints last. */
export const DIAGNOSTIC_TAIL_BYTES = 48 * 1024;

/**
 * The most a single run may PRODUCE — assistant text plus canonical events —
 * before it is stopped. 16 MiB: two orders of magnitude over any real agent
 * turn keryx has recorded (the largest structured result in the fixtures is a
 * few KB, and a full review report is well under 1 MiB), and small enough that
 * the retained copies stay far below the memory a hostile child could otherwise
 * make keryx spend.
 */
export const DEFAULT_MAX_RUN_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Fixed per-event overhead counted against the budget, so zero-text events cannot grow the list for free. */
export const EVENT_OVERHEAD_BYTES = 64;

/** Keeps the head and tail of a line stream, dropping (and counting) the middle. */
export class BoundedTranscript {
  private readonly head: string[] = [];
  private headBytes = 0;
  private tail: string[] = [];
  private tailStart = 0;
  private tailBytes = 0;
  private dropped = 0;
  private droppedLineCount = 0;

  constructor(
    private readonly headLimit: number = DIAGNOSTIC_HEAD_BYTES,
    private readonly tailLimit: number = DIAGNOSTIC_TAIL_BYTES,
  ) {}

  /** Bytes dropped so far (UTF-16 code units, `\n` included). */
  get droppedBytes(): number {
    return this.dropped;
  }

  get droppedLines(): number {
    return this.droppedLineCount;
  }

  /** What is currently held, head plus tail. Never more than `headLimit + tailLimit` (+ newlines). */
  get retainedBytes(): number {
    return this.headBytes + this.tailBytes;
  }

  push(line: string): void {
    const size = line.length + 1;
    if (this.tail.length === this.tailStart && this.headBytes + size <= this.headLimit) {
      this.head.push(line);
      this.headBytes += size;
      return;
    }
    // One line bigger than the whole tail keeps only its own last part.
    if (size > this.tailLimit) {
      this.dropAllTail();
      const kept = line.slice(line.length - (this.tailLimit - 1));
      this.dropped += line.length - kept.length;
      this.tail.push(kept);
      this.tailBytes = kept.length + 1;
      return;
    }
    this.tail.push(line);
    this.tailBytes += size;
    while (this.tailBytes > this.tailLimit && this.tailStart < this.tail.length) {
      const evicted = this.tail[this.tailStart] ?? "";
      this.tailStart += 1;
      this.tailBytes -= evicted.length + 1;
      this.dropped += evicted.length + 1;
      this.droppedLineCount += 1;
    }
    // Compact occasionally so eviction stays O(1) amortised without an unbounded array.
    if (this.tailStart > 1024 && this.tailStart * 2 > this.tail.length) {
      this.tail = this.tail.slice(this.tailStart);
      this.tailStart = 0;
    }
  }

  private dropAllTail(): void {
    for (let i = this.tailStart; i < this.tail.length; i += 1) {
      this.dropped += (this.tail[i] ?? "").length + 1;
      this.droppedLineCount += 1;
    }
    this.tail = [];
    this.tailStart = 0;
    this.tailBytes = 0;
  }

  /** The retained text, with a marker where the middle was dropped. */
  text(): string {
    const tail = this.tail.slice(this.tailStart);
    if (this.dropped === 0) return [...this.head, ...tail].join("\n");
    return [
      ...this.head,
      `[keryx] … ${this.dropped} bytes (${this.droppedLineCount} lines) dropped from the middle of this stream …`,
      ...tail,
    ].join("\n");
  }
}

/** A running total against a ceiling. `add` answers whether the total is still within it. */
export class OutputBudget {
  private used = 0;

  constructor(readonly limit: number = DEFAULT_MAX_RUN_OUTPUT_BYTES) {}

  get usedBytes(): number {
    return this.used;
  }

  add(bytes: number): boolean {
    this.used += bytes;
    return this.used <= this.limit;
  }
}

/** The budget cost of one canonical event: its text-bearing fields plus a fixed overhead. */
export function eventCost(event: { readonly kind: string } & Record<string, unknown>): number {
  let size = EVENT_OVERHEAD_BYTES;
  for (const key of ["text", "detail", "message", "name"]) {
    const value = event[key];
    if (typeof value === "string") size += value.length;
  }
  return size;
}

/** The named reason a run is stopped with when it passes its output budget. */
export function outputBudgetReason(limit: number): string {
  return `the agent produced more than ${limit} bytes of output in one run; the run was stopped and the agent killed`;
}
