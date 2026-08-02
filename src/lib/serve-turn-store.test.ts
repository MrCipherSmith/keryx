// The durable turn record (flow 131 / R4c).
//
// Everything asserted here is a property the routes above it depend on and
// cannot re-establish: the cursor semantics re-attachment reads with, an
// idempotency claim that survives a restart, and a turn id that cannot become a
// path. Each is tested against the store directly, because a route test that
// happened to pass would not tell you which of the two layers held.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendOwnerOnlyLine, MAX_CONFIG_FILE_BYTES, MAX_TURN_FILE_BYTES } from "./config-dir";
import {
  appendTurnEvent,
  claimIdempotencyKey,
  createTurnRecord,
  finishTurn,
  isTurnId,
  listTurnIds,
  MAX_TURN_EVENTS,
  readTurnEvents,
  isDefiniteAbsence,
  isServerFault,
  readTurnRecord,
  releaseIdempotencyKey,
  type StreamEvent,
  type TurnReadFailure,
  type TurnRecord,
  type TurnResult,
} from "./serve-turn-store";

let configDir = "";

// Hex LETTERS on purpose. The first version of these constants was all digits,
// so the "uppercase is rejected" assertion below was comparing a string to
// itself and passing for that reason rather than for the intended one.
/** The project an idempotency key is scoped to. Keys are per-project now. */
const PROJECT = "/tmp/project";
const TURN = "1a1b1c1d-2e2f-4a3b-8c4d-5e5f6a6b7c7d";
const OTHER = "9f9e9d9c-8b8a-4d7c-8e6f-5a5b4c4d3e3f";

beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "keryx-turns-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

/**
 * The events of a turn, failing loudly when the store could not read them.
 *
 * Both readers return a typed result now, because collapsing `too-large` into
 * an empty list is the blocker this flow fixed. The unwrapping in these tests
 * must not put the collapse back: an unreadable read here is a red test naming
 * the reason, never an assertion about zero events.
 */
function eventsOf(turnId: string, after = -1, dir = configDir): StreamEvent[] {
  const read = readTurnEvents(turnId, after, dir);
  if (!read.ok) {
    throw new Error(`events for ${turnId} could not be read: ${read.reason}`);
  }
  return read.value;
}

/** The record of a turn, failing loudly for the same reason. */
function recordOf(turnId: string, dir = configDir): TurnRecord {
  const read = readTurnRecord(turnId, dir);
  if (!read.ok) {
    throw new Error(`record for ${turnId} could not be read: ${read.reason}`);
  }
  return read.value;
}

function event(seq: number, overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    schemaVersion: "1.0.0",
    turnId: TURN,
    seq,
    kind: "assistant.delta",
    at: "2026-08-01T20:00:00.000Z",
    ...overrides,
  };
}

function record(turnId = TURN) {
  return {
    turnId,
    sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    project: "/tmp/project",
    origin: "remote:http",
    startedAt: "2026-08-01T20:00:00.000Z",
  };
}

describe("turn ids are constrained before they become paths", () => {
  test("only a uuid shape is accepted", () => {
    expect(isTurnId(TURN)).toBe(true);
    expect(isTurnId("not-a-uuid")).toBe(false);
    expect(isTurnId("")).toBe(false);
    // Uppercase is rejected too: this module MINTS lowercase, so accepting
    // both would mean two ids naming one turn on a case-insensitive filesystem.
    expect(isTurnId(TURN.toUpperCase())).toBe(false);
  });

  test("traversal shapes are refused rather than sanitized", () => {
    for (const hostile of [
      "../../etc/passwd",
      "..",
      ".",
      `${TURN}/../..`,
      `${TURN}%2f..`,
      "/etc/passwd",
      `${TURN}\u0000`,
    ]) {
      expect({ hostile, accepted: isTurnId(hostile) }).toEqual({ hostile, accepted: false });
    }
  });

  test("a read with a hostile id returns nothing and touches nothing", () => {
    // The containment boundary, exercised through the readers rather than
    // through the predicate — a route calls these, not `isTurnId`.
    expect(readTurnRecord("../../etc/passwd", configDir)).toEqual({ ok: false, reason: "not-a-turn-id" });
    expect(readTurnEvents("../../etc/passwd", -1, configDir)).toEqual({ ok: false, reason: "not-a-turn-id" });
    expect(existsSync(path.join(configDir, "turns"))).toBe(false);
  });
});

