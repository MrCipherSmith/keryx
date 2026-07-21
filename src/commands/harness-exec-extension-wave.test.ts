// RED tests for the `keryx harness exec/extension/wave` CLI subcommands (flow
// 030, T5). The impl module does NOT exist yet — `harnessCommand` today only
// routes `args[0] === "run"`; every other subcommand (including "exec",
// "extension", "wave") falls through to the USAGE line. Every behavioral test
// below is therefore expected to FAIL (RED) until T6 implements the three new
// subcommands. This is NOT a per-test bug — it is the RED half of TDD.
//
// PINNED CLI CONTRACT this suite designs and T6 must implement to (see the
// returned subagent-result for the authoritative summary):
//
//   `HarnessCommandDeps` gains three OPTIONAL injection points (on top of the
//   existing `fetch`/`clock`/`idSeq`/`env`):
//     - `processAdapter?: ProcessAdapter`   (`../harness/process/executor`)
//     - `extensionSpec?: ExtensionCliSpec`  (shape below)
//     - `waveSpec?: WaveCliSpec`            (shape below)
//
//   `exec` — `keryx harness exec [--allow-env KEY]... [--max-runtime-ms N]
//   [--allow-real-subprocess] -- <path> [args...]`
//     - No `deps.processAdapter` AND no `--allow-real-subprocess` -> refuses
//       with a plain-text message naming "--allow-real-subprocess"; the
//       adapter (there is none) is never consulted; NO JSON outcome blob is
//       printed, and nothing resembling `"kind":"completed"` appears.
//     - `deps.processAdapter` present -> `runContainedProcess` runs against it
//       (never a real spawn) using an allowlist built from `--allow-env`, a
//       budget derived from `--max-runtime-ms` (default 30000ms) bounded by a
//       fixed `parentRemaining.maxRuntimeMs` of 60000ms, `cwd: process.cwd()`,
//       and a fixed shell-allow policy profile. The LAST `console.log` is one
//       JSON blob:
//         completed         -> `{outcome:{kind:"completed",exitCode?}, receipt, evidenceRefs}`
//         timeout/overflow/
//         cancelled         -> `{outcome:{kind}, receipt}`
//         blocked           -> `{outcome:{kind:"blocked", reason}}` (no receipt key)
//     - An argv token that fails the structural guard (shell metachar /
//       traversal) is blocked BEFORE the adapter is ever consulted
//       (`adapter.spawn` call count stays 0).
//     - A `--max-runtime-ms` request that exceeds the fixed 60000ms
//       `parentRemaining` ceiling is blocked BEFORE the adapter is consulted.
//     - The command performs no fs write of its own (source-text invariant,
//       mirrors the existing D-02 guard for `run`) and returns `void`.
//
//   `extension` — `keryx harness extension` (spec-driven only; no argv parsing
//   beyond routing on `args[0]`)
//     - `deps.extensionSpec` provides everything: `extensionId`,
//       `manifest?`, `capabilityGrant?`, optional
//       `requestedCapabilities`/`policyDecision`/`provenance`/`approval` (fed to
//       `evaluateExtensionGrant` only when `requestedCapabilities` is present),
//       plus every field `dispatchExtension` needs
//       (`reservedBudget`,`parentRunId`,`sessionId`,`attempt`,`branchId`,
//       `contextManifestHash`,`policyFingerprint`,`canonicalContractVersion`,
//       `task`,`acceptanceCriteria`,`dispatchArtifact`,`resultArtifact`), plus
//       an optional `rawChildResult` (defaults to a STATUS:DONE reply).
//     - `registerExtension({extensionId, manifest, capabilityGrant})` runs
//       first; `ok:false` -> LAST console.log is `{registration}` — NO
//       `dispatch`/`result`/`evidenceRefs` key at all.
//     - When `requestedCapabilities` is present, `evaluateExtensionGrant` runs
//       next; `ok:false` -> LAST console.log is `{registration, grantEvaluation}`
//       — again NO `dispatch` key (the denial is fail-closed BEFORE dispatch).
//     - Otherwise `dispatchExtension` runs and, on success, `rawChildResult` is
//       parsed via the returned `parseResult`; LAST console.log is
//       `{registration, dispatch, result, evidenceRefs}` where `result` is the
//       parsed canonical `subagent-result` object and `evidenceRefs` is
//       `[resultArtifact.hash]`.
//
//   `wave` — `keryx harness wave` (spec-driven only)
//     - `deps.waveSpec` = `{tasks: WaveCliTaskSpec[], maxConcurrency,
//       parentRemaining, parentRunId, canonicalContractVersion}`. Each task
//       spec carries everything `registerExtension` + `ExtensionWaveTask`
//       need; the command builds `registration = registerExtension(...)` per
//       task, assembles `ExtensionWaveTask[]`, and calls `planExtensionWave`.
//     - LAST console.log: `{ok:true, waves}` on success (no `wave.taskIds`
//       ever exceeds `maxConcurrency`), or `{ok:false, reason}` on any
//       fail-closed denial (unregistered task, cycle, degenerate concurrency,
//       or aggregate budget breach) — propagated verbatim from
//       `planExtensionWave`.
//
// OFFLINE / DETERMINISTIC: every test injects `clock`/`idSeq`/`env`; the FAKE
// `ProcessAdapter` below never spawns a real process; `extensionSpec`/
// `waveSpec` are injected objects, never read from fs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { ContainedCommand, ProcessAdapter, ProcessObservation } from "../harness/process/executor";
// PINNED API (RED: the "exec"/"extension"/"wave" subcommands do not exist yet).
import type { HarnessCommandDeps } from "./harness";
import { harnessCommand } from "./harness";

