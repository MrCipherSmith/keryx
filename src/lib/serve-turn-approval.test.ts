// R4d (flow 369): an `ask` inside a serve turn becomes a durable pending
// approval, the turn waits, and it continues on an answer. Expiry and the
// per-session bound deny.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolveLocalProfile } from "../harness/policy/profiles";
import { createApprovalBroker, type ApprovalBroker } from "./serve-approvals-broker";
import { answerApproval, listApprovals, readApproval } from "./serve-approvals-store";
import { CountingExecutor, makeDirs, registryOf, ScriptedProvider, tool, waitFor, type Dirs } from "./serve-approvals.test-helpers";
import { runRemoteTurn, type RunTurnInput, type TurnRequest } from "./serve-turn";
import { readTurnEvents, readTurnRecord, type StreamEvent } from "./serve-turn-store";

let dirs: Dirs;
let executor: CountingExecutor;

beforeEach(() => {
  dirs = makeDirs();
  executor = new CountingExecutor();
});
afterEach(() => dirs.cleanup());

function broker(overrides: Partial<Parameters<typeof createApprovalBroker>[0]> = {}): ApprovalBroker {
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

function turn(approvals: ApprovalBroker | undefined, request: Partial<TurnRequest> = {}, extra: Partial<RunTurnInput> = {}) {
  return runRemoteTurn({
    request: { schemaVersion: "1.0.0", project: dirs.project, prompt: "write a note", ...request },
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
    ...(approvals !== undefined ? { approvals } : {}),
    ...extra,
  });
}

function eventsOf(turnId: string): StreamEvent[] {
  const read = readTurnEvents(turnId, -1, dirs.configDir);
  if (!read.ok) {
    throw new Error(`events unreadable: ${read.reason}`);
  }
  return read.value;
}

async function firstPending(): Promise<string> {
  await waitFor(() => listApprovals(dirs.configDir).length > 0);
  return listApprovals(dirs.configDir)[0]!.approvalId;
}

describe("an ask creates a pending record, waits, and continues on an answer", () => {
  test("the record is pending and the event is on the stream while nothing has run", async () => {
    const running = turn(broker());
    const id = await firstPending();
    const record = readApproval(id, dirs.configDir);
    expect(record.ok && record.value.state).toBe("pending");
    expect(executor.names).toEqual([]);

    const turnId = record.ok ? record.value.turnId : "";
    const events = eventsOf(turnId);
    expect(events.find((event) => event.kind === "approval.pending")?.approvalId).toBe(id);
    expect(events.some((event) => event.terminal === true)).toBe(false);

    answerApproval(id, "deny", "test", dirs.configDir);
    await running;
  });

  test("an allow lets the call run exactly once and the turn completes with the resolution recorded", async () => {
    const running = turn(broker());
    const id = await firstPending();
    answerApproval(id, "allow", "test", dirs.configDir);
    const run = await running;

    expect(executor.invocations).toEqual([{ tool: "write_note", input: { body: "x" } }]);
    expect(run.result.outcome).toBe("completed");
    expect(run.result.approvals).toEqual([{ approvalId: id, resolution: "allowed" }]);
    const events = eventsOf(run.turnId);
    expect(events.find((event) => event.kind === "approval.resolved")).toMatchObject({ approvalId: id, resolution: "allowed" });
    expect(events.at(-1)).toMatchObject({ kind: "turn.finished", terminal: true });
    expect(readTurnRecord(run.turnId, dirs.configDir).ok).toBe(true);
  });

  test("a deny ends the turn denied and nothing runs", async () => {
    const running = turn(broker());
    const id = await firstPending();
    answerApproval(id, "deny", "test", dirs.configDir);
    const run = await running;

    expect(executor.names).toEqual([]);
    expect(run.result.outcome).toBe("denied");
    expect(run.result.reasonCode).toBe("approval-denied");
    expect(run.result.approvals).toEqual([{ approvalId: id, resolution: "denied" }]);
  });

  test("the record carries a summary that names the tool and never the arguments", async () => {
    const running = turn(broker(), {}, {
      provider: new ScriptedProvider([{ id: "call-1", name: "write_note", input: '{"body":"SECRET-ARGUMENT-VALUE"}' }]),
    });
    const id = await firstPending();
    const raw = JSON.stringify(readApproval(id, dirs.configDir));
    expect(raw).toContain("write_note");
    expect(raw).not.toContain("SECRET-ARGUMENT-VALUE");
    answerApproval(id, "deny", "test", dirs.configDir);
    await running;
  });
});

describe("expiry and the per-session bound", () => {
  test("no answer by expiry denies the call, and the record says expired", async () => {
    const run = await turn(broker({ expirySeconds: 0.05 }));
    expect(executor.names).toEqual([]);
    expect(run.result.outcome).toBe("denied");
    expect(run.result.reasonCode).toBe("approval-expired");
    const record = listApprovals(dirs.configDir)[0];
    expect(record?.state).toBe("expired");
    expect(run.result.approvals).toEqual([{ approvalId: record!.approvalId, resolution: "expired" }]);
  });

  test("an answer that arrives after expiry cannot revive the call", async () => {
    const run = await turn(broker({ expirySeconds: 0.05 }));
    const id = listApprovals(dirs.configDir)[0]!.approvalId;
    expect(answerApproval(id, "allow", "late", dirs.configDir).kind).toBe("expired");
    expect(executor.names).toEqual([]);
    expect(run.result.outcome).toBe("denied");
  });

  test("a second ask past maxPendingPerSession is denied immediately, without waiting", async () => {
    const shared = broker({ maxPending: 1 });
    const sessionId = randomUUID();
    const first = turn(shared, { sessionId });
    const firstId = await firstPending();

    const started = Date.now();
    const second = await turn(shared, { sessionId });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(second.result.outcome).toBe("denied");
    expect(second.result.reasonCode).toBe("approval-limit-exceeded");
    expect(executor.names).toEqual([]);
    expect(listApprovals(dirs.configDir).filter((entry) => entry.state === "pending").map((entry) => entry.approvalId)).toEqual([firstId]);

    answerApproval(firstId, "allow", "test", dirs.configDir);
    await first;
    expect(executor.names).toEqual(["write_note"]);
  });

  test("the bound is per session: another session still gets its own approval", async () => {
    const shared = broker({ maxPending: 1 });
    const first = turn(shared, { sessionId: randomUUID() });
    await firstPending();
    const second = turn(shared, { sessionId: randomUUID() });
    await waitFor(() => listApprovals(dirs.configDir).length === 2);
    for (const entry of listApprovals(dirs.configDir)) {
      answerApproval(entry.approvalId, "deny", "test", dirs.configDir);
    }
    await Promise.all([first, second]);
  });
});

describe("without a broker the old boundary stands", () => {
  test("the ask is still denied with the release-boundary reason", async () => {
    const run = await turn(undefined);
    expect(run.result.outcome).toBe("denied");
    expect(run.result.reasonCode).toBe("approvals-not-implemented-in-this-release");
    expect(executor.names).toEqual([]);
  });
});
