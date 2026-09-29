// R4d (flow 369): approvals outlive the process, and an approval nobody can
// answer is denied at once rather than left to time out.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, readdirSync } from "node:fs";
import path from "node:path";
import { resolveLocalProfile } from "../harness/policy/profiles";
import { createApprovalBroker } from "./serve-approvals-broker";
import {
  answerApproval,
  consumeApproval,
  createApproval,
  listApprovals,
  newApprovalId,
  readApproval,
  readApprovalEvidence,
  reconcileApprovals,
} from "./serve-approvals-store";
import { CountingExecutor, makeDirs, registryOf, ScriptedProvider, tool, waitFor, type Dirs } from "./serve-approvals.test-helpers";
import { runRemoteTurn } from "./serve-turn";
import { createTurnRecord, readTurnEvents, readTurnRecord } from "./serve-turn-store";

let dirs: Dirs;
let executor: CountingExecutor;

beforeEach(() => {
  dirs = makeDirs();
  executor = new CountingExecutor();
});
afterEach(() => dirs.cleanup());

function brokerWith(overrides: Partial<Parameters<typeof createApprovalBroker>[0]> = {}) {
  return createApprovalBroker({
    dir: dirs.configDir,
    expirySeconds: 300,
    maxPending: 4,
    requireConsumer: false,
    hasConsumer: () => true,
    pollMs: 5,
    ...overrides,
  });
}

function turn(approvals: ReturnType<typeof brokerWith>, extra: Partial<Parameters<typeof runRemoteTurn>[0]> = {}) {
  return runRemoteTurn({
    request: { schemaVersion: "1.0.0", project: dirs.project, prompt: "write a note" },
    project: dirs.project,
    profile: resolveLocalProfile("unattended-untrusted"),
    provider: new ScriptedProvider([{ id: "call-1", name: "write_note", input: '{"body":"x"}' }]),
    providerName: "scripted-stub",
    model: "stub-model",
    dir: dirs.configDir,
    scanRoot: dirs.configDir,
    toolRegistry: registryOf(tool("write_note", "write")),
    toolExecutor: executor,
    containmentAvailable: () => true,
    hooksEnv: { KERYX_HOOKS: "off" },
    approvals,
    ...extra,
  });
}

function seedPending(turnId = randomUUID()): string {
  const id = newApprovalId();
  createApproval(
    { approvalId: id, turnId, sessionId: randomUUID(), summary: "Run tool", scope: "This call only", consequence: "Writes", expiresAt: new Date(Date.now() + 300_000), correlationId: randomUUID(), callFingerprint: "a".repeat(64), floors: [] },
    dirs.configDir,
  );
  return id;
}

describe("pending records survive a restart", () => {
  test("a record written by one process is listed, pending, by the next", () => {
    const id = seedPending();
    const view = readApproval(id, dirs.configDir);
    expect(view.ok && view.value.state).toBe("pending");
    expect(listApprovals(dirs.configDir).map((entry) => entry.approvalId)).toEqual([id]);
  });

  test("a pending record whose turn is still live is left pending by startup reconciliation", () => {
    const turnId = randomUUID();
    const id = seedPending(turnId);
    reconcileApprovals(dirs.configDir, { isTurnLive: (candidate) => candidate === turnId });
    const view = readApproval(id, dirs.configDir);
    expect(view.ok && view.value.state).toBe("pending");
  });
});

describe("a restart resolves what nothing can answer, and never re-executes it", () => {
  test("a pending record whose turn no longer exists becomes an expired deny with the reason on record", () => {
    const id = seedPending();
    const report = reconcileApprovals(dirs.configDir, { isTurnLive: () => false });
    expect(report).toBeDefined();
    const view = readApproval(id, dirs.configDir);
    expect(view.ok && view.value.state).toBe("expired");
    expect(view.ok && view.value.reason).toBe("turn-not-running-at-startup");
    expect(readApprovalEvidence(dirs.configDir).some((event) => event.approvalId === id && event.kind === "resolved" && event.state === "expired")).toBe(true);
  });

  test("the turn stranded on that approval is finished, so it stops reporting running", () => {
    const turnId = randomUUID();
    const startedAt = new Date(Date.now() - 1000).toISOString();
    createTurnRecord({ turnId, sessionId: randomUUID(), project: dirs.project, origin: "remote:test", startedAt }, dirs.configDir);
    const id = seedPending(turnId);
    reconcileApprovals(dirs.configDir, { isTurnLive: () => false });
    const record = readTurnRecord(turnId, dirs.configDir);
    expect(record.ok && record.value.result?.outcome).toBe("expired");
    expect(record.ok && record.value.result?.reasonCode).toBe("turn-not-running-at-startup");
    expect(record.ok && record.value.result?.approvals).toEqual([{ approvalId: id, resolution: "expired" }]);
  });

  test("an answer after that restart is refused, and the call was never executed", () => {
    const id = seedPending();
    reconcileApprovals(dirs.configDir, { isTurnLive: () => false });
    expect(answerApproval(id, "allow", "late", dirs.configDir).kind).toBe("expired");
    expect(consumeApproval(id, "a".repeat(64), dirs.configDir)).toBe("not-allowed");
    expect(executor.names).toEqual([]);
  });

  test("a turn still waiting in an older process sees the restart's expiry and denies; the call never runs", async () => {
    const running = turn(brokerWith());
    await waitFor(() => listApprovals(dirs.configDir).length === 1);
    reconcileApprovals(dirs.configDir, { isTurnLive: () => false });
    const run = await running;
    expect(executor.names).toEqual([]);
    expect(run.result.outcome).toBe("denied");
    expect(run.result.approvals?.[0]?.resolution).toBe("expired");
  });
});

