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
 * The idempotency index path for a key, WITHIN a project.
 *
 * The key is HASHED rather than used as a filename, and not for tidiness: an
 * idempotency key is caller-supplied untrusted text, and a caller-controlled
 * string reaching a path join is the containment defect flow 126 fixed
 * elsewhere in this codebase. A hex digest cannot traverse, cannot collide with
 * a reserved name, and cannot be a device file.
 *
 * `project` is in the digest because without it the index was GLOBAL, and one
 * install serves many projects. Two transports drawing keys from the same
 * counter space — a chat message id, a job number — collided: the second
 * project's submission was answered `200 {duplicate: true}` naming the FIRST
 * project's turn, its prompt never ran, and `GET /v1/turns/{id}` handed the
 * caller the other project's result text. That is the failure `resolveProject`
 * exists to prevent, arriving through the field next to the one it guards.
 *
 * The digest is over a LENGTH-PREFIXED composite, not a concatenation.
 * `sha256(project + key)` maps `("/a/b", "c")` and `("/a", "/bc")` to the same
 * digest, which would put the collision back in a subtler place. Prefixing the
 * project's byte length makes the encoding injective.
 *
 * `project` is the path the REGISTRY resolved, never the caller's string — see
 * `resolveProject`. A caller cannot pick which bucket their key lands in beyond
 * picking a project they are already entitled to submit to.
 */
function keyPath(project: string, idempotencyKey: string, dir?: string): string {
  const projectBytes = Buffer.byteLength(project, "utf8");
  const digest = createHash("sha256")
    .update(`${projectBytes}:${project}\u0000${idempotencyKey}`, "utf8")
    .digest("hex");
  return path.join(turnsRoot(dir), "keys", `${digest}.json`);
}

/** Why a turn file could not be read, or the value if it could. */
export type TurnReadFailure = ConfigReadFailure | "not-a-turn-id" | "malformed";

export type TurnReadResult<T> = { ok: true; value: T } | { ok: false; reason: TurnReadFailure };

/**
 * Is this failure THIS PROCESS failing, or an answer about what was asked for?
 *
 * The owner of the ROUTE's question, at the one site that asks it.
 *
 * The sentence here used to read "the single owner of a split that five call
 * sites were each making for themselves", and three reviewers independently
 * filed it: there is one caller. The count was right and the sentence was
 * wrong twice over — it claimed a consolidation that had not happened, and it
 * asserted that all five sites were asking one question when they are asking
 * two. See the note below `isDefiniteAbsence` for the other one.
 *
 * What is true: `serve-server.ts` enumerated `too-large || unreadable` inline
 * and everything else fell through, so a `turn.json` that was a directory or a
 * symlink — the `not-regular` case, a deliberately hostile shape — answered
 * "Not found" for a record that was demonstrably there.
 *
 * The three that are NOT a fault are answers about the request:
 *
 *   absent          there is no such turn
 *   not-a-turn-id   that is not an id
 *   malformed       the record is not a record
 *
 * An unknown id, a malformed one, and one the caller may not reach must be
 * indistinguishable (api-protocol.md §Principles), so all three answer 404 and
 * that is a decision rather than an omission. The other three mean a file IS
 * there and this process would not read it, which is worth reporting as this
 * process failing.
 *
 * Total over the union, with no default arm: a seventh reason added to
 * `TurnReadFailure` fails to compile here rather than silently picking a side.
 *
 * WHAT THIS DOES NOT OWN. The docstring above this one used to open "the single
 * owner of a split that five call sites were each making for themselves", and
 * three reviewers independently pointed out that it had one caller. They were
 * right about the count and the sentence was wrong, but the fix is not to route
 * the other four through here — it is that they are not all asking this
 * question. Two questions were being conflated, including by the commit that
 * introduced this function:
 *
 *   isServerFault      how should a ROUTE answer? 404 (about the request) or
 *                      500 (about this process). `malformed` is a 404, because
 *                      an unknown id, a malformed one and one the caller may
 *                      not reach must be indistinguishable.
 *   isDefiniteAbsence  can a definite answer be given AT ALL? `malformed` is
 *                      not: the record is there and its contents are unknowable,
 *                      so "there is no such turn" would be a claim nothing
 *                      supports.
 *
 * They disagree on `malformed` on purpose, and that disagreement is the reason
 * one predicate cannot serve both. `serve-turn.ts` asks the second, and answering
 * it with the first would turn an unreadable claimed record back into
 * `200 {duplicate: true, sessionId: ""}` — the null-record-for-a-stated-failure
 * this flow removed.
 */
