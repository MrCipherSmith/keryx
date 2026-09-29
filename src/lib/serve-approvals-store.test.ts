// The durable approval store (flow 369 / R4d).
//
// These are statements about what survives the process and what can be written
// exactly once, so every assertion reads the files back rather than trusting the
// return value of the call that wrote them.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateAgainstSchema } from "../contracts/validator";
import {
  answerApproval,
  consumeApproval,
  countPending,
  createApproval,
  listApprovals,
  readApproval,
  readApprovalEvidence,
  reconcileApprovals,
  resolveApproval,
  toPublicApproval,
  type NewApproval,
} from "./serve-approvals-store";

const SCHEMA_DIR = path.join(import.meta.dir, "..", "..", "docs", "requirements", "keryx-remote-entry", "schemas");
const T0 = new Date("2026-09-29T10:00:00.000Z");
const later = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

let dir = "";
const FINGERPRINT = "a".repeat(64);
const SECRET_ARGUMENT = "rm -rf /very/secret/path --token=hunter2";

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-r4d-store-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fresh(overrides: Partial<NewApproval> = {}): NewApproval {
  return {
    approvalId: randomUUID(),
    turnId: randomUUID(),
    sessionId: randomUUID(),
    summary: 'Run tool "write_note" (risk: write)',
    scope: "one call, this turn only",
    consequence: "The tool runs once with the arguments already proposed.",
    expiresAt: later(300),
    correlationId: randomUUID(),
    callFingerprint: FINGERPRINT,
    floors: [],
    ...overrides,
  };
}

function viewOf(id: string) {
  const read = readApproval(id, dir, T0);
  if (!read.ok) {
    throw new Error(`could not read ${id}: ${read.reason}`);
  }
  return read.value;
}

