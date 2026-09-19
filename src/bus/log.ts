// The bus event log (specification §2.1, §4.2, §5.2; artifact-lifecycle.md).
//
// Append, under `append.lock`:
//   1. seq = max(head.seq, seq of the last complete line of the current
//      segment) + 1 — so a writer that died between its line and its head
//      update cannot cause a duplicate;
//   2. rotate first when this line would take the segment past the bound;
//   3. write one line (terminating a torn fragment a crashed writer left, so
//      the fragment becomes one skipped line instead of corrupting ours);
//   4. rewrite head.json { seq, segment, segmentInode } atomically.
//
// Segments are numbered from 1. The current one is `events.jsonl`; rotation
// renames it to `events.<segment>.jsonl` (the rename keeps its inode) and the
// next line starts `events.jsonl` as segment + 1. The current number is
// max(head.segment, newest rotated + 1), so a crash between the rename and the
// head update is recovered from the directory itself.
//
// Readers hold a cursor { segment, inode, offset, seq }. They compare head and
// the current file's inode with the cursor BEFORE comparing sizes (a freshly
// rotated segment can be smaller than the old offset), finish the old segment
// first, read complete lines only, and skip torn, invalid or unknown-version
// lines. `seq` is the last one delivered: an event at or below it is never
// returned twice, whatever path the reader took to reach it.

import { randomUUID } from "node:crypto";
import { appendFile, chmod, open, rename, stat } from "node:fs/promises";
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

async function inspectSegment(file: string): Promise<SegmentTail | undefined> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    const { size, ino } = await handle.stat();
    if (size === 0) return { size, ino, lastSeq: 0, endsWithNewline: true, completeEnd: 0 };
    const length = Math.min(size, TAIL_BYTES);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    const completeEnd = lastNewline === -1 ? (start === 0 ? 0 : start) : start + lastNewline + 1;
    let lastSeq = 0;
    if (lastNewline !== -1) {
      const lines = text.slice(0, text.lastIndexOf("\n")).split("\n");
      for (let i = lines.length - 1; i >= 0 && lastSeq === 0; i -= 1) {
        lastSeq = seqOfLine(lines[i] as string);
      }
    }
    return { size, ino, lastSeq, endsWithNewline: buffer[bytesRead - 1] === 0x0a, completeEnd };
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
      let prefix = current !== undefined && !current.endsWithNewline ? "\n" : "";
      const size = current?.size ?? 0;
      if (size > 0 && size + Buffer.byteLength(prefix + line, "utf8") > maxSegmentBytes) {
        await rename(eventsPath(root), rotatedSegmentPath(root, segment));
        segment += 1;
        prefix = "";
        await pruneRotatedSegments(root, { now });
      }

      const file = eventsPath(root);
      await appendFile(file, prefix + line, { encoding: "utf8", mode: BUS_FILE_MODE });
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

async function statIno(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).ino;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * Events after `cursor`, and the cursor to use next time. Never throws on
 * content: bad lines are skipped. The rotation check (head and the current
 * file's inode against the cursor) comes before any size comparison.
 */
export async function readEvents(root: string, cursor: BusCursor): Promise<{ events: BusEvent[]; cursor: BusCursor }> {
  const head = await readHead(root);
  const currentIno = await statIno(eventsPath(root));
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

  const moved =
    cursor.inode === 0 ||
    (head !== undefined && (head.segment !== cursor.segment || head.segmentInode !== cursor.inode)) ||
    (currentIno !== undefined && currentIno !== cursor.inode);

  if (!moved) {
    const read = currentIno === undefined ? undefined : await readSegment(eventsPath(root), cursor.offset, cursor.inode);
    if (read === undefined) return { events, cursor };
    take(read.events);
    return { events, cursor: { segment: cursor.segment, inode: read.ino, offset: read.end, seq } };
  }

  // 1. Finish the cursor's own segment, now renamed to events.<segment>.jsonl
  //    (same inode). If it is gone or is not that file, nothing more of it can
  //    be read.
  if (cursor.inode !== 0 && cursor.segment >= 1) {
    const old = await readSegment(rotatedSegmentPath(root, cursor.segment), cursor.offset, cursor.inode);
    if (old !== undefined) take(old.events);
  }
  // 2. Every segment rotated since, in order, in full.
  const rotated = await listRotatedSegments(root);
  for (const segment of rotated) {
    const after = cursor.inode === 0 ? segment >= cursor.segment : segment > cursor.segment;
    if (!after) continue;
    const read = await readSegment(rotatedSegmentPath(root, segment), 0);
    if (read !== undefined) take(read.events);
  }
  // 3. The current segment from its start.
  const segment = currentSegmentNumber(head, rotated);
  const current = await readSegment(eventsPath(root), 0);
  if (current === undefined) return { events, cursor: { segment, inode: 0, offset: 0, seq } };
  take(current.events);
  return { events, cursor: { segment, inode: current.ino, offset: current.end, seq } };
}

/** A cursor at the current end of the log, so history is not replayed (§5.1). */
export async function cursorAtEnd(root: string): Promise<BusCursor> {
  const head = await readHead(root);
  const rotated = await listRotatedSegments(root);
  const segment = currentSegmentNumber(head, rotated);
  const current = await inspectSegment(eventsPath(root));
  if (current === undefined) return { segment, inode: 0, offset: 0, seq: head?.seq ?? 0 };
  return { segment, inode: current.ino, offset: current.completeEnd, seq: Math.max(head?.seq ?? 0, current.lastSeq) };
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
 * more than one rotation at the D-12 rates). Used for the rate limits.
 */
export async function countRecent(
  root: string,
  options: { origin: BusOrigin; sinceMs: number; now?: () => number },
): Promise<number> {
  const since = (options.now ?? Date.now)() - options.sinceMs;
  const rotated = await listRotatedSegments(root);
  const files = [eventsPath(root)];
  if (rotated.length > 0) files.unshift(rotatedSegmentPath(root, rotated[rotated.length - 1] as number));
  let count = 0;
  for (const file of files) {
    const read = await readSegment(file, 0);
    for (const event of read?.events ?? []) {
      if (event.from.origin === options.origin && Date.parse(event.ts) >= since) count += 1;
    }
  }
  return count;
}
