// The bus event log (specification §2.1, §4.2, §5.2; artifact-lifecycle.md).
//
// Append, under `append.lock`:
//   1. seq = max(head.seq, seq of the last complete line of the current
//      segment) + 1 — so a writer that died between its line and its head
//      update cannot cause a duplicate;
//   2. rotate first when this line would take the segment past the bound;
//   3. cut off an unterminated fragment a crashed writer left (it was never
//      readable and its seq never counted), then write one line;
//   4. rewrite head.json { seq, segment, segmentInode } atomically.
//
// Segments are numbered from 1. The current one is `events.jsonl`; rotation
// renames it to `events.<segment>.jsonl` (the rename keeps its inode) and the
// next line starts `events.jsonl` as segment + 1. The current number is
// max(head.segment, newest rotated + 1), so a crash between the rename and the
// head update is recovered from the directory itself.
//
// Readers hold a cursor { segment, inode, offset, seq }. They open the current
// segment FIRST and judge by that descriptor's inode, never by size (a freshly
// rotated segment can be smaller than the old offset) and never by a path read
// after listing (a rotation in between would skip a segment); they finish the
// old segment first, read complete lines only, and skip torn, invalid or unknown-version
// lines. `seq` is the last one delivered: an event at or below it is never
// returned twice, whatever path the reader took to reach it.

import { randomUUID } from "node:crypto";
import { appendFile, chmod, open, rename, stat, truncate } from "node:fs/promises";
import { isNotFound, withFileLock } from "../lib/fs";
import { redactSensitiveText } from "../security/service";
import { BusRefusal } from "./errors";
import { BUS_FILE_MODE, ensureBusDir, listDirNames, readJsonRecord, removeFile, writeBusFileAtomic } from "./files";
import { appendLockPath, eventsPath, headPath, parseRotatedSegmentName, rotatedSegmentPath } from "./paths";
import {
  BUS_SCHEMA_VERSION,
  type BusEvent,
  type BusEventKind,
  busEventProblems,
  type BusEventRefs,
  type BusOrigin,
  type BusSender,
  MAX_BODY_BYTES,
  parseBusEvent,
} from "./schema";

export const MAX_SEGMENT_BYTES = 1024 * 1024;
export const KEEP_ROTATED_SEGMENTS = 2;
export const ROTATED_SEGMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const APPEND_LOCK_TIMEOUT_MS = 30_000;
/**
 * `append.lock` staleness. `withFileLock`'s default (30 s) equals the append
 * timeout, so a writer SIGKILLed while holding the lock stalled every other
 * writer for ~30 s and could time them out (found by the T9 process test). A
 * holder is only ever held for one append; its heartbeat (every staleMs / 3)
 * keeps a live one fresh, and a live pid still wins over age, so only a dead
 * holder is reclaimed, after 5 s.
 */
export const BUS_LOCK_STALE_MS = 5_000;
/** How much of a segment's tail is read to find its last complete line. */
const TAIL_BYTES = 64 * 1024;

export interface BusHead {
  seq: number;
  segment: number;
  segmentInode: number;
}

export interface BusCursor {
  segment: number;
  /** Inode of the segment the offset belongs to; 0 when there was none. */
  inode: number;
  offset: number;
  /** Highest seq already delivered through this cursor. */
  seq: number;
}

export interface EventDraft {
  from: BusSender;
  to: string[];
  toLabel: string;
  kind: BusEventKind;
  body?: string;
  refs?: BusEventRefs;
  /** Defaults to a fresh UUID. */
  id?: string;
  /** Defaults to the append time. */
  ts?: string;
}

export interface AppendOptions {
  now?: () => number;
  /** Rotation bound; 1 MiB by default. Injectable for tests. */
  maxSegmentBytes?: number;
  lockTimeoutMs?: number;
  /**
   * Runs under `append.lock` before the seq is taken; throwing refuses the
   * append. Where a clone-wide limit is counted from the log (D-12).
   */
  underLock?: () => Promise<void> | void;
  /** Runs under the same lock hold after the line and head.json are written. */
  afterAppend?: (event: BusEvent) => Promise<void> | void;
  /**
   * TEST SEAM, never set in production: runs after the line is written and
   * BEFORE head.json is updated — the window a crashed writer leaves behind.
   * The process tests park a writer here and SIGKILL it.
   */
  afterLineWritten?: (event: BusEvent) => Promise<void> | void;
}