describe("a delivery failure resolves as undeliverable immediately", () => {
  test("no consumer attached while requireConsumer is true", async () => {
    const started = Date.now();
    const run = await turn(brokerWith({ requireConsumer: true, hasConsumer: () => false }));
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(executor.names).toEqual([]);
    expect(run.result.outcome).toBe("denied");
    expect(run.result.reasonCode).toBe("approval-undeliverable");
    const record = listApprovals(dirs.configDir)[0]!;
    expect(record.state).toBe("undeliverable");
    expect(record.reason).toBe("no-consumer-attached");
    expect(run.result.approvals).toEqual([{ approvalId: record.approvalId, resolution: "undeliverable" }]);
    const events = readTurnEvents(run.turnId, -1, dirs.configDir);
    expect(events.ok && events.value.some((event) => event.kind === "approval.pending")).toBe(false);
  });

  test("requireConsumer false lets an approval wait with nobody attached", async () => {
    const running = turn(brokerWith({ requireConsumer: false, hasConsumer: () => false }));
    await waitFor(() => listApprovals(dirs.configDir).length === 1);
    expect(listApprovals(dirs.configDir)[0]!.state).toBe("pending");
    answerApproval(listApprovals(dirs.configDir)[0]!.approvalId, "deny", "test", dirs.configDir);
    await running;
  });

  test("the pending event cannot be appended", async () => {
    const running = turn(brokerWith(), {
      onEffect: () => {
        const turnsRoot = path.join(dirs.configDir, "turns");
        const only = listTurnDirs(turnsRoot);
        chmodSync(path.join(turnsRoot, only, "events.jsonl"), 0o400);
      },
    });
    running.catch(() => undefined);
    await waitFor(() => listApprovals(dirs.configDir).length === 1 && listApprovals(dirs.configDir)[0]!.state !== "pending");
    const record = listApprovals(dirs.configDir)[0]!;
    expect(record.state).toBe("undeliverable");
    expect(record.reason).toBe("delivery-failed");
    expect(executor.names).toEqual([]);
    chmodSync(path.join(dirs.configDir, "turns", listTurnDirs(path.join(dirs.configDir, "turns")), "events.jsonl"), 0o600);
    await running.then(
      () => undefined,
      () => undefined,
    );
  });

  test("the broker itself denies when delivery throws", async () => {
    const broker = brokerWith();
    const outcome = await broker.request({
      turnId: randomUUID(),
      sessionId: randomUUID(),
      toolName: "write_note",
      risk: "write",
      callFingerprint: "a".repeat(64),
      floors: [],
      deliver: () => {
        throw new Error("no way to deliver");
      },
      resolved: () => undefined,
    });
    expect(outcome).toMatchObject({ approved: false, resolution: "undeliverable", reason: "delivery-failed" });
  });
});

describe("every resolution appends an evidence event", () => {
  test("allowed, denied, expired and undeliverable each leave a created and a resolved line", async () => {
    const allowed = turn(brokerWith());
    await waitFor(() => listApprovals(dirs.configDir).length === 1);
    answerApproval(listApprovals(dirs.configDir)[0]!.approvalId, "allow", "test", dirs.configDir);
    await allowed;

    const denied = turn(brokerWith());
    await waitFor(() => listApprovals(dirs.configDir).length === 2);
    answerApproval(listApprovals(dirs.configDir).find((entry) => entry.state === "pending")!.approvalId, "deny", "test", dirs.configDir);
    await denied;

    await turn(brokerWith({ expirySeconds: 0.03 }));
    await turn(brokerWith({ requireConsumer: true, hasConsumer: () => false }));

    const records = listApprovals(dirs.configDir);
    expect(records.map((entry) => entry.state).sort()).toEqual(["allowed", "denied", "expired", "undeliverable"]);
    const evidence = readApprovalEvidence(dirs.configDir);
    for (const record of records) {
      const mine = evidence.filter((event) => event.approvalId === record.approvalId);
      expect(mine.filter((event) => event.kind === "created")).toHaveLength(1);
      expect(mine.filter((event) => event.kind === "resolved")).toHaveLength(1);
      expect(mine.find((event) => event.kind === "resolved")?.state).toBe(record.state);
    }
    expect(evidence.filter((event) => event.kind === "consumed")).toHaveLength(1);
  });
});

function listTurnDirs(turnsRoot: string): string {
  return readdirSync(turnsRoot).filter((name) => !name.startsWith("."))[0] ?? "";
}
