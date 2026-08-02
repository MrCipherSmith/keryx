// The durable record a remote turn is streamed, resumed and replayed from.
//
// This module is written BEFORE the routes that use it, and that order is a
// design decision rather than a build order. Two acceptance criteria — an
// idempotency key that holds across a process restart, and a `Last-Event-ID`
// re-attachment that replays what a client missed — are both statements about
// what survives the process. A stream implemented as a live pipe with replay
// bolted on afterwards satisfies neither, and would need a second code path for
// the replay that could disagree with the first.
//
// So there is one append-only record per turn, and everything else is a VIEW
// over it:
//
//   the live stream      tail the record as it grows
//   re-attachment        read the record from `seq > lastEventId`, then tail
//   the terminal result  the record's final document
//   idempotency          a key -> turnId index consulted before anything runs
//
// "Re-attachment never re-executes anything" is then true by construction: a
// re-attaching client reads a file. There is no branch it could take that runs
// a turn, because reading is the only thing this module offers.
//
// Layout, under the shared user-global directory:
//
//   turns/<turnId>/events.jsonl   append-only, one stream event per line
//   turns/<turnId>/turn.json      metadata + terminal result once it exists
//   turns/keys/<hash>.json        idempotency key hash -> turnId
//
// Everything is written through the sanctioned helpers in `config-dir.ts` and
// read through `readConfigFile`, so `config-dir.writers.test.ts` stays green and
// no reader here can be made to abort the process on an oversized file.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  appendOwnerOnlyLine,
  type ConfigReadFailure,
  ensureKeryxSubdir,
  keryxConfigDir,
  readConfigFile,
  readTurnFile,
  writeOwnerOnlyFile,
} from "./config-dir";

/** `stream-event.schema.json`, as this release emits it. */
export type StreamEventKind =
  | "turn.started"
  | "assistant.delta"
  | "tool.started"
  | "tool.finished"
  | "approval.pending"
  | "approval.resolved"
  | "turn.finished";

export interface StreamEvent {
  schemaVersion: "1.0.0";
  turnId: string;
  /** Monotonic within a turn, from 0. The resume cursor. */
  seq: number;
  kind: StreamEventKind;
  at: string;
  text?: string;
  tool?: {
    name: string;
    summary?: string;
    decision?: "allow" | "ask" | "deny";
    outcome?: "ok" | "error" | "denied" | "refused";
  };
  approvalId?: string;
  resolution?: "allowed" | "denied" | "expired" | "undeliverable";
  /** True on the final event of a stream. A stream is never truncated silently. */
  terminal?: boolean;
}

/** `turn-result.schema.json`. */
export type TurnOutcome = "completed" | "denied" | "cancelled" | "refused" | "failed" | "expired";

export interface TurnResult {
  schemaVersion: "1.0.0";
  turnId: string;
  sessionId: string;
  /** `local-tty` or `remote:<slug>`. Assigned by the server, never read from content. */
  origin: string;
  outcome: TurnOutcome;
  reasonCode?: string;
  text?: string;
  startedAt: string;
  finishedAt: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUnits?: number };
  approvals?: Array<{ approvalId: string; resolution: "allowed" | "denied" | "expired" | "undeliverable" }>;
  evidenceRef?: string;
  correlationId?: string;
}

/** What `turn.json` holds. The result is absent until the turn is terminal. */
export interface TurnRecord {
  turnId: string;
  sessionId: string;
  project: string;
  origin: string;
  startedAt: string;
  /** Present once the turn reaches a terminal state. */
  result?: TurnResult;
}

/**
 * The largest number of events retained for one turn.
 *
 * api-protocol.md §Bounds requires an event backlog "retained for
 * re-attachment for a configured window, then the stream is closed with a
 * terminal event rather than truncated silently". This is the count form of
 * that: past the bound the record stops growing and the stream closes with a
 * terminal event carrying a reason, so a client is told the backlog ended rather
 * than quietly receiving less than happened.
 */
export const MAX_TURN_EVENTS = 10_000;

function turnsRoot(dir?: string): string {
  return path.join(keryxConfigDir(dir), "turns");
}

function turnDir(turnId: string, dir?: string): string {
  return path.join(turnsRoot(dir), turnId);
}

/**
 * The idempotency index path for a key.
 *
 * The key is HASHED rather than used as a filename, and not for tidiness: an
 * idempotency key is caller-supplied untrusted text, and a caller-controlled
 * string reaching a path join is the containment defect flow 126 fixed
 * elsewhere in this codebase. A hex digest cannot traverse, cannot collide with
 * a reserved name, and cannot be a device file.
 */