export interface RetentionOptions {
  now?: () => number;
  keep?: number;
  maxAgeMs?: number;
}

// ---------------------------------------------------------------------------
// Head and segment discovery.
// ---------------------------------------------------------------------------

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** head.json, or undefined when it is missing or malformed. */
export async function readHead(root: string): Promise<BusHead | undefined> {
  const value = await readJsonRecord(headPath(root));
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return isPositiveInt(record.seq) && isPositiveInt(record.segment) && record.segment >= 1 && isPositiveInt(record.segmentInode)
    ? { seq: record.seq, segment: record.segment, segmentInode: record.segmentInode }
    : undefined;
}

/** Rotated segment numbers present, ascending. */
export async function listRotatedSegments(root: string): Promise<number[]> {
  const numbers: number[] = [];
  for (const name of await listDirNames(root)) {
    const segment = parseRotatedSegmentName(name);
    if (segment !== undefined) numbers.push(segment);
  }
  return numbers.sort((a, b) => a - b);
}

function currentSegmentNumber(head: BusHead | undefined, rotated: readonly number[]): number {
  const newestRotated = rotated.length > 0 ? (rotated[rotated.length - 1] as number) : 0;
  return Math.max(head?.segment ?? 1, newestRotated + 1);
}

interface SegmentTail {
  size: number;
  ino: number;
  /** Seq of the last complete, parseable line; 0 when there is none. */
  lastSeq: number;
  endsWithNewline: boolean;
  /** Offset just after the last "\n" (0 when there is none). */
  completeEnd: number;
}

type Handle = Awaited<ReturnType<typeof open>>;

/** `file` opened read-only, or undefined when it does not exist. */
async function openIfExists(file: string, flags = "r"): Promise<Handle | undefined> {
  try {
    return await open(file, flags);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** The tail of an open segment: its size, inode, last complete line and seq. */
async function inspectHandle(handle: Handle): Promise<SegmentTail> {
  const { size, ino } = await handle.stat();
  if (size === 0) return { size, ino, lastSeq: 0, endsWithNewline: true, completeEnd: 0 };
  let start = size - Math.min(size, TAIL_BYTES);
  let bytes = await readRange(handle, start, size);
  let lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline === -1 && start > 0) {
    // A fragment longer than the tail window: look at the whole segment rather
    // than guess where the last complete line ends.
    start = 0;
    bytes = await readRange(handle, 0, size);
    lastNewline = bytes.lastIndexOf(0x0a);
  }
  const completeEnd = lastNewline === -1 ? 0 : start + lastNewline + 1;
  let lastSeq = 0;
  if (lastNewline !== -1) {
    const lines = bytes.subarray(0, lastNewline).toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0 && lastSeq === 0; i -= 1) {
      lastSeq = seqOfLine(lines[i] as string);
    }
  }
  return { size, ino, lastSeq, endsWithNewline: bytes[bytes.length - 1] === 0x0a, completeEnd };
}

async function readRange(handle: Handle, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.max(0, end - start));
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
  return buffer.subarray(0, bytesRead);
}

async function inspectSegment(file: string): Promise<SegmentTail | undefined> {
  const handle = await openIfExists(file);
  if (handle === undefined) return undefined;
  try {
    return await inspectHandle(handle);
  } finally {
    await handle.close().catch(() => {});
  }
}

