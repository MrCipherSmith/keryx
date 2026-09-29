// R4d (flow 369): what an allow is worth. It is bound to ONE call, used ONCE, and
// never lifts a floor or overrides a deny. The floors are evaluated before an
// answer is consulted, so a floored or denied call never reaches the approver.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { HarnessConfig } from "../harness/config";
import { resolveLocalProfile } from "../harness/policy/profiles";
import { runOffline, type ApprovalRequest, type RunDeps } from "../harness/run/run";
import type { HarnessRunInput } from "../harness/types";
import { createApprovalBroker, type ApprovalBroker } from "./serve-approvals-broker";
import {
  answerApproval,
  consumeApproval,
  createApproval,
  listApprovals,
  newApprovalId,
  reconcileApprovals,
  resolveApproval,
} from "./serve-approvals-store";
import { CountingExecutor, makeDirs, registryOf, ScriptedProvider, tool, waitFor, type Dirs, type ScriptedCall } from "./serve-approvals.test-helpers";
import { runRemoteTurn } from "./serve-turn";
import type { ToolRisk } from "../harness/tool/types";

let dirs: Dirs;
let executor: CountingExecutor;

beforeEach(() => {
  dirs = makeDirs();
  executor = new CountingExecutor();
});
afterEach(() => dirs.cleanup());

function broker(): ApprovalBroker {
  return createApprovalBroker({
    dir: dirs.configDir,
    expirySeconds: 300,
    maxPending: 4,
    requireConsumer: false,
    hasConsumer: () => true,
    pollMs: 5,
  });
}

function remote(profileId: "unattended-untrusted" | "read-only-review", risk: ToolRisk, calls: ScriptedCall[], approvals = broker()) {
  return runRemoteTurn({
    request: { schemaVersion: "1.0.0", project: dirs.project, prompt: "do it" },
    project: dirs.project,
    profile: resolveLocalProfile(profileId),
    provider: new ScriptedProvider(calls),
    providerName: "scripted-stub",
    model: "stub-model",
    dir: dirs.configDir,
    scanRoot: dirs.configDir,
    toolRegistry: registryOf(tool("do_thing", risk)),
    toolExecutor: executor,
    containmentAvailable: () => true,
    hooksEnv: { KERYX_HOOKS: "off" },
    approvals,
  });
}

/** The run loop with a scripted approver, to state the binding rule without HTTP. */
async function runWithApprover(
  calls: ScriptedCall[],
  approver: (request: ApprovalRequest) => ReturnType<NonNullable<RunDeps["approver"]>>,
) {
  const profile = resolveLocalProfile("unattended-untrusted");
  const input: HarnessRunInput = {
    schemaVersion: 1,
    request: "do it",
    projectRoot: dirs.project,
    role: "build",
    policy: profile.profileId,
    budget: { maxSeconds: 60, maxToolCalls: 4, maxRetries: 1 },
    provider: "scripted-stub",
    model: "stub-model",
    nonInteractive: true,
    credentialRef: "scripted-stub-local",
  };
  const config: HarnessConfig = {
    schemaVersion: 1,
    enabled: true,
    defaultRole: "build",
    defaultProvider: "scripted-stub",
    defaultModel: "stub-model",
    policyProfile: profile.profileId,
    limits: { maxRunSeconds: 60, maxConcurrentChildren: 1, maxToolOutputBytes: 65_536, maxRetries: 1 },
  };
  let counter = 0;
  const deps: RunDeps = {
    provider: new ScriptedProvider(calls),
    toolRegistry: registryOf(tool("do_thing", "write")),
    toolExecutor: executor,
    policyProfile: profile,
    clock: () => "2026-09-29T10:00:00.000Z",
    idSeq: () => `id-${counter++}`,
    interactive: false,
    approver,
  };
  return runOffline(input, config, deps);
}

const CALL: ScriptedCall = { id: "call-1", name: "do_thing", input: '{"body":"x"}' };