// ---------------------------------------------------------------------------
// Shared test scaffolding (mirrors harness.test.ts's captureConsoleLog/lastJson).
// ---------------------------------------------------------------------------

function captureConsoleLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  // biome-ignore lint: intentional console capture for assertions in this test only.
  console.log = (...values: unknown[]) => {
    logs.push(values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

function lastJson(logs: string[]): Record<string, unknown> | undefined {
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i];
    if (line === undefined) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Not this line; keep scanning backwards.
    }
  }
  return undefined;
}

function fixedClockIdEnv(): Pick<HarnessCommandDeps, "clock" | "idSeq" | "env"> {
  let counter = 0;
  return {
    clock: () => "2026-07-14T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
    env: {},
  };
}

// ---------------------------------------------------------------------------
// FAKE ProcessAdapter — in-memory only, mirrors executor.test.ts's double.
// ---------------------------------------------------------------------------
class FakeProcessAdapter implements ProcessAdapter {
  spawnCalls: ContainedCommand[] = [];
  constructor(private readonly observation: ProcessObservation) {}
  spawn(command: ContainedCommand): ProcessObservation {
    this.spawnCalls.push(command);
    return this.observation;
  }
}

const cleanObservation: ProcessObservation = {
  kind: "clean-exit",
  exitCode: 0,
  outputBytes: 16,
  observedHash: "a".repeat(64),
};
const timeoutObservation: ProcessObservation = {
  kind: "deadline-exceeded",
  terminationMode: "process-group",
  observedHash: "b".repeat(64),
};
const overflowObservation: ProcessObservation = {
  kind: "output-overflow",
  outputBytes: 999_999,
  observedHash: "c".repeat(64),
};
const cancelledObservation: ProcessObservation = {
  kind: "cancelled",
  terminationMode: "process-group",
  observedHash: "d".repeat(64),
};

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

describe("keryx harness exec — fail-closed without an adapter or --allow-real-subprocess", () => {
  test("no --allow-real-subprocess and no injected processAdapter -> refuses, mentions the flag, no completed outcome, no spawn", async () => {
    const { logs, restore } = captureConsoleLog();
    try {
      await harnessCommand(["exec", "--", "/bin/echo", "hi"], { ...fixedClockIdEnv() });
    } finally {
      restore();
    }

    const combined = logs.join("\n");
    expect(combined).toContain("--allow-real-subprocess");
    expect(combined).not.toMatch(/"kind"\s*:\s*"completed"/);
  });
});

describe("keryx harness exec — offline completed outcome via an injected FAKE processAdapter", () => {
  test('--allow-env FOO -- /bin/echo hi with a clean-exit fake adapter -> {outcome:{kind:"completed",...}, receipt, evidenceRefs}; spawn called once with the approved cwd', async () => {
    const adapter = new FakeProcessAdapter(cleanObservation);
    const { logs, restore } = captureConsoleLog();
    try {
      await harnessCommand(
        ["exec", "--allow-env", "FOO", "--", "/bin/echo", "hi"],
        { ...fixedClockIdEnv(), processAdapter: adapter },
      );
    } finally {
      restore();
    }

    const result = lastJson(logs);
    expect(result).toBeDefined();
    const outcome = result?.outcome as { kind?: string; exitCode?: number } | undefined;
    expect(outcome?.kind).toBe("completed");
    expect(result?.receipt).toBeDefined();
    expect(Array.isArray(result?.evidenceRefs)).toBe(true);

    expect(adapter.spawnCalls).toHaveLength(1);
    expect(adapter.spawnCalls[0]?.cwd).toBe(process.cwd());
  });
});