/** The seq a line claims, or 0. Deliberately lenient: for seq recovery a higher claim is the safe one. */
function seqOfLine(line: string): number {
  if (line.trim().length === 0) return 0;
  try {
    const value = JSON.parse(line) as { seq?: unknown };
    return typeof value.seq === "number" && Number.isSafeInteger(value.seq) && value.seq >= 1 ? value.seq : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Append.
// ---------------------------------------------------------------------------

function buildEvent(draft: EventDraft, seq: number, now: number): BusEvent {
  const event: BusEvent = {
    schemaVersion: BUS_SCHEMA_VERSION,
    seq,
    id: draft.id ?? randomUUID(),
    ts: draft.ts ?? new Date(now).toISOString(),
    from: { instanceId: draft.from.instanceId, name: draft.from.name, origin: draft.from.origin },
    to: [...draft.to],
    toLabel: draft.toLabel,
    kind: draft.kind,
  };
  if (draft.body !== undefined) event.body = redactSensitiveText(draft.body);
  if (draft.refs !== undefined) {
    const refs: BusEventRefs = {};
    for (const key of ["replyTo", "leaseId", "flowId", "taskId"] as const) {
      const value = draft.refs[key];
      if (value !== undefined) refs[key] = value;
    }
    event.refs = refs;
  }
  return event;
}

/**
 * Append one event under `append.lock` and return it as written (with its seq,
 * id, timestamp and redacted body). Refuses `body-too-large` when the redacted
 * body exceeds 2048 UTF-8 bytes, and `invalid-event` for anything the schema
 * rejects; nothing is written then.
 */
export async function appendEvent(root: string, draft: EventDraft, options: AppendOptions = {}): Promise<BusEvent> {
  const now = options.now ?? Date.now;
  const maxSegmentBytes = options.maxSegmentBytes ?? MAX_SEGMENT_BYTES;
  await ensureBusDir(root);
  return withFileLock(
    appendLockPath(root),
    async () => {
      await options.underLock?.();
      const head = await readHead(root);
      const rotated = await listRotatedSegments(root);
      let segment = currentSegmentNumber(head, rotated);
      const current = await inspectSegment(eventsPath(root));

      let lastSeq = Math.max(head?.seq ?? 0, current?.lastSeq ?? 0);
      if ((current === undefined || current.lastSeq === 0) && rotated.length > 0) {
        const newest = await inspectSegment(rotatedSegmentPath(root, rotated[rotated.length - 1] as number));
        lastSeq = Math.max(lastSeq, newest?.lastSeq ?? 0);
      }

      const event = buildEvent(draft, lastSeq + 1, now());
      if (event.body !== undefined && Buffer.byteLength(event.body, "utf8") > MAX_BODY_BYTES) {
        throw new BusRefusal("body-too-large", `body is ${Buffer.byteLength(event.body, "utf8")} bytes after redaction; the limit is ${MAX_BODY_BYTES}`);
      }
      const problems = busEventProblems(event);
      if (problems.length > 0) throw new BusRefusal("invalid-event", problems.join("; "));

      const line = `${JSON.stringify(event)}\n`;
      let size = current?.size ?? 0;
      if (current !== undefined && !current.endsWithNewline) {
        // A crashed writer's unterminated fragment. It was never readable (no
        // newline) and its seq was never counted, so it is cut off rather than
        // terminated: terminating it would publish a line that may carry the
        // very seq this append is about to take.
        await truncate(eventsPath(root), current.completeEnd);
        size = current.completeEnd;
      }
      if (size > 0 && size + Buffer.byteLength(line, "utf8") > maxSegmentBytes) {
        await rename(eventsPath(root), rotatedSegmentPath(root, segment));
        segment += 1;
        await pruneRotatedSegments(root, { now });
      }

      const file = eventsPath(root);
      await appendFile(file, line, { encoding: "utf8", mode: BUS_FILE_MODE });
      if (process.platform !== "win32") await chmod(file, BUS_FILE_MODE);
      await options.afterLineWritten?.(event);
      const { ino } = await stat(file);
      await writeBusFileAtomic(headPath(root), `${JSON.stringify({ seq: event.seq, segment, segmentInode: ino })}\n`);
      await options.afterAppend?.(event);
      return event;
    },
    { timeoutMs: options.lockTimeoutMs ?? APPEND_LOCK_TIMEOUT_MS, staleMs: BUS_LOCK_STALE_MS },
  );
}

/**
 * Keep at most `keep` rotated segments (the newest) and delete any older than
 * `maxAgeMs` by mtime. Returns the removed file paths.
 */
export async function pruneRotatedSegments(root: string, options: RetentionOptions = {}): Promise<string[]> {
  const now = (options.now ?? Date.now)();
  const keep = options.keep ?? KEEP_ROTATED_SEGMENTS;
  const maxAgeMs = options.maxAgeMs ?? ROTATED_SEGMENT_MAX_AGE_MS;
  const newestFirst = (await listRotatedSegments(root)).reverse();
  const removed: string[] = [];
  for (const [index, segment] of newestFirst.entries()) {
    const file = rotatedSegmentPath(root, segment);
    let tooOld: boolean;
    try {
      tooOld = now - (await stat(file)).mtimeMs > maxAgeMs;
    } catch {
      continue;
    }
    if (index >= keep || tooOld) {
      await removeFile(file);
      removed.push(file);
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Read.
// ---------------------------------------------------------------------------

interface SegmentRead {
  events: BusEvent[];
  ino: number;
  /** Offset after the last complete line read. */
  end: number;
}

/**
 * Complete lines of `file` from `offset`. Undefined when the file is missing
 * or (with `expectIno`) is not the segment the caller means.
 */
async function readSegment(file: string, offset: number, expectIno?: number): Promise<SegmentRead | undefined> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    const { size, ino } = await handle.stat();
    if (expectIno !== undefined && ino !== expectIno) return undefined;
    if (size <= offset) return { events: [], ino, end: offset };
    const buffer = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const bytes = buffer.subarray(0, bytesRead);
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline === -1) return { events: [], ino, end: offset };
    return { events: parseLines(bytes.subarray(0, lastNewline).toString("utf8")), ino, end: offset + lastNewline + 1 };
  } finally {
    await handle.close().catch(() => {});
  }
}

function parseLines(text: string): BusEvent[] {
  const events: BusEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue; // torn or foreign line
    }
    const event = parseBusEvent(value); // invalid or unknown schemaVersion: skipped
    if (event !== undefined) events.push(event);
  }
  return events;
}