describe("creation", () => {
  test("a created record is pending and readable", () => {
    const input = fresh();
    createApproval(input, dir, T0);
    const view = viewOf(input.approvalId);
    expect(view.state).toBe("pending");
    expect(view.turnId).toBe(input.turnId);
    expect(view.expiresAt).toBe(later(300).toISOString());
    expect(view.createdAt).toBe(T0.toISOString());
  });

  test("the public projection validates against pending-approval.schema.json", () => {
    const input = fresh();
    createApproval(input, dir, T0);
    const projection = toPublicApproval(viewOf(input.approvalId));
    const result = validateAgainstSchema("pending-approval.schema.json", projection, { schemaDir: SCHEMA_DIR });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("a resolved record still validates, with resolvedAt and answeredBy", () => {
    const input = fresh();
    createApproval(input, dir, T0);
    answerApproval(input.approvalId, "allow", "remote-token", dir, later(5));
    const projection = toPublicApproval(viewOf(input.approvalId));
    expect(projection.state).toBe("allowed");
    expect(projection.resolvedAt).toBe(later(5).toISOString());
    expect(projection.answeredBy).toBe("remote-token");
    expect(validateAgainstSchema("pending-approval.schema.json", projection, { schemaDir: SCHEMA_DIR }).valid).toBe(true);
  });

  test("the fingerprint and floors never appear in the public projection", () => {
    const input = fresh({ floors: ["destructive"] });
    createApproval(input, dir, T0);
    const text = JSON.stringify(toPublicApproval(viewOf(input.approvalId)));
    expect(text).not.toContain(FINGERPRINT);
    expect(text).not.toContain("destructive");
    expect(text).not.toContain("callFingerprint");
  });

  test("summary, scope and consequence are bounded to the schema", () => {
    const input = fresh({ summary: "s".repeat(2000), scope: "c".repeat(2000), consequence: "q".repeat(2000) });
    createApproval(input, dir, T0);
    const projection = toPublicApproval(viewOf(input.approvalId));
    expect(projection.summary.length).toBeLessThanOrEqual(500);
    expect(projection.scope.length).toBeLessThanOrEqual(300);
    expect(projection.consequence.length).toBeLessThanOrEqual(300);
    expect(validateAgainstSchema("pending-approval.schema.json", projection, { schemaDir: SCHEMA_DIR }).valid).toBe(true);
  });

  test("nothing on disk carries the arguments of the call", () => {
    createApproval(fresh({ summary: 'Run tool "shell_exec" (risk: execute)' }), dir, T0);
    const root = path.join(dir, "approvals");
    for (const name of readdirSync(root)) {
      expect(readFileSync(path.join(root, name), "utf8")).not.toContain(SECRET_ARGUMENT);
    }
  });

  test("an id that is not a uuid is refused before it becomes a path", () => {
    expect(() => createApproval(fresh({ approvalId: "../../etc/passwd" }), dir, T0)).toThrow();
    const read = readApproval("../../etc/passwd", dir, T0);
    expect(read.ok).toBe(false);
  });

  test("an unknown id reads as absent", () => {
    const read = readApproval(randomUUID(), dir, T0);
    expect(read).toEqual({ ok: false, reason: "absent" });
  });

  test("files and directory are owner-only", () => {
    const input = fresh();
    createApproval(input, dir, T0);
    answerApproval(input.approvalId, "allow", "remote-token", dir, later(1));
    const root = path.join(dir, "approvals");
    expect(statSync(root).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(root)) {
      expect({ name, mode: statSync(path.join(root, name)).mode & 0o777 }).toEqual({ name, mode: 0o600 });
    }
  });

  test("no temporary file is left behind", () => {
    createApproval(fresh(), dir, T0);
    expect(readdirSync(path.join(dir, "approvals")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("a resolution is written exactly once", () => {
  test("the first resolution wins and the second reads the first", () => {
    const input = fresh();
    createApproval(input, dir, T0);
    const first = resolveApproval(input.approvalId, { state: "allowed", answeredBy: "a" }, dir, later(1));
    const second = resolveApproval(input.approvalId, { state: "denied", answeredBy: "b" }, dir, later(2));
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.view.state).toBe("allowed");
    expect(viewOf(input.approvalId).answeredBy).toBe("a");
  });

  test("two racing answers apply once", () => {
    const input = fresh();
    createApproval(input, dir, T0);
    const outcomes = [
      answerApproval(input.approvalId, "allow", "remote-token", dir, later(1)),
      answerApproval(input.approvalId, "deny", "remote-token", dir, later(1)),
    ];
    expect(outcomes.map((o) => o.kind)).toEqual(["applied", "replay"]);
    expect(outcomes[1]?.view?.state).toBe("allowed");
  });

  test("a replay returns the original outcome and appends no second resolution", () => {
    const input = fresh();
    createApproval(input, dir, T0);
    answerApproval(input.approvalId, "deny", "remote-token", dir, later(1));
    const replay = answerApproval(input.approvalId, "allow", "remote-token", dir, later(2));
    expect(replay.kind).toBe("replay");
    expect(replay.view?.state).toBe("denied");
    const resolutions = readApprovalEvidence(dir).filter((e) => e.kind === "resolved" && e.approvalId === input.approvalId);
    expect(resolutions).toHaveLength(1);
  });

  test("an unknown id is not-found", () => {
    expect(answerApproval(randomUUID(), "allow", "remote-token", dir, T0).kind).toBe("not-found");
  });
});

describe("expiry", () => {
  test("an answer after expiry is expired and the record is denied", () => {
    const input = fresh({ expiresAt: later(60) });
    createApproval(input, dir, T0);
    const outcome = answerApproval(input.approvalId, "allow", "remote-token", dir, later(61));
    expect(outcome.kind).toBe("expired");
    expect(outcome.view?.state).toBe("expired");
    expect(viewOf(input.approvalId).state).toBe("expired");
  });

  test("an answer just before expiry is applied", () => {
    const input = fresh({ expiresAt: later(60) });
    createApproval(input, dir, T0);
    expect(answerApproval(input.approvalId, "allow", "remote-token", dir, later(59)).kind).toBe("applied");
  });

  test("listing sweeps due records to expired", () => {
    const input = fresh({ expiresAt: later(10) });
    createApproval(input, dir, T0);
    const listed = listApprovals(dir, { now: later(11) });
    expect(listed.find((v) => v.approvalId === input.approvalId)?.state).toBe("expired");
    expect(countPending(dir, undefined, later(11))).toBe(0);
  });

  test("an expired record can never be consumed", () => {
    const input = fresh({ expiresAt: later(10) });
    createApproval(input, dir, T0);
    listApprovals(dir, { now: later(11) });
    expect(consumeApproval(input.approvalId, FINGERPRINT, dir)).toBe("not-allowed");
  });
});

describe("consumption is at most once", () => {
  test("an allowed approval is consumed once, then never again", () => {
    const input = fresh();
    createApproval(input, dir, T0);
    answerApproval(input.approvalId, "allow", "remote-token", dir, later(1));
    expect(consumeApproval(input.approvalId, FINGERPRINT, dir)).toBe("consumed");
    expect(consumeApproval(input.approvalId, FINGERPRINT, dir)).toBe("already-consumed");
  });

  test("a different fingerprint is refused and does not burn the approval", () => {
    const input = fresh();
    createApproval(input, dir, T0);
    answerApproval(input.approvalId, "allow", "remote-token", dir, later(1));
    expect(consumeApproval(input.approvalId, "b".repeat(64), dir)).toBe("fingerprint-mismatch");
    expect(consumeApproval(input.approvalId, FINGERPRINT, dir)).toBe("consumed");
  });

  test("a pending or denied approval cannot be consumed", () => {
    const pending = fresh();
    const denied = fresh();
    createApproval(pending, dir, T0);
    createApproval(denied, dir, T0);
    answerApproval(denied.approvalId, "deny", "remote-token", dir, later(1));
    expect(consumeApproval(pending.approvalId, FINGERPRINT, dir)).toBe("not-allowed");
    expect(consumeApproval(denied.approvalId, FINGERPRINT, dir)).toBe("not-allowed");
  });

  test("consumption survives a fresh read of the directory (a restart)", () => {
    const input = fresh();
    createApproval(input, dir, T0);
    answerApproval(input.approvalId, "allow", "remote-token", dir, later(1));
    consumeApproval(input.approvalId, FINGERPRINT, dir);
    expect(viewOf(input.approvalId).consumed).toBe(true);
    expect(consumeApproval(input.approvalId, FINGERPRINT, dir)).toBe("already-consumed");
  });
});

describe("the evidence ledger", () => {
  test("every transition appends an event", () => {
    const input = fresh();
    createApproval(input, dir, T0);
    answerApproval(input.approvalId, "allow", "remote-token", dir, later(1));
    consumeApproval(input.approvalId, FINGERPRINT, dir);
    const kinds = readApprovalEvidence(dir)
      .filter((e) => e.approvalId === input.approvalId)
      .map((e) => e.kind);
    expect(kinds).toEqual(["created", "resolved", "consumed"]);
  });

  test("an event carries no fingerprint and no arguments", () => {
    createApproval(fresh(), dir, T0);
    const text = readFileSync(path.join(dir, "approvals", "events.jsonl"), "utf8");
    expect(text).not.toContain(FINGERPRINT);
    expect(text).not.toContain(SECRET_ARGUMENT);
  });

  test("the ledger is append-only: earlier lines are unchanged by later ones", () => {
    const input = fresh();
    createApproval(input, dir, T0);
    const before = readFileSync(path.join(dir, "approvals", "events.jsonl"), "utf8");
    answerApproval(input.approvalId, "deny", "remote-token", dir, later(1));
    const after = readFileSync(path.join(dir, "approvals", "events.jsonl"), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });

  test("a resolution records its reason", () => {
    const input = fresh();
    createApproval(input, dir, T0);
    resolveApproval(input.approvalId, { state: "undeliverable", reason: "no-consumer-attached" }, dir, later(1));
    const event = readApprovalEvidence(dir).find((e) => e.kind === "resolved");
    expect(event?.state).toBe("undeliverable");
    expect(event?.reason).toBe("no-consumer-attached");
  });
});

describe("counting and listing", () => {
  test("countPending is per session when asked", () => {
    const sessionId = randomUUID();
    createApproval(fresh({ sessionId }), dir, T0);
    createApproval(fresh({ sessionId }), dir, T0);
    createApproval(fresh(), dir, T0);
    expect(countPending(dir, sessionId, T0)).toBe(2);
    expect(countPending(dir, undefined, T0)).toBe(3);
  });

  test("a resolved record is no longer pending", () => {
    const input = fresh();
    createApproval(input, dir, T0);
    answerApproval(input.approvalId, "deny", "remote-token", dir, later(1));
    expect(countPending(dir, undefined, later(1))).toBe(0);
  });

  test("listing an empty store is empty", () => {
    expect(listApprovals(dir, { now: T0 })).toEqual([]);
  });
});

describe("reconciliation at startup", () => {
  test("a pending record whose turn is gone resolves as expired with a reason, and is never consumable", () => {
    const input = fresh();
    createApproval(input, dir, T0);
    const report = reconcileApprovals(dir, { isTurnLive: () => false, now: later(1) });
    expect(report.expired).toEqual([input.approvalId]);
    const view = viewOf(input.approvalId);
    expect(view.state).toBe("expired");
    expect(view.reason).toBe("turn-not-running-at-startup");
    expect(consumeApproval(input.approvalId, FINGERPRINT, dir)).toBe("not-allowed");
  });

  test("a pending record whose turn is live is left alone", () => {
    const input = fresh();
    createApproval(input, dir, T0);
    reconcileApprovals(dir, { isTurnLive: (turnId) => turnId === input.turnId, now: later(1) });
    expect(viewOf(input.approvalId).state).toBe("pending");
  });

  test("an allowed but unconsumed record whose turn is gone is closed, never executed", () => {
    const input = fresh();
    createApproval(input, dir, T0);
    answerApproval(input.approvalId, "allow", "remote-token", dir, later(1));
    const report = reconcileApprovals(dir, { isTurnLive: () => false, now: later(2) });
    expect(report.abandoned).toEqual([input.approvalId]);
    expect(consumeApproval(input.approvalId, FINGERPRINT, dir)).toBe("already-consumed");
  });

  test("reconciling twice changes nothing the second time", () => {
    const input = fresh();
    createApproval(input, dir, T0);
    reconcileApprovals(dir, { isTurnLive: () => false, now: later(1) });
    const second = reconcileApprovals(dir, { isTurnLive: () => false, now: later(2) });
    expect(second.expired).toEqual([]);
    expect(second.abandoned).toEqual([]);
  });

  test("reconciliation appends an evidence event for the resolution", () => {
    const input = fresh();
    createApproval(input, dir, T0);
    reconcileApprovals(dir, { isTurnLive: () => false, now: later(1) });
    const event = readApprovalEvidence(dir).find((e) => e.kind === "resolved" && e.approvalId === input.approvalId);
    expect(event?.state).toBe("expired");
    expect(event?.reason).toBe("turn-not-running-at-startup");
  });
});