export function isServerFault(reason: TurnReadFailure): boolean {
  switch (reason) {
    case "absent":
    case "not-a-turn-id":
    case "malformed":
      return false;
    case "not-regular":
    case "too-large":
    case "unreadable":
      return true;
  }
}

/**
 * Is this failure a DEFINITE statement that there is nothing there?
 *
 * `absent` is the only one. Every other reason means a file exists and this
 * process could not turn it into a value, or that the question itself was
 * malformed — and in both cases "there is nothing there" is a claim nothing
 * supports.
 *
 * The distinction has teeth on the idempotency path. A claim whose record was
 * REMOVED is still a duplicate: the claim is the authority on what the key
 * holds, and the turn really did happen. A claim whose record is unreadable is
 * not, because the duplicate answer has to carry a session id it does not have.
 *
 * Total over the union, no default arm, for the same reason as `isServerFault` —
 * and note that the two are NOT complements: they disagree on `malformed`,
 * which is a 404 to a route and not a definite absence to a caller deciding
 * whether it may answer at all.
 */
export function isDefiniteAbsence(reason: TurnReadFailure): boolean {
  switch (reason) {
    case "absent":
      return true;
    case "not-a-turn-id":
    case "malformed":
    case "not-regular":
    case "too-large":
    case "unreadable":
      return false;
  }
}

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
  // Optimistic, because after `createTurnRecord` the directory is already there
  // and the walk is pure overhead on every subsequent append — three `mkdirSync`
  // plus three `chmodSync`, which measured at 17.6µs against an 8.5µs write.
  // Moving the bound above it stopped paying that for REFUSED events; this stops
  // paying it for accepted ones, which are the overwhelming majority.
  //
  // ENOENT is the one case where the walk was doing something: the directory
  // does not exist yet, or has been removed underneath a live turn. Creating it
  // then and retrying costs the same as before in exactly that case and nothing
  // in the others. Every other error propagates — a permission fault must not be
  // retried into a second, identical permission fault.
  //
  // The consequence worth naming: the fast path does not re-assert 0700 on the
  // parent levels. `createTurnRecord` establishes the mode once per turn and
  // `appendOwnerOnlyLine` still chmods the events file itself on every append,
  // so what is no longer re-checked is a directory this process created and
  // nothing else writes to.
  const line = JSON.stringify(event);
  try {
    appendOwnerOnlyLine(path.join(turnDir(event.turnId, dir), "events.jsonl"), line);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
    appendOwnerOnlyLine(path.join(ensureTurnDir(event.turnId, dir), "events.jsonl"), line);
  }
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
    // A definite absence is a real answer: a turn whose first event has not been
    // appended yet has no log, and that is zero events rather than a failure.
    // Every other reason is a file this process could not read, and saying "no
    // events" about
    // one of those is the silent truncation §Bounds forbids.
    if (isDefiniteAbsence(read.reason)) {
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
export function claimIdempotencyKey(
  project: string,
  idempotencyKey: string,
  turnId: string,
  dir?: string,
): { existing: string | null } {
  const file = keyPath(project, idempotencyKey, dir);
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
 * Returns whether an entry was removed, which is the only signal separating
 * "released" from "someone else holds it now" — the guard above makes the second
 * case a silent no-op, and a caller that discards the boolean cannot tell the
 * two apart. `createSubmitTurn` reports the second on the operator's stderr.
 */
export function releaseIdempotencyKey(
  project: string,
  idempotencyKey: string,
  turnId: string,
  dir?: string,
): boolean {
  const file = keyPath(project, idempotencyKey, dir);
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