/**
 * TEST SEAM, never set in production: called once the current segment is open
 * (`opened`) and once the rotated segments are listed (`listed`) — the two
 * points where a concurrent rotation can interleave with a reader. Tests inject
 * a rotation there deterministically.
 */
export type ReaderRaceHook = (point: "opened" | "listed") => Promise<void> | void;

/** Rotated segments with their inodes, ascending by number. Missing files are dropped. */
async function rotatedWithInodes(root: string): Promise<{ segment: number; ino: number }[]> {
  const result: { segment: number; ino: number }[] = [];
  for (const segment of await listRotatedSegments(root)) {
    try {
      result.push({ segment, ino: (await stat(rotatedSegmentPath(root, segment))).ino });
    } catch (error) {
      if (!isNotFound(error)) throw error; // pruned between the listing and the stat
    }
  }
  return result;
}

/** Complete lines of an open segment from `offset`. */
async function readHandle(handle: Handle, offset: number): Promise<SegmentRead> {
  const { size, ino } = await handle.stat();
  if (size <= offset) return { events: [], ino, end: offset };
  const bytes = await readRange(handle, offset, size);
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline === -1) return { events: [], ino, end: offset };
  return { events: parseLines(bytes.subarray(0, lastNewline).toString("utf8")), ino, end: offset + lastNewline + 1 };
}

/**
 * Where the segment with inode `ino` lives: its rotated number when it has
 * been rotated, otherwise it is the current segment and its number follows the
 * newest rotated one (or head.json, whichever is higher).
 */
function segmentNumberOf(
  ino: number,
  rotated: readonly { segment: number; ino: number }[],
  head: BusHead | undefined,
): number {
  const found = rotated.find((entry) => entry.ino === ino);
  return found !== undefined ? found.segment : currentSegmentNumber(head, rotated.map((entry) => entry.segment));
}

/**
 * Events after `cursor`, and the cursor to use next time. Never throws on
 * content: bad lines are skipped.
 *
 * Order matters, and it is the reason for the descriptor: `events.jsonl` is
 * opened FIRST and read through that descriptor (inode X), and only then are
 * the rotated segments listed. Whatever rotations happen meanwhile, X is one
 * fixed segment: rotated segments older than X are read in full, X is read
 * through the descriptor, and anything newer than X is left for the next call
 * (its cursor names X, wherever X now lives). Reading `events.jsonl` by path
 * after the listing instead would skip a segment rotated in between.
 */