describe("keryx harness exec — a missing `--` command is named, not silently mangled", () => {
  test("no command after the flags -> an actionable message, nothing spawned", async () => {
    const { logs, restore } = captureConsoleLog();
    try {
      // No injected adapter: this is the real-CLI path, where an empty command
      // path used to reach the sandbox launcher and come back as exit 71.
      await harnessCommand(["exec", "--allow-real-subprocess", "--allow-env", "PATH"], fixedClockIdEnv());
    } finally {
      restore();
    }
    expect(logs.join("\n")).toContain("no command");
    expect(logs.join("\n")).toContain("--");
    expect(lastJson(logs)).toBeUndefined(); // never reached the run
  });
});

describe("keryx harness exec — non-completed scripted outcomes surface their own kind", () => {
  test.each([
    ["timeout", timeoutObservation, "timeout"],
    ["output-overflow", overflowObservation, "output-overflow"],
    ["cancelled", cancelledObservation, "cancelled"],
  ] as const)("a fake adapter scripted to %s yields outcome.kind === %s, never completed", async (_label, observation, expectedKind) => {
    const adapter = new FakeProcessAdapter(observation);
    const { logs, restore } = captureConsoleLog();
    try {
      await harnessCommand(
        ["exec", "--", "/bin/echo", "hi"],
        { ...fixedClockIdEnv(), processAdapter: adapter },
      );
    } finally {
      restore();
    }

    const result = lastJson(logs);
    const outcome = result?.outcome as { kind?: string } | undefined;
    expect(outcome?.kind).toBe(expectedKind);
    expect(outcome?.kind).not.toBe("completed");
  });
});

describe("keryx harness exec — unapproved argv / budget breach fail-closed before spawn", () => {
  test("a shell-metacharacter argv token is blocked before spawn; adapter.spawn is NEVER called", async () => {
    const adapter = new FakeProcessAdapter(cleanObservation);
    const { logs, restore } = captureConsoleLog();
    try {
      await harnessCommand(
        ["exec", "--", "/bin/sh", "-c", "; rm -rf /"],
        { ...fixedClockIdEnv(), processAdapter: adapter },
      );
    } finally {
      restore();
    }

    const result = lastJson(logs);
    const outcome = result?.outcome as { kind?: string; reason?: string } | undefined;
    expect(outcome?.kind).toBe("blocked");
    expect(typeof outcome?.reason).toBe("string");
    expect(adapter.spawnCalls).toHaveLength(0);
  });

  test("--max-runtime-ms exceeding the fixed 60000ms parentRemaining ceiling is blocked before spawn", async () => {
    const adapter = new FakeProcessAdapter(cleanObservation);
    const { logs, restore } = captureConsoleLog();
    try {
      await harnessCommand(
        ["exec", "--max-runtime-ms", "120000", "--", "/bin/echo", "hi"],
        { ...fixedClockIdEnv(), processAdapter: adapter },
      );
    } finally {
      restore();
    }

    const result = lastJson(logs);
    const outcome = result?.outcome as { kind?: string } | undefined;
    expect(outcome?.kind).toBe("blocked");
    expect(adapter.spawnCalls).toHaveLength(0);
  });
});

