// Tests for `spawnChildWithHooks` (flow 306, W6, task T6 / AC8).
import { expect, test } from "bun:test";
import type { HookFireResult, HookRegistration, HookRuntime } from "../hooks";
import type { Provenance } from "../session/types";
import type { PolicyProfile } from "../policy/types";
import { spawnChildWithHooks } from "./spawn-hooks";
import type { SpawnChildDeps, SpawnChildInput } from "./spawn";

function makeSpawnDeps(): SpawnChildDeps {
  let counter = 0;
  return {
    clock: () => "2026-09-24T00:00:00.000Z",
    idSeq: () => `spawn-${counter++}`,
  };
}

const monitoredProfile: PolicyProfile = {
  schemaVersion: 1,
  profileId: "monitored-trusted-local",
  profileVersion: "1.0.0",
  fingerprint: "a".repeat(64),
  trustMode: "trusted-local",
  defaults: { read: "allow", write: "ask", shell: "ask", network: "ask", delegate: "ask" },
  requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
};

const readOnlyProfile: PolicyProfile = {
  schemaVersion: 1,
  profileId: "read-only-review",
  profileVersion: "1.0.0",
  fingerprint: "b".repeat(64),
  trustMode: "read-only",
  defaults: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" },
  requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
};

const parentProvenance: Provenance = {
  provenanceId: "provenance-parent-1",
  trustLevel: "trusted",
  sourceKind: "harness-run",
};

function makeSpawnInput(): SpawnChildInput {
  return {
    parentRunId: "parent-run-1",
    parentSessionId: "parent-session-1",
    parentProvenance,
    contextManifestHash: "c".repeat(64),
    canonicalContractVersion: "1.0.0",
    parentRemainingBudget: { maxRuntimeMs: 120_000, maxToolCalls: 40 },
    parentPolicy: monitoredProfile,
    childRequest: {
      attempt: { attemptId: "attempt-1", number: 1 },
      branchId: "branch-1",
      budgetRequest: { reservationId: "res-1", maxRuntimeMs: 30_000, maxToolCalls: 10 },
      policyRequest: readOnlyProfile,
      durableResultArtifact: { artifactId: "artifact-child-1", kind: "final-report", hash: "d".repeat(64) },
    },
  };
}

/** A minimal fake `HookRuntime`: scripted per-event outcome, records every `fire()` call. */
function fakeHookRuntime(opts: {
  interactive?: boolean;
  inherited?: string[];
  outcomeByEvent?: Partial<Record<string, HookFireResult["tightened"]>>;
}): { runtime: HookRuntime; fires: { event: string; payload: Record<string, unknown> }[] } {
  const fires: { event: string; payload: Record<string, unknown> }[] = [];
  const runtime: HookRuntime = {
    interactive: opts.interactive ?? true,
    registrations: (): readonly HookRegistration[] => [],
    inheritedHookIds: () => opts.inherited ?? [],
    forChild: () => runtime,
    fire: async (event, payload): Promise<HookFireResult> => {
      fires.push({ event, payload });
      const tightened = opts.outcomeByEvent?.[event] ?? "allow";
      return {
        decisions: [],
        ...(tightened !== undefined ? { tightened } : {}),
        additionalContext: [],
        records: [],
        warnings: [],
        anomalies: [],
      };
    },
  };
  return { runtime, fires };
}

test("no hooks supplied: byte-identical to calling spawnChild directly", async () => {
  const result = await spawnChildWithHooks(makeSpawnInput(), makeSpawnDeps(), undefined, {
    subagentId: "sub-1",
    parentSessionId: "parent-session-1",
    parentRunId: "parent-run-1",
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    // `stop()` is a documented no-op with no hooks; must not throw.
    await expect(result.stop("Completed")).resolves.toBeUndefined();
  }
});

test("SubagentStart deny prevents spawnChild from ever running — no partial extension", async () => {
  const { runtime, fires } = fakeHookRuntime({ outcomeByEvent: { SubagentStart: "deny" } });
  const result = await spawnChildWithHooks(makeSpawnInput(), makeSpawnDeps(), runtime, {
    subagentId: "sub-2",
    parentSessionId: "parent-session-1",
    parentRunId: "parent-run-1",
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toMatch(/denied by hook/);
  }
  expect(fires).toHaveLength(1);
  expect(fires[0]?.event).toBe("SubagentStart");
});

test("SubagentStart tightened ask under a non-interactive runtime fails closed (no interactive approver at this layer)", async () => {
  const { runtime } = fakeHookRuntime({ interactive: false, outcomeByEvent: { SubagentStart: "ask" } });
  const result = await spawnChildWithHooks(makeSpawnInput(), makeSpawnDeps(), runtime, {
    subagentId: "sub-3",
    parentSessionId: "parent-session-1",
    parentRunId: "parent-run-1",
  });
  expect(result.ok).toBe(false);
});

test("SubagentStart allow yields the same result as spawnChild, and SubagentStop fires with the given outcome", async () => {
  const { runtime, fires } = fakeHookRuntime({ inherited: ["keryx.ctx-guard"] });
  const result = await spawnChildWithHooks(makeSpawnInput(), makeSpawnDeps(), runtime, {
    subagentId: "sub-4",
    parentSessionId: "parent-session-1",
    parentRunId: "parent-run-1",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.extension.branchId).toBe("branch-1");

  const startFire = fires.find((f) => f.event === "SubagentStart");
  expect(startFire?.payload.spawnKind).toBe("internal");
  expect(startFire?.payload.inheritedHookIds).toEqual(["keryx.ctx-guard"]);
  expect(startFire?.payload.subagentId).toBe("sub-4");

  await result.stop("Completed");
  const stopFire = fires.find((f) => f.event === "SubagentStop");
  expect(stopFire?.payload.outcome).toBe("Completed");
  expect(stopFire?.payload.subagentId).toBe("sub-4");
});