describe("an allow applies only to the call whose fingerprint is on the record", () => {
  test("an answer bound to a different fingerprint does not run the call", async () => {
    const run = await runWithApprover([CALL], async () => ({ approved: true, fingerprint: "f".repeat(64) }));
    expect(executor.names).toEqual([]);
    expect(run.decisions[0]?.decision).toBe("deny");
    expect(run.decisions[0]?.matchedRules).toContain("remote-approval:denied");
  });

  test("an answer bound to this call's own fingerprint runs it, unaltered, once", async () => {
    const run = await runWithApprover([CALL], async (request) => ({ approved: true, fingerprint: request.actionFingerprint }));
    expect(executor.invocations).toEqual([{ tool: "do_thing", input: { body: "x" } }]);
    expect(run.decisions[0]?.matchedRules).toContain("remote-approval:allowed");
  });

  test("the fingerprint differs when the arguments differ, and stores no arguments", async () => {
    const seen: string[] = [];
    await runWithApprover([CALL, { id: "call-2", name: "do_thing", input: '{"body":"y"}' }], async (request) => {
      seen.push(request.actionFingerprint);
      return { approved: false, fingerprint: request.actionFingerprint };
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the store refuses to consume an allowed record for another fingerprint", () => {
    const id = newApprovalId();
    createApproval(
      { approvalId: id, turnId: randomUUID(), sessionId: randomUUID(), summary: "s", scope: "c", consequence: "q", expiresAt: new Date(Date.now() + 60_000), correlationId: randomUUID(), callFingerprint: "a".repeat(64), floors: [] },
      dirs.configDir,
    );
    answerApproval(id, "allow", "test", dirs.configDir);
    expect(consumeApproval(id, "b".repeat(64), dirs.configDir)).toBe("fingerprint-mismatch");
    expect(consumeApproval(id, "a".repeat(64), dirs.configDir)).toBe("consumed");
  });
});

describe("an allow is one-time", () => {
  test("a second identical call in the same turn raises a NEW approval and needs its own answer", async () => {
    const running = remote("unattended-untrusted", "write", [CALL, { ...CALL, id: "call-2" }]);
    await waitFor(() => listApprovals(dirs.configDir).length === 1);
    answerApproval(listApprovals(dirs.configDir)[0]!.approvalId, "allow", "test", dirs.configDir);
    await waitFor(() => listApprovals(dirs.configDir).length === 2);
    expect(executor.names).toEqual(["do_thing"]);

    const second = listApprovals(dirs.configDir).find((entry) => entry.state === "pending")!;
    answerApproval(second.approvalId, "deny", "test", dirs.configDir);
    const run = await running;
    expect(executor.names).toEqual(["do_thing"]);
    expect(run.result.approvals?.map((entry) => entry.resolution)).toEqual(["allowed", "denied"]);
  });

  test("a consumed approval cannot be consumed again, including by a fresh process", () => {
    const id = newApprovalId();
    createApproval(
      { approvalId: id, turnId: randomUUID(), sessionId: randomUUID(), summary: "s", scope: "c", consequence: "q", expiresAt: new Date(Date.now() + 60_000), correlationId: randomUUID(), callFingerprint: "a".repeat(64), floors: [] },
      dirs.configDir,
    );
    answerApproval(id, "allow", "test", dirs.configDir);
    expect(consumeApproval(id, "a".repeat(64), dirs.configDir)).toBe("consumed");
    // Nothing is held in memory: the next call reads the files, as a restart would.
    expect(consumeApproval(id, "a".repeat(64), dirs.configDir)).toBe("already-consumed");
  });

  test("an allowed-but-unconsumed approval is closed at startup and can never run afterwards", () => {
    const id = newApprovalId();
    createApproval(
      { approvalId: id, turnId: randomUUID(), sessionId: randomUUID(), summary: "s", scope: "c", consequence: "q", expiresAt: new Date(Date.now() + 60_000), correlationId: randomUUID(), callFingerprint: "a".repeat(64), floors: [] },
      dirs.configDir,
    );
    answerApproval(id, "allow", "test", dirs.configDir);
    reconcileApprovals(dirs.configDir, { isTurnLive: () => false });
    expect(consumeApproval(id, "a".repeat(64), dirs.configDir)).toBe("already-consumed");
  });
});

describe("an allow never lifts a floor and never overrides a deny", () => {
  test("a destructive call always asks, records its floor, and the next identical call asks again", async () => {
    const running = remote("unattended-untrusted", "destructive", [CALL, { ...CALL, id: "call-2" }]);
    await waitFor(() => listApprovals(dirs.configDir).length === 1);
    const first = listApprovals(dirs.configDir)[0]!;
    expect(first.floors).toContain("destructive");
    answerApproval(first.approvalId, "allow", "test", dirs.configDir);
    await waitFor(() => listApprovals(dirs.configDir).length === 2);
    const second = listApprovals(dirs.configDir).find((entry) => entry.approvalId !== first.approvalId)!;
    expect(second.floors).toContain("destructive");
    expect(second.state).toBe("pending");
    answerApproval(second.approvalId, "deny", "test", dirs.configDir);
    await running;
    expect(executor.names).toEqual(["do_thing"]);
  });

  test("a credential call carries the credentials floor", async () => {
    const running = remote("unattended-untrusted", "credential", [CALL]);
    await waitFor(() => listApprovals(dirs.configDir).length === 1);
    expect(listApprovals(dirs.configDir)[0]!.floors).toContain("credentials");
    answerApproval(listApprovals(dirs.configDir)[0]!.approvalId, "deny", "test", dirs.configDir);
    await running;
  });

  test("a policy deny never reaches the approver, even with an allowed record for the same call on disk", async () => {
    const stale = newApprovalId();
    createApproval(
      { approvalId: stale, turnId: randomUUID(), sessionId: randomUUID(), summary: "s", scope: "c", consequence: "q", expiresAt: new Date(Date.now() + 60_000), correlationId: randomUUID(), callFingerprint: "a".repeat(64), floors: [] },
      dirs.configDir,
    );
    resolveApproval(stale, { state: "allowed", answeredBy: "test" }, dirs.configDir);
    const run = await remote("read-only-review", "write", [CALL]);
    expect(executor.names).toEqual([]);
    expect(run.result.approvals).toBeUndefined();
    expect(listApprovals(dirs.configDir).map((entry) => entry.approvalId)).toEqual([stale]);
  });

  test("an already-resolved-allowed record is not consulted by a fresh ask: every ask raises its own record", async () => {
    const stale = newApprovalId();
    createApproval(
      { approvalId: stale, turnId: randomUUID(), sessionId: randomUUID(), summary: "s", scope: "c", consequence: "q", expiresAt: new Date(Date.now() + 60_000), correlationId: randomUUID(), callFingerprint: "a".repeat(64), floors: [] },
      dirs.configDir,
    );
    resolveApproval(stale, { state: "allowed", answeredBy: "test" }, dirs.configDir);

    const running = remote("unattended-untrusted", "write", [CALL]);
    await waitFor(() => listApprovals(dirs.configDir).some((entry) => entry.approvalId !== stale));
    expect(executor.names).toEqual([]);
    const fresh = listApprovals(dirs.configDir).find((entry) => entry.approvalId !== stale)!;
    answerApproval(fresh.approvalId, "deny", "test", dirs.configDir);
    await running;
    expect(executor.names).toEqual([]);
  });
});