describe("the event log", () => {
  test("events come back in order, and `after` is EXCLUSIVE", () => {
    createTurnRecord(record(), configDir);
    for (let seq = 0; seq < 5; seq += 1) {
      expect(appendTurnEvent(event(seq), configDir)).toBe(true);
    }

    expect(eventsOf(TURN, -1, configDir).map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    // A client that received event 2 asks for everything above 2.
    expect(eventsOf(TURN, 2, configDir).map((e) => e.seq)).toEqual([3, 4]);
    // -1 is "from the beginning" and is NOT the same as 0: event 0 exists, and
    // a cursor defaulting to 0 would silently drop the first event of every
    // stream.
    expect(eventsOf(TURN, 0, configDir).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  test("events of one turn never appear in another", () => {
    createTurnRecord(record(), configDir);
    createTurnRecord(record(OTHER), configDir);
    appendTurnEvent(event(0), configDir);
    appendTurnEvent({ ...event(0), turnId: OTHER }, configDir);

    expect(eventsOf(TURN, -1, configDir)).toHaveLength(1);
    expect(eventsOf(OTHER, -1, configDir)).toHaveLength(1);
    expect(eventsOf(TURN, -1, configDir)[0]?.turnId).toBe(TURN);
  });

  test("a torn final line does not make the whole turn unreadable", () => {
    // The process dying mid-append must cost the last record, not the turn.
    // Every earlier line is intact by construction because each append is one
    // complete document.
    createTurnRecord(record(), configDir);
    appendTurnEvent(event(0), configDir);
    appendTurnEvent(event(1), configDir);
    appendOwnerOnlyLine(path.join(configDir, "turns", TURN, "events.jsonl"), '{"schemaVersion":"1.0.0","se');

    expect(eventsOf(TURN, -1, configDir).map((e) => e.seq)).toEqual([0, 1]);
  });

  test("the backlog is bounded, and the bound is reported rather than silently truncating", () => {
    // api-protocol.md §Bounds: past the window "the stream is closed with a
    // terminal event rather than truncated silently". `false` is how this
    // module tells the caller to do that.
    createTurnRecord(record(), configDir);
    expect(appendTurnEvent(event(MAX_TURN_EVENTS - 1), configDir)).toBe(true);
    expect(appendTurnEvent(event(MAX_TURN_EVENTS), configDir)).toBe(false);
  });

  test("the terminal event is not refused by the bound that refuses the rest", () => {
    // §Bounds says the stream is CLOSED with a terminal event rather than
    // truncated. It could not be: the bound refused the closing event along with
    // everything else, so past the window the stream simply stopped and a client
    // waiting for a terminal event waited forever.
    createTurnRecord(record(), configDir);
    expect(appendTurnEvent(event(MAX_TURN_EVENTS), configDir)).toBe(false);
    expect(appendTurnEvent(event(MAX_TURN_EVENTS, { kind: "turn.finished", terminal: true }), configDir, { force: true })).toBe(true);

    const written = eventsOf(TURN, -1, configDir);
    expect(written.map((e) => e.kind)).toEqual(["turn.finished"]);
    expect(written[0]?.terminal).toBe(true);
  });

  test("an event log past the CONFIG bound reads back whole", () => {
    // F-002, the blocker. `events.jsonl` is append-only and grows with the turn,
    // and it was read through `readConfigFile` — bound at 1 MB — while this
    // module's own `MAX_TURN_EVENTS` is 10 000. Measured on the branch this
    // fixes: 8 000 events gave 1 302 890 bytes and the read then returned ZERO,
    // so past roughly 6 500 events the SSE route answered 200 with an empty
    // body for a turn that had produced thousands.
    //
    // Sized from the real bound rather than from a round number, so the test
    // still means something if either bound moves.
    createTurnRecord(record(), configDir);
    const filler = "x".repeat(400);
    const perEvent = JSON.stringify(event(0, { text: filler })).length + 1;
    const count = Math.ceil((MAX_CONFIG_FILE_BYTES * 1.5) / perEvent);
    for (let seq = 0; seq < count; seq += 1) {
      appendTurnEvent(event(seq, { text: filler }), configDir);
    }

    const log = path.join(configDir, "turns", TURN, "events.jsonl");
    // The premise: without this, a shorter log would satisfy the assertion below
    // for the wrong reason.
    expect(statSync(log).size).toBeGreaterThan(MAX_CONFIG_FILE_BYTES);

    const events = eventsOf(TURN, -1, configDir);
    expect({ read: events.length, appended: count }).toEqual({ read: count, appended: count });
    expect(events.at(-1)?.seq).toBe(count - 1);
  });

  test("a log this process cannot read is a stated failure, not zero events", () => {
    // The other half of F-002, and the more important one. A bound that refuses
    // correctly is worth nothing if the caller in front of it reports the
    // refusal as "this turn produced nothing" — that is the same silence with a
    // different cause, and §Bounds forbids it either way.
    createTurnRecord(record(), configDir);
    appendTurnEvent(event(0), configDir);
    const log = path.join(configDir, "turns", TURN, "events.jsonl");
    const handle = openSync(log, "w", 0o600);
    try {
      ftruncateSync(handle, MAX_TURN_FILE_BYTES + 1);
    } finally {
      closeSync(handle);
    }

    expect(readTurnEvents(TURN, -1, configDir)).toEqual({ ok: false, reason: "too-large" });
  });

  test("a turn with no events yet is empty; a turn with no record says so", () => {
    // Through the raw readers, not `eventsOf`/`recordOf`: this test is about
    // what the result type carries, and unwrapping it would assert nothing.
    //
    // The two answers differ deliberately. A turn whose first event has not been
    // appended has no log, and zero events is the truth about it. A turn with no
    // `turn.json` does not exist, and `absent` says that rather than letting a
    // caller read it as "exists, produced nothing" — which is the distinction
    // the whole result type was introduced for.
    expect(readTurnEvents(TURN, -1, configDir)).toEqual({ ok: true, value: [] });
    expect(readTurnRecord(TURN, configDir)).toEqual({ ok: false, reason: "absent" });
  });
});

describe("the record and its terminal result", () => {
  test("a record round-trips, and carries no result until the turn finishes", () => {
    createTurnRecord(record(), configDir);
    const stored = recordOf(TURN, configDir);
    expect(stored.sessionId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(stored.result).toBeUndefined();
  });

  test("finishing writes the terminal result and preserves the metadata", () => {
    createTurnRecord(record(), configDir);
    const result: TurnResult = {
      schemaVersion: "1.0.0",
      turnId: TURN,
      sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      origin: "remote:http",
      outcome: "completed",
      startedAt: "2026-08-01T20:00:00.000Z",
      finishedAt: "2026-08-01T20:00:05.000Z",
    };
    finishTurn(TURN, result, configDir);

    const stored = recordOf(TURN, configDir);
    expect(stored.result?.outcome).toBe("completed");
    expect(stored.project).toBe("/tmp/project"); // metadata not clobbered
  });

  test("finishing a turn that does not exist writes nothing", () => {
    finishTurn(TURN, {} as TurnResult, configDir);
    expect(existsSync(path.join(configDir, "turns", TURN))).toBe(false);
  });

  test("a record whose id does not match its own path is refused", () => {
    // Otherwise a file moved or hand-edited into another turn's directory
    // answers for a turn it is not.
    createTurnRecord(record(), configDir);
    writeFileSync(
      path.join(configDir, "turns", TURN, "turn.json"),
      JSON.stringify({ ...record(), turnId: OTHER }),
      "utf8",
    );
    // `malformed`, and asserted by reason rather than by absence: a record that
    // answers for a turn it is not is a different failure from one that is not
    // there, and the route turns exactly one of those into a 404.
    expect(readTurnRecord(TURN, configDir)).toEqual({ ok: false, reason: "malformed" });
  });

  test("the record directory is owner-only", () => {
    if (process.platform === "win32") {
      return;
    }
    createTurnRecord(record(), configDir);
    const mode = statSync(path.join(configDir, "turns", TURN)).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test("a pre-existing group-writable turns/ directory is tightened, not accepted", () => {
    // `mkdirSync`'s mode applies at creation only — the defect the writers
    // guard exists for. A `turns/` left 0775 by an earlier release must not
    // survive the next write.
    if (process.platform === "win32") {
      return;
    }
    mkdirSync(path.join(configDir, "turns"), { recursive: true, mode: 0o775 });
    createTurnRecord(record(), configDir);
    expect(statSync(path.join(configDir, "turns")).mode & 0o777).toBe(0o700);
  });
});

describe("idempotency", () => {
  test("the first claim is free and the second returns the original turn", () => {
    expect(claimIdempotencyKey(PROJECT, "key-a", TURN, configDir)).toEqual({ existing: null });
    expect(claimIdempotencyKey(PROJECT, "key-a", OTHER, configDir)).toEqual({ existing: TURN });
  });

  test("the claim survives a restart", () => {
    // AC7. The index is a file, so "restart" is just a fresh call against the
    // same directory with no shared in-memory state — which is exactly what a
    // second process sees. An in-memory map passes every other test here and
    // fails this one.
    claimIdempotencyKey(PROJECT, "key-b", TURN, configDir);
    const afterRestart = claimIdempotencyKey(PROJECT, "key-b", OTHER, configDir);
    expect(afterRestart).toEqual({ existing: TURN });
  });

  test("the same key in two projects is two claims", () => {
    // F-017. The index was GLOBAL: `keyPath` hashed the caller's key and
    // nothing else. One install serves many projects, and two transports
    // drawing keys from the same counter space — a chat message id, a job
    // number — collided. The second project's submission was answered
    // `200 {duplicate: true}` naming the FIRST project's turn, its prompt never
    // ran, and reading that turn handed the caller the other project's result
    // text. Every idempotency test used a single project, so nothing looked.
    expect(claimIdempotencyKey("/projects/a", "daily", TURN, configDir)).toEqual({ existing: null });
    expect(claimIdempotencyKey("/projects/b", "daily", OTHER, configDir)).toEqual({ existing: null });

    // And each still holds its own.
    expect(claimIdempotencyKey("/projects/a", "daily", OTHER, configDir)).toEqual({ existing: TURN });
    expect(claimIdempotencyKey("/projects/b", "daily", TURN, configDir)).toEqual({ existing: OTHER });
  });

  test("a release in one project cannot free another project's claim", () => {
    // The same boundary on the way out. A release is guarded by turnId inside
    // the store; the project scope has to hold independently of that guard.
    claimIdempotencyKey("/projects/a", "shared", TURN, configDir);
    expect(releaseIdempotencyKey("/projects/b", "shared", TURN, configDir)).toBe(false);
    expect(claimIdempotencyKey("/projects/a", "shared", OTHER, configDir)).toEqual({ existing: TURN });
  });

  test("the project/key encoding is injective — no boundary shift collides", () => {
    // `sha256(project + key)` maps ("/a/b", "c") and ("/a", "/bc") to one
    // digest, which would put the collision back somewhere subtler. The digest
    // is over a length-prefixed composite for that reason, and this is the pair
    // that would catch a plain concatenation.
    expect(claimIdempotencyKey("/a/b", "c", TURN, configDir)).toEqual({ existing: null });
    expect(claimIdempotencyKey("/a", "/bc", OTHER, configDir)).toEqual({ existing: null });
    expect(claimIdempotencyKey("/a/b", "c", OTHER, configDir)).toEqual({ existing: TURN });
  });

  test("different keys do not collide", () => {
    claimIdempotencyKey(PROJECT, "key-c", TURN, configDir);
    expect(claimIdempotencyKey(PROJECT, "key-d", OTHER, configDir)).toEqual({ existing: null });
  });

  test("a key is hashed, so it cannot traverse or name a device", () => {
    // An idempotency key is caller-supplied untrusted text and it reaches a
    // path join. The digest is what makes that safe — asserted by using a key
    // that would escape if it were used verbatim.
    const hostile = "../../../../etc/passwd";
    expect(claimIdempotencyKey(PROJECT, hostile, TURN, configDir)).toEqual({ existing: null });

    // Exactly one file, inside the keys directory, named by a hex digest. NOT
    // asserted as "/etc/passwd does not exist" — the first version of this test
    // did that, and it was checking the host's real password file, which exists,
    // so it failed for a reason that had nothing to do with this module.
    const keysDir = path.join(configDir, "turns", "keys");
    const written = readdirSync(keysDir);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^[0-9a-f]{64}\.json$/);

    // And it round-trips, so hashing did not break the feature it protects.
    expect(claimIdempotencyKey(PROJECT, hostile, OTHER, configDir)).toEqual({ existing: TURN });
  });

  test("a damaged index entry is treated as absent rather than as a permanent refusal", () => {
    // Refusing would make one corrupt file a denial of service for whichever
    // key hashes to it, forever.
    claimIdempotencyKey(PROJECT, "key-e", TURN, configDir);
    const keysDir = path.join(configDir, "turns", "keys");
    const entry = path.join(keysDir, readdirSync(keysDir)[0]!);
    writeFileSync(entry, "{not json", "utf8");
    expect(claimIdempotencyKey(PROJECT, "key-e", OTHER, configDir)).toEqual({ existing: null });
    // ...and the claim is repaired, not left damaged.
    expect(claimIdempotencyKey(PROJECT, "key-e", TURN, configDir)).toEqual({ existing: OTHER });
  });

  test("an index entry naming a non-id is ignored", () => {
    claimIdempotencyKey(PROJECT, "key-f", TURN, configDir);
    const keysDir = path.join(configDir, "turns", "keys");
    const entry = path.join(keysDir, readdirSync(keysDir)[0]!);
    writeFileSync(entry, JSON.stringify({ turnId: "../../etc/passwd" }), "utf8");
    expect(claimIdempotencyKey(PROJECT, "key-f", OTHER, configDir)).toEqual({ existing: null });
  });
});

describe("listTurnIds", () => {
  test("lists only well-formed ids, sorted", () => {
    createTurnRecord(record(OTHER), configDir);
    createTurnRecord(record(), configDir);
    mkdirSync(path.join(configDir, "turns", "keys"), { recursive: true });
    mkdirSync(path.join(configDir, "turns", "not-a-turn"), { recursive: true });
    expect(listTurnIds(configDir)).toEqual([TURN, OTHER].sort());
  });

  test("an absent turns directory lists nothing", () => {
    expect(listTurnIds(configDir)).toEqual([]);
  });
});

describe("an append does not re-walk the directory it already has", () => {
  test("the fast path leaves the parent directory untouched", () => {
    // The observable difference, and the only honest way to see it from out
    // here: `ensureTurnDir` re-asserts 0700 on every level it walks, so a parent
    // left at another mode is restored if the walk ran and stays put if it did
    // not. This asserts it stays put — which IS the tradeoff, stated rather
    // than hidden: `createTurnRecord` establishes the mode once per turn, and
    // `appendOwnerOnlyLine` still chmods the events file on every append.
    createTurnRecord(record(), configDir);
    const turns = path.join(configDir, "turns");
    chmodSync(turns, 0o755);

    expect(appendTurnEvent(event(0), configDir)).toBe(true);

    expect(statSync(turns).mode & 0o777).toBe(0o755);
    // The event landed, and the file it landed in is still owner-only.
    expect(eventsOf(TURN)).toHaveLength(1);
    const log = path.join(turns, TURN, "events.jsonl");
    expect(statSync(log).mode & 0o777).toBe(0o600);
  });

  test("an append whose directory has vanished recreates it and lands", () => {
    // The ENOENT retry — the one case where the walk was doing something. A
    // turn directory removed underneath a live turn, which is what an operator
    // clearing state during a run produces.
    createTurnRecord(record(), configDir);
    appendTurnEvent(event(0), configDir);
    rmSync(path.join(configDir, "turns", TURN), { recursive: true, force: true });

    expect(appendTurnEvent(event(1), configDir)).toBe(true);

    // The earlier event is gone with the directory — this is recovery, not
    // resurrection — and the new one is readable.
    expect(eventsOf(TURN).map((e) => e.seq)).toEqual([1]);
    // Recreated through the sanctioned helper, so the mode is right again.
    expect(statSync(path.join(configDir, "turns", TURN)).mode & 0o777).toBe(0o700);
  });

  test("an append with no record at all still creates its directory", () => {
    // `createTurnRecord` is the normal creator, but nothing in the type system
    // requires it to have run. Before the optimistic path this worked because
    // every append walked; it has to keep working.
    expect(appendTurnEvent(event(0), configDir)).toBe(true);
    expect(eventsOf(TURN)).toHaveLength(1);
  });

  test("an error that is NOT ENOENT propagates rather than being retried", () => {
    // A permission fault retried is a second, identical permission fault. The
    // events path is made a DIRECTORY, so the append fails with EISDIR — a real
    // errno from the real filesystem, not a stubbed throw.
    createTurnRecord(record(), configDir);
    mkdirSync(path.join(configDir, "turns", TURN, "events.jsonl"), { recursive: true });

    expect(() => appendTurnEvent(event(0), configDir)).toThrow();
  });
});

describe("the read-failure taxonomy has one owner", () => {
  // F-012. Six reasons, and five call sites each deciding for themselves which
  // of them meant "this process failed" — with the sixth reason arriving after
  // four of them were written. `isServerFault` is the decision, in one place.
  test("every reason is classified, and the classification is the one the routes want", () => {
    const REASONS: Record<TurnReadFailure, boolean> = {
      // Answers about the request. All 404, indistinguishably.
      absent: false,
      "not-a-turn-id": false,
      malformed: false,
      // A file IS there and this process would not read it.
      "not-regular": true,
      "too-large": true,
      unreadable: true,
    };
    for (const [reason, fault] of Object.entries(REASONS)) {
      expect({ reason, fault: isServerFault(reason as TurnReadFailure) }).toEqual({ reason, fault });
    }
    // The map is exhaustive by TYPE — `Record<TurnReadFailure, boolean>` will
    // not compile if a reason is missing — and this pins that both sides are
    // non-empty, so a predicate that answered a constant would fail here.
    expect(Object.values(REASONS).filter(Boolean)).toHaveLength(3);
    expect(Object.values(REASONS).filter((v) => !v)).toHaveLength(3);
  });

  test("isDefiniteAbsence is the OTHER question, and disagrees on malformed", () => {
    // Two questions, not one predicate with one caller. Round three counted the
    // callers correctly and concluded the other sites should route through
    // `isServerFault`; they must not. A route asking "404 or 500" and a caller
    // asking "may I answer at all" want opposite answers for `malformed`, and
    // routing the second through the first puts back the
    // `200 {duplicate:true, sessionId:""}` this flow removed.
    const ABSENCE: Record<TurnReadFailure, boolean> = {
      absent: true,
      "not-a-turn-id": false,
      malformed: false,
      "not-regular": false,
      "too-large": false,
      unreadable: false,
    };
    for (const [reason, definite] of Object.entries(ABSENCE)) {
      expect({ reason, definite: isDefiniteAbsence(reason as TurnReadFailure) }).toEqual({
        reason,
        definite,
      });
    }

    // Two independent properties, pinned so that neither predicate can be
    // quietly rewritten in terms of the other — which is the shape of the
    // finding that produced them.
    const reasons = Object.keys(ABSENCE) as TurnReadFailure[];

    // (1) Not the same function: some reason where they differ.
    expect(reasons.filter((r) => isServerFault(r) !== isDefiniteAbsence(r))).not.toEqual([]);

    // (2) Not complements either: some reason where BOTH are false. This is the
    // trap. `malformed` is not a server fault (a route answers 404, because an
    // unknown id and a malformed one must be indistinguishable) and is not a
    // definite absence (a caller may not say "no such turn" about a record it
    // simply could not read). Neither predicate can be written as the negation
    // of the other, and a round that tried to route every site through one of
    // them would have broken whichever caller needed the other.
    expect(reasons.filter((r) => !isServerFault(r) && !isDefiniteAbsence(r))).toEqual([
      "not-a-turn-id",
      "malformed",
    ]);
  });
});