describe("keryx harness exec — no flow.json write, stdout-only, returns void", () => {
  test("harness.ts (the shared command module) contains no flow.json write reference", () => {
    const source = readFileSync(path.join(import.meta.dir, "harness.ts"), "utf8");
    expect(/flow\.json/i.test(source)).toBe(false);
  });

  test("harnessCommand(['exec', ...]) returns undefined (void) — output is stdout console.log only", async () => {
    const adapter = new FakeProcessAdapter(cleanObservation);
    const { logs, restore } = captureConsoleLog();
    let returnValue: unknown;
    try {
      returnValue = await harnessCommand(
        ["exec", "--", "/bin/echo", "hi"],
        { ...fixedClockIdEnv(), processAdapter: adapter },
      );
    } finally {
      restore();
    }
    expect(returnValue).toBeUndefined();
    expect(logs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function makeValidExtensionSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    extensionId: "ext-030-1",
    manifest: { manifestHash: HASH_A, extensionVersion: "1.0.0" },
    capabilityGrant: { grantId: "grant-030-1", capabilities: ["read"] },
    reservedBudget: { reservationId: "res-030-1", maxRuntimeMs: 30_000 },
    parentRunId: "run-030-parent",
    sessionId: "session-030-1",
    attempt: { attemptId: "attempt-030-1", number: 1 },
    branchId: "branch-030-1",
    contextManifestHash: HASH_B,
    policyFingerprint: HASH_C,
    canonicalContractVersion: "1.0.0",
    task: { title: "Run extension X", description: "CLI-dispatched extension for flow 030." },
    acceptanceCriteria: ["extension completes within its granted capabilities"],
    dispatchArtifact: { artifactId: "artifact-030-dispatch", kind: "child-dispatch", path: "artifacts/030-dispatch.json", hash: HASH_D },
    resultArtifact: { artifactId: "artifact-030-result", kind: "final-report", path: "artifacts/030-result.json", hash: HASH_A },
    ...overrides,
  };
}

describe("keryx harness extension — a valid registered+granted spec dispatches and parses a canonical result", () => {
  test("prints {registration:{ok:true,...}, dispatch, result, evidenceRefs} as the last console.log", async () => {
    const { logs, restore } = captureConsoleLog();
    try {
      await harnessCommand(["extension"], {
        ...fixedClockIdEnv(),
        extensionSpec: makeValidExtensionSpec(),
      } as HarnessCommandDeps);
    } finally {
      restore();
    }

    const result = lastJson(logs);
    expect(result).toBeDefined();
    const registration = result?.registration as { ok?: boolean } | undefined;
    expect(registration?.ok).toBe(true);
    expect(result?.dispatch).toBeDefined();
    expect(result?.result).toBeDefined();
    expect(Array.isArray(result?.evidenceRefs)).toBe(true);
  });
});

describe("keryx harness extension — an invalid/unregistered spec is refused fail-closed, no dispatch", () => {
  test("no manifest and no capabilityGrant -> {registration:{ok:false,reason}}, NO dispatch key", async () => {
    const { logs, restore } = captureConsoleLog();
    try {
      await harnessCommand(["extension"], {
        ...fixedClockIdEnv(),
        extensionSpec: makeValidExtensionSpec({ manifest: undefined, capabilityGrant: undefined }),
      } as HarnessCommandDeps);
    } finally {
      restore();
    }

    const result = lastJson(logs);
    expect(result).toBeDefined();
    const registration = result?.registration as { ok?: boolean; reason?: string } | undefined;
    expect(registration?.ok).toBe(false);
    expect(typeof registration?.reason).toBe("string");
    expect(result?.dispatch).toBeUndefined();
  });
});

describe("keryx harness extension — an escalating grant request without policy+provenance+approval is denied", () => {
  test("requestedCapabilities broader than the grant, with no policyDecision/provenance/approval -> grantEvaluation denies, no dispatch", async () => {
    const { logs, restore } = captureConsoleLog();
    try {
      await harnessCommand(["extension"], {
        ...fixedClockIdEnv(),
        extensionSpec: makeValidExtensionSpec({
          capabilityGrant: { grantId: "grant-030-2", capabilities: ["read"] },
          requestedCapabilities: ["read", "shell"],
        }),
      } as HarnessCommandDeps);
    } finally {
      restore();
    }

    const result = lastJson(logs);
    expect(result).toBeDefined();
    const registration = result?.registration as { ok?: boolean } | undefined;
    expect(registration?.ok).toBe(true);
    const grantEvaluation = result?.grantEvaluation as { ok?: boolean; reason?: string } | undefined;
    expect(grantEvaluation?.ok).toBe(false);
    expect(typeof grantEvaluation?.reason).toBe("string");
    expect(result?.dispatch).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// wave
// ---------------------------------------------------------------------------

function makeWaveTaskSpec(taskId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId,
    dependsOn: [],
    extensionId: `ext-${taskId}`,
    manifest: { manifestHash: HASH_A, extensionVersion: "1.0.0" },
    capabilityGrant: { grantId: `grant-${taskId}`, capabilities: ["read"] },
    budgetRequest: { reservationId: `res-${taskId}`, maxRuntimeMs: 10_000 },
    sessionId: "session-030-wave",
    attempt: { attemptId: `attempt-${taskId}`, number: 1 },
    branchId: `branch-${taskId}`,
    contextManifestHash: HASH_B,
    policyFingerprint: HASH_C,
    task: { title: `Run ${taskId}`, description: `Bounded extension dispatch for ${taskId}.` },
    acceptanceCriteria: [`${taskId} completes within its granted capabilities`],
    dispatchArtifact: { artifactId: `${taskId}-dispatch`, kind: "child-dispatch", path: `artifacts/${taskId}-dispatch.json`, hash: HASH_D },
    resultArtifact: { artifactId: `${taskId}-result`, kind: "final-report", path: `artifacts/${taskId}-result.json`, hash: HASH_A },
    ...overrides,
  };
}

describe("keryx harness wave — bounded concurrency, all tasks registered", () => {
  test("3 registered tasks with maxConcurrency:2 -> {ok:true, waves:[...]} and no wave exceeds 2 taskIds", async () => {
    const { logs, restore } = captureConsoleLog();
    try {
      await harnessCommand(["wave"], {
        ...fixedClockIdEnv(),
        waveSpec: {
          tasks: [makeWaveTaskSpec("w-1"), makeWaveTaskSpec("w-2"), makeWaveTaskSpec("w-3")],
          maxConcurrency: 2,
          parentRemaining: { maxRuntimeMs: 100_000 },
          parentRunId: "run-030-wave-parent",
          canonicalContractVersion: "1.0.0",
        },
      } as HarnessCommandDeps);
    } finally {
      restore();
    }

    const result = lastJson(logs);
    expect(result).toBeDefined();
    expect(result?.ok).toBe(true);
    const waves = result?.waves as Array<{ taskIds: string[] }> | undefined;
    expect(Array.isArray(waves)).toBe(true);
    for (const wave of waves ?? []) {
      expect(wave.taskIds.length).toBeLessThanOrEqual(2);
    }
    const allTaskIds = (waves ?? []).flatMap((w) => w.taskIds).sort();
    expect(allTaskIds).toEqual(["w-1", "w-2", "w-3"]);
  });
});

describe("keryx harness wave — an unregistered task fails the whole plan closed", () => {
  test("one task with no manifest/capabilityGrant -> {ok:false, reason} mentioning registration", async () => {
    const { logs, restore } = captureConsoleLog();
    try {
      await harnessCommand(["wave"], {
        ...fixedClockIdEnv(),
        waveSpec: {
          tasks: [
            makeWaveTaskSpec("good-1"),
            makeWaveTaskSpec("bad-1", { manifest: undefined, capabilityGrant: undefined }),
          ],
          maxConcurrency: 2,
          parentRemaining: { maxRuntimeMs: 100_000 },
          parentRunId: "run-030-wave-parent",
          canonicalContractVersion: "1.0.0",
        },
      } as HarnessCommandDeps);
    } finally {
      restore();
    }

    const result = lastJson(logs);
    expect(result).toBeDefined();
    expect(result?.ok).toBe(false);
    expect(typeof result?.reason).toBe("string");
    expect((result?.reason as string).toLowerCase()).toMatch(/regist/);
    expect(result?.waves).toBeUndefined();
  });
});

describe("keryx harness wave — a dependency cycle fails the whole plan closed", () => {
  test("a 2-node cycle -> {ok:false, reason} mentioning cycle", async () => {
    const { logs, restore } = captureConsoleLog();
    try {
      await harnessCommand(["wave"], {
        ...fixedClockIdEnv(),
        waveSpec: {
          tasks: [
            makeWaveTaskSpec("c-x", { dependsOn: ["c-y"] }),
            makeWaveTaskSpec("c-y", { dependsOn: ["c-x"] }),
          ],
          maxConcurrency: 2,
          parentRemaining: { maxRuntimeMs: 100_000 },
          parentRunId: "run-030-wave-parent",
          canonicalContractVersion: "1.0.0",
        },
      } as HarnessCommandDeps);
    } finally {
      restore();
    }

    const result = lastJson(logs);
    expect(result?.ok).toBe(false);
    expect((result?.reason as string).toLowerCase()).toMatch(/cycle/);
  });
});

describe("keryx harness wave — an aggregate budget breach fails the whole plan closed", () => {
  test("Σ budgetRequests exceeding parentRemaining -> {ok:false, reason} mentioning budget", async () => {
    const { logs, restore } = captureConsoleLog();
    try {
      await harnessCommand(["wave"], {
        ...fixedClockIdEnv(),
        waveSpec: {
          tasks: [
            makeWaveTaskSpec("b-1", { budgetRequest: { reservationId: "res-b-1", maxRuntimeMs: 60_000 } }),
            makeWaveTaskSpec("b-2", { budgetRequest: { reservationId: "res-b-2", maxRuntimeMs: 60_000 } }),
          ],
          maxConcurrency: 2,
          parentRemaining: { maxRuntimeMs: 100_000 },
          parentRunId: "run-030-wave-parent",
          canonicalContractVersion: "1.0.0",
        },
      } as HarnessCommandDeps);
    } finally {
      restore();
    }

    const result = lastJson(logs);
    expect(result?.ok).toBe(false);
    expect((result?.reason as string).toLowerCase()).toMatch(/budget|exceed/);
  });
});