function keyPath(idempotencyKey: string, dir?: string): string {
  const digest = createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
  return path.join(turnsRoot(dir), "keys", `${digest}.json`);
}

/** Why a turn file could not be read, or the value if it could. */
export type TurnReadFailure = ConfigReadFailure | "not-a-turn-id" | "malformed";

export type TurnReadResult<T> = { ok: true; value: T } | { ok: false; reason: TurnReadFailure };

/**
 * Reject a turn id that is not the shape this module mints.
 *
 * `turnId` arrives from the URL on every read route. Everything below joins it
 * onto a path, so this is the containment boundary for all of them — one check,
 * at the one place the id becomes a path, rather than one per route.
 */
export function isTurnId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function ensureTurnDir(turnId: string, dir?: string): string {
  // Through the sanctioned helper, not `mkdirSync`. The writers guard reported
  // the first version of this line — correctly: a mode-less subdirectory inside
  // a correctly-created root is precisely the `sessions/` shape that guard was
  // built after.
  return ensureKeryxSubdir(["turns", turnId], dir);
}

/** Create the record for a turn that is about to start. */
export function createTurnRecord(record: TurnRecord, dir?: string): void {
  ensureTurnDir(record.turnId, dir);
  writeOwnerOnlyFile(path.join(turnDir(record.turnId, dir), "turn.json"), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Append one event. Returns false when the backlog bound is already reached.
 *
 * The caller turns a `false` into a terminal event rather than this module
 * doing it, because "the stream is closed with a terminal event" is a statement
 * about the stream and the stream is the caller's.
 */
export function appendTurnEvent(event: StreamEvent, dir?: string, opts?: { force?: boolean }): boolean {
  // The bound BEFORE the directory walk. `ensureTurnDir` is three `mkdirSync`
  // plus three `chmodSync` on levels that already exist after the first event —
  // 16.8 of the 26.5 microseconds an append cost, 63% of it redundant — and it
  // ran even when the very next line was about to refuse the event. Refusing
  // costs nothing now.
  //
  // `force` exists for exactly one event: the terminal one. §Bounds requires the
  // stream to be CLOSED with a terminal event rather than truncated, and the
  // caller could not honour that while the bound refused the closing event
  // too — past the bound `turn.finished` was dropped like everything else, so
  // the stream simply stopped, which is the silent truncation the bound was
  // supposed to prevent. One event past the window is the cost of saying so.
  if (event.seq >= MAX_TURN_EVENTS && opts?.force !== true) {
    return false;
  }
  const target = ensureTurnDir(event.turnId, dir);
  appendOwnerOnlyLine(path.join(target, "events.jsonl"), JSON.stringify(event));
  return true;
}

/**
 * Every event for a turn with `seq > after`, in order.
 *
 * `after` is the `Last-Event-ID` cursor, exclusive — a client that received
 * event 4 asks for everything above 4. Defaults to -1, which is "from the
 * beginning" and is NOT the same as 0: event 0 exists.
 *
 * A line that does not parse is skipped rather than throwing. A torn final
 * append — the process died mid-write — must not make the whole turn
 * unreadable, and every line before it is intact by construction because each
 * append is one document.
 */
export function readTurnEvents(turnId: string, after = -1, dir?: string): TurnReadResult<StreamEvent[]> {
  if (!isTurnId(turnId)) {
    return { ok: false, reason: "not-a-turn-id" };
  }
  const read = readTurnFile(path.join(turnDir(turnId, dir), "events.jsonl"));
  if (!read.ok) {
    // `absent` is a real answer: a turn whose first event has not been appended
    // yet has no log, and that is zero events rather than a failure. Every other
    // reason is a file this process could not read, and saying "no events" about
    // one of those is the silent truncation §Bounds forbids.
    if (read.reason === "absent") {
      return { ok: true, value: [] };
    }
    return { ok: false, reason: read.reason };
  }
  const events: StreamEvent[] = [];
  for (const line of read.text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const event = JSON.parse(line) as StreamEvent;
      if (typeof event.seq === "number" && event.seq > after) {
        events.push(event);
      }
    } catch {
      continue;
    }
  }
  return { ok: true, value: events };
}

/**
 * The record for a turn.
 *
 * `absent` and `malformed` are distinct from `too-large` and `unreadable` for
 * the same reason the event log's are: a route that answers 404 for all four
 * tells the caller a turn does not exist when the truth is that this process
 * could not read one that does — and `finishTurn` built on that answer no-opped
 * silently, stranding the turn at 409 forever.
 */
export function readTurnRecord(turnId: string, dir?: string): TurnReadResult<TurnRecord> {
  if (!isTurnId(turnId)) {
    return { ok: false, reason: "not-a-turn-id" };
  }
  const read = readTurnFile(path.join(turnDir(turnId, dir), "turn.json"));
  if (!read.ok) {
    return { ok: false, reason: read.reason };
  }
  try {
    const record = JSON.parse(read.text) as TurnRecord;
    if (typeof record.turnId !== "string" || record.turnId !== turnId) {
      return { ok: false, reason: "malformed" };
    }
    return { ok: true, value: record };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/**
 * Write the terminal result onto an existing record. Returns what it did.
 *
 * The boolean is the point. This used to return void and no-op when the record
 * could not be read, so an unreadable `turn.json` left a turn that had finished
 * reporting `running` — 409 to every later submission, with nothing anywhere
 * saying why.
 */
export function finishTurn(turnId: string, result: TurnResult, dir?: string): boolean {
  const record = readTurnRecord(turnId, dir);
  if (!record.ok) {
    return false;
  }
  writeOwnerOnlyFile(
    path.join(turnDir(turnId, dir), "turn.json"),
    `${JSON.stringify({ ...record.value, result }, null, 2)}\n`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Claim an idempotency key for a turn, or report who already holds it.
 *
 * Returns the EXISTING turnId when the key is taken, so the caller answers with
 * the original turn and starts nothing. Durable, because the index is a file:
 * the claim survives a restart, which is what AC7 asks and what an in-memory map
 * cannot give.
 *
 * The claim is not atomic against a concurrent claim of the same key in another
 * process. Stated rather than implied: two processes serving the same install is
 * not a configuration this release supports — there is no PID file and no
 * supervisor — and a lock here would be machinery for a scenario that cannot
 * arise yet. Within one process the check-then-write is synchronous.
 */
export function claimIdempotencyKey(idempotencyKey: string, turnId: string, dir?: string): { existing: string | null } {
  const file = keyPath(idempotencyKey, dir);
  const read = readConfigFile(file);
  if (read.ok) {
    try {
      const held = JSON.parse(read.text) as { turnId?: unknown };
      if (typeof held.turnId === "string" && isTurnId(held.turnId)) {
        return { existing: held.turnId };
      }
    } catch {
      // A damaged index entry is treated as absent and overwritten below. The
      // alternative — refusing the turn — would make one corrupt file a
      // permanent denial of service for whichever key hashes to it.
    }
  }
  ensureKeryxSubdir(["turns", "keys"], dir);
  writeOwnerOnlyFile(file, `${JSON.stringify({ turnId }, null, 2)}\n`);
  return { existing: null };
}

/**
 * Release a claim this turn took and could not use.
 *
 * The release path this module went two rounds without. `claimIdempotencyKey`
 * writes a durable file and nothing ever removed it, so a claim taken before a
 * step that then failed burned the key permanently: every later submission of
 * the corrected prompt answered `200 {duplicate: true, sessionId: ""}` naming a
 * turnId whose record does not exist, and the legitimate prompt never ran. The
 * first fix moved the claim behind the security scan, which closed the one
 * example the finding named and left the four writers after it.
 *
 * Guarded by `turnId`. It removes the entry ONLY when the key still points at
 * the turn releasing it, so a release arriving after another turn legitimately
 * re-claimed the key cannot take that turn's claim away.
 *
 * Returns whether an entry was removed, so a caller can tell "released" from
 * "someone else holds it now" rather than inferring it.
 */
export function releaseIdempotencyKey(idempotencyKey: string, turnId: string, dir?: string): boolean {
  const file = keyPath(idempotencyKey, dir);
  const read = readConfigFile(file);
  if (!read.ok) {
    return false;
  }
  try {
    const held = JSON.parse(read.text) as { turnId?: unknown };
    if (held.turnId !== turnId) {
      return false;
    }
  } catch {
    // A damaged entry is not this turn's to remove. `claimIdempotencyKey`
    // overwrites it on the next claim, which is the recovery path.
    return false;
  }
  rmSync(file, { force: true });
  return true;
}

/** Turn ids with a record on disk. Used by tests and by drain accounting. */
export function listTurnIds(dir?: string): string[] {
  const root = turnsRoot(dir);
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .filter((name) => isTurnId(name))
    .sort();
}