export async function readEvents(
  root: string,
  cursor: BusCursor,
  raceHook?: ReaderRaceHook,
): Promise<{ events: BusEvent[]; cursor: BusCursor }> {
  const events: BusEvent[] = [];
  let seq = cursor.seq;
  const take = (batch: readonly BusEvent[]): void => {
    for (const event of batch) {
      if (event.seq > seq) {
        events.push(event);
        seq = event.seq;
      }
    }
  };

  const current = await openIfExists(eventsPath(root));
  try {
    const currentIno = current === undefined ? undefined : (await current.stat()).ino;
    await raceHook?.("opened");
    const head = await readHead(root);
    const rotated = await rotatedWithInodes(root);
    await raceHook?.("listed");

    // The cursor's own segment is still the one we hold open: read on from its
    // offset (the rotation check is by inode, never by size).
    if (current !== undefined && currentIno === cursor.inode && cursor.inode !== 0) {
      const read = await readHandle(current, cursor.offset);
      take(read.events);
      return { events, cursor: { segment: segmentNumberOf(read.ino, rotated, head), inode: read.ino, offset: read.end, seq } };
    }

    // 1. Finish the cursor's own segment, found by inode among the rotated ones.
    const own = cursor.inode === 0 ? undefined : rotated.find((entry) => entry.ino === cursor.inode);
    if (own !== undefined) {
      const read = await readSegment(rotatedSegmentPath(root, own.segment), cursor.offset, own.ino);
      if (read !== undefined) take(read.events);
    }
    // 2. Every segment rotated after it and before the one we hold, in full.
    const from = own?.segment ?? cursor.segment;
    const held = currentIno === undefined ? undefined : rotated.find((entry) => entry.ino === currentIno);
    for (const entry of rotated) {
      const after = own !== undefined ? entry.segment > from : entry.segment >= from;
      if (!after || entry.ino === cursor.inode || entry.ino === currentIno) continue;
      if (held !== undefined && entry.segment > held.segment) break; // newer than X: next call
      const read = await readSegment(rotatedSegmentPath(root, entry.segment), 0, entry.ino);
      if (read !== undefined) take(read.events);
    }
    // 3. The segment we hold open, from its start.
    if (current === undefined || currentIno === undefined) {
      return { events, cursor: { segment: currentSegmentNumber(head, rotated.map((e) => e.segment)), inode: 0, offset: 0, seq } };
    }
    const read = await readHandle(current, 0);
    take(read.events);
    return { events, cursor: { segment: segmentNumberOf(read.ino, rotated, head), inode: read.ino, offset: read.end, seq } };
  } finally {
    await current?.close().catch(() => {});
  }
}

/**
 * A cursor at the current end of the log, so history is not replayed (§5.1).
 * Same order as `readEvents`: open the current segment first, then locate it.
 */
export async function cursorAtEnd(root: string, raceHook?: ReaderRaceHook): Promise<BusCursor> {
  const current = await openIfExists(eventsPath(root));
  try {
    await raceHook?.("opened");
    const head = await readHead(root);
    const rotated = await rotatedWithInodes(root);
    await raceHook?.("listed");
    if (current === undefined) {
      return { segment: currentSegmentNumber(head, rotated.map((e) => e.segment)), inode: 0, offset: 0, seq: head?.seq ?? 0 };
    }
    const tail = await inspectHandle(current);
    return {
      segment: segmentNumberOf(tail.ino, rotated, head),
      inode: tail.ino,
      offset: tail.completeEnd,
      seq: Math.max(head?.seq ?? 0, tail.lastSeq),
    };
  } finally {
    await current?.close().catch(() => {});
  }
}

/** A cursor before the oldest retained event: reading from it returns the whole retained log. */
export async function cursorAtStart(root: string): Promise<BusCursor> {
  const rotated = await listRotatedSegments(root);
  const segment = rotated.length > 0 ? (rotated[0] as number) : currentSegmentNumber(await readHead(root), rotated);
  return { segment, inode: 0, offset: 0, seq: 0 };
}

/**
 * Events from `origin` with a timestamp in the last `sinceMs`, counted over the
 * current segment and the newest rotated one (a minute of messages cannot span
 * more than one rotation at the D-12 rates). Used for the rate limits: the
 * clone-wide CLI limit (no `instanceId`) and the per-instance operator limit
 * (`instanceId` set to the sender's own id).
 */
export async function countRecent(
  root: string,
  options: { origin: BusOrigin; sinceMs: number; now?: () => number; instanceId?: string },
): Promise<number> {
  const since = (options.now ?? Date.now)() - options.sinceMs;
  const rotated = await listRotatedSegments(root);
  const files = [eventsPath(root)];
  if (rotated.length > 0) files.unshift(rotatedSegmentPath(root, rotated[rotated.length - 1] as number));
  let count = 0;
  for (const file of files) {
    const read = await readSegment(file, 0);
    for (const event of read?.events ?? []) {
      if (
        event.from.origin === options.origin &&
        (options.instanceId === undefined || event.from.instanceId === options.instanceId) &&
        Date.parse(event.ts) >= since
      ) {
        count += 1;
      }
    }
  }
  return count;
}
