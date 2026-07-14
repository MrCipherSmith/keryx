// RED tests for R2-5 real-subprocess executor (flow 026, dispatch 026-T5,
// task-T5, reviewer track: highload/security).
//
// Closes the RUNTIME half of the frozen `SC_R04_SHELL_CONTAINMENT` scenario
// (`docs/requirements/keryx-project-agent-harness/acceptance.feature:422`):
//   "Given a future shell tool has an approved argv and environment allowlist
//    When the process-group command runs
//    Then timeout, output, cwd, and cancellation controls are enforced"
// plus the Release-0 fail-closed bound-hit precedents this module must mirror
// at runtime:
//   - `:98`  SC_R04_TOOL_TIMEOUT          "records a typed timeout or cancelled
//                                          execution / does not report
//                                          successful completion"
//   - `:106` SC_R04_TOOL_OUTPUT_OVERFLOW  "bounded overflow result / does not
//                                          enter an unbounded context retry loop"
//
// `runContainedProcess` (T6, next dispatch) implements
// `src/harness/process/executor.ts` to make this suite GREEN; until then the
// missing-module import below is the expected RED failure ("Cannot find
// module './executor'").
//
// ---------------------------------------------------------------------------
// DESIGN NOTES (this suite IS the spec T6 implements to — "test file wins"):
//
// 1. Reuse, mirroring W10 `guardAction`/`actionFingerprint` + W12
//    `inheritBudget` (per flow 026 `plan.md`/`tasks.md`, both read before
//    writing this suite):
//      - `RunContainedProcessInput.allowlist` bundles everything `guardAction`
//        needs (`worktreeRoot`, `profile`, `interactive`, `scanAvailable`,
//        `risk`, `resolveSymlink?`) PLUS an additive `envAllowlist: string[]`
//        that this module itself enforces (guardAction has no env-allowlist
//        concept of its own — it only denies a *direct credential path* or an
//        unrestricted `env`/`printenv` dump). An env key present on
//        `command.env` that is NOT in `envAllowlist` is blocked before spawn.
//      - `runContainedProcess` gates, in order, BEFORE ever touching the
//        adapter: (1) `guardAction` deny -> blocked; (2) a non-allowlisted env
//        key present -> blocked; (3) `inheritBudget(parentRemaining, budget)`
//        not-ok -> blocked. Only then is `adapter.spawn(command)` invoked,
//        exactly once.
//      - The receipt's `inputHash` is `actionFingerprint({path,argv,env},
//        {worktreeRoot, envAllowlist})` over the approved `command` (reuses
//        the exact W10 primitive named in the acceptance scenario:
//        "approved argv and environment allowlist").
//
// 2. `ProcessAdapter.spawn(command: ContainedCommand): ProcessObservation` is
//    single-argument, matching the flow-026 `tasks.md` T6 line verbatim
//    (`ProcessAdapter` port — `spawn(command): ProcessObservation`).
//    `ContainedCommand` reuses/extends `ActionSpec` (`path`, `argv`, `env`)
//    plus `cwd` (also per `tasks.md` T6: "reuse/extend `ActionSpec` + cwd").
//    The scripted `ProcessObservation` alone determines timeout/overflow/
//    cancel/clean-exit/spawn-error classification — the FAKE adapter never
//    computes anything from `outputLimitBytes`/the reserved deadline itself;
//    a REAL adapter (T6's `real-process-adapter.ts`, exercised only by the
//    flag-gated smoke suite) is responsible for actually enforcing those
//    bounds and reporting what it observed.
//
// 3. `ContainedProcessOutcome.receipt.outcome` reuses the FROZEN
//    `execution-receipt.schema.json` enum (`["effect-confirmed",
//    "effect-absent", "indeterminate", "not-applicable"]` — there is no
//    "timeout"/"cancelled" value in that enum). This suite pins:
//      - `completed`       -> receipt.outcome === "effect-confirmed"
//      - timeout/overflow/cancelled -> receipt.outcome === "indeterminate"
//        (mirrors W10 `execute.ts`'s own "ambiguous effect" convention: the
//        real-world state after a killed/truncated process is NOT confirmed
//        clean, so it is never "effect-confirmed").
//      - `blocked` carries NO receipt at all (mirrors W10
//        `executeGuardedMutation`'s `blocked` variant, which also carries no
//        receipt — a gate that fires before the adapter is ever consulted
//        records only a reason, not a receipt).
//
// 4. `input.cancelled` models an EXTERNAL cancellation signal that arrives
//    while the contained command is already running: `runContainedProcess`
//    still spawns (a not-yet-started process cannot be group-killed), and the
//    scripted `ProcessObservation.kind === "cancelled"` is what the fake
//    reports the adapter observed (including that it performed a group-kill).
//    `input.cancelled` is NOT forwarded onto `adapter.spawn` — cancellation is
//    handled inside `runContainedProcess` (it reclassifies a clean observation
//    to `cancelled` when `input.cancelled === true`); `spawn` receives only the
//    approved `ContainedCommand`.
//
// Deterministic: `deps.clock`/`deps.idSeq` are fixed via `makeDeps()` (mirrors
// `execute.test.ts`/`guard.test.ts`/`isolation.test.ts`). NO real fs/network:
// `ProcessAdapter` is a FAKE, in-memory-only double — there is no real
// `node:child_process` spawn anywhere in this suite (that lives behind the
// flag-gated `real-process-adapter.smoke.test.ts` only).
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";
import { inheritBudget } from "../child/isolation";
import type { BudgetReservation, ParentRemainingBudget } from "../child/isolation";
// Reused W10 primitive named directly by the acceptance scenario ("approved
// argv and environment allowlist") — used here only to compute the EXPECTED
// receipt.inputHash independently of the executor under test.
import { actionFingerprint } from "../mutation/fingerprint";
import type { PolicyProfile } from "../policy/types";
import type { ToolRisk } from "../tool/types";

// PINNED API under test — T6 impl exports these from "./executor"; the import
// fails until then (expected RED: "Cannot find module './executor'").
import {
  runContainedProcess,
  type ContainedCommand,
  type ContainedProcessOutcome,
  type ProcessAdapter,
  type ProcessObservation,
  type RunContainedProcessDeps,
  type RunContainedProcessInput,
} from "./executor";

// Frozen schemas dir, computed relative to this file
// (src/harness/process/ -> repo root), mirrors `execute.test.ts`/`recovery.test.ts`.
const SCHEMA_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-project-agent-harness",
  "schemas",
);

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Deterministic deps: fixed clock, fresh monotonic id sequence per call.
// Mirrors `execute.test.ts`/`guard.test.ts`/`isolation.test.ts` `makeDeps()`.
// ---------------------------------------------------------------------------
function makeDeps(): RunContainedProcessDeps {
  let counter = 0;
  return {
    clock: () => "2026-07-13T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
  };
}

// ---------------------------------------------------------------------------
// Policy profile fixture — a `monitored-trusted-local` VARIANT with
// `defaults.shell: "allow"` (mirrors the variant-fixture convention in
// `isolation.test.ts`'s `containedChild`). None of the three frozen ADR-0003
// profiles default `shell` to `allow` (monitored asks; read-only/unattended
// deny), and this suite's happy path needs a DETERMINISTIC `guardAction`
// "allow" without composing approval/interactivity policy nuance — this
// fixture is exactly what the acceptance scenario itself describes: "a
// FUTURE shell tool" under "an approved argv and environment allowlist".
// ---------------------------------------------------------------------------
const shellAllowProfile: PolicyProfile = {
  schemaVersion: 1,
  profileId: "monitored-trusted-local",
  profileVersion: "1.0.0-shell-contained",
  fingerprint: sha256("monitored-trusted-local:1.0.0-shell-contained"),
  trustMode: "trusted-local",
  defaults: { read: "allow", write: "ask", shell: "allow", network: "ask", delegate: "ask" },
  requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
};

const shellRisk: ToolRisk = "shell";

// ---------------------------------------------------------------------------
// Command / allowlist / budget fixture builders.
// ---------------------------------------------------------------------------
const worktreeRoot = "/repo/worktree";
const envAllowlist = ["PATH", "NODE_ENV"];

function makeCommand(overrides: Partial<ContainedCommand> = {}): ContainedCommand {
  return {
    path: `${worktreeRoot}/bin/build.sh`,
    argv: ["build.sh", "--release"],
    env: { PATH: "/usr/bin:/bin", NODE_ENV: "production" },
    cwd: worktreeRoot,
    ...overrides,
  };
}

function makeAllowlist(
  overrides: Partial<RunContainedProcessInput["allowlist"]> = {},
): RunContainedProcessInput["allowlist"] {
  return {
    worktreeRoot,
    envAllowlist: [...envAllowlist],
    profile: shellAllowProfile,
    interactive: true,
    scanAvailable: true,
    risk: shellRisk,
    ...overrides,
  };
}

function makeBudget(overrides: Partial<BudgetReservation> = {}): BudgetReservation {
  return { reservationId: "res-process-1", maxRuntimeMs: 5_000, ...overrides };
}

function makeParentRemaining(overrides: Partial<ParentRemainingBudget> = {}): ParentRemainingBudget {
  return { maxRuntimeMs: 30_000, maxToolCalls: 10, ...overrides };
}

// ---------------------------------------------------------------------------
// Scripted observations — one per required test case. The FAKE adapter never
// computes these from timing/output-size; the scenario fully determines the
// scripted result (deterministic, offline).
// ---------------------------------------------------------------------------
const cleanObservation: ProcessObservation = {
  kind: "clean-exit",
  exitCode: 0,
  outputBytes: 128,
  observedHash: sha256("clean-exit-output"),
};

const timeoutObservation: ProcessObservation = {
  kind: "deadline-exceeded",
  terminationMode: "process-group",
  observedHash: sha256("deadline-exceeded-output"),
};

const overflowObservation: ProcessObservation = {
  kind: "output-overflow",
  outputBytes: 999_999,
  observedHash: sha256("output-overflow-output"),
};

const cancelledObservation: ProcessObservation = {
  kind: "cancelled",
  terminationMode: "process-group",
  observedHash: sha256("cancelled-output"),
};

const spawnErrorObservation: ProcessObservation = {
  kind: "spawn-error",
  errorMessage: "ENOENT: fake scripted spawn failure",
  observedHash: sha256("spawn-error-output"),
};

// ---------------------------------------------------------------------------
// FAKE process adapter — records calls IN-MEMORY ONLY. No real
// `node:child_process` spawn, no real fs, no network anywhere in this double.
// Exposes a spy (`spawnCalls`) plus group-kill / leader-kill counters so tests
// can assert spawn-count and which termination mode the (scripted) result
// represents.
// ---------------------------------------------------------------------------
class FakeProcessAdapter implements ProcessAdapter {
  spawnCalls: ContainedCommand[] = [];
  groupKillCount = 0;
  leaderKillCount = 0;

  constructor(private readonly observation: ProcessObservation) {}

  spawn(command: ContainedCommand): ProcessObservation {
    this.spawnCalls.push(command);
    if (this.observation.terminationMode === "process-group") this.groupKillCount += 1;
    if (this.observation.terminationMode === "leader-only") this.leaderKillCount += 1;
    return this.observation;
  }
}

function baseInput(overrides: Partial<RunContainedProcessInput> = {}): RunContainedProcessInput {
  return {
    command: makeCommand(),
    allowlist: makeAllowlist(),
    budget: makeBudget(),
    parentRemaining: makeParentRemaining(),
    outputLimitBytes: 1_000_000,
    adapter: new FakeProcessAdapter(cleanObservation),
    ...overrides,
  };
}

/** Root-independent expected fingerprint over the approved command + allowlist. */
function expectedInputHash(
  command: ContainedCommand,
  allowlist: RunContainedProcessInput["allowlist"],
): string {
  return actionFingerprint(
    { path: command.path, argv: command.argv, env: command.env },
    { worktreeRoot: allowlist.worktreeRoot, envAllowlist: allowlist.envAllowlist },
  );
}

/**
 * Runs `fn` with `globalThis.fetch` monkey-patched to throw if it is ever
 * called, then asserts it was NOT called. Mirrors `execute.test.ts`'s
 * `withFetchGuard`: `runContainedProcess` must never reach the network on any
 * path — the only "effect" surface is the injected FAKE `ProcessAdapter`.
 */
function withFetchGuard<T>(fn: () => T): T {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    callCount += 1;
    throw new Error(`runContainedProcess must never call fetch (args: ${JSON.stringify(args)})`);
  }) as unknown as typeof fetch;
  try {
    const result = fn();
    expect(callCount).toBe(0);
    return result;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------------
// (a) Happy path (SC_R04_SHELL_CONTAINMENT)
// ---------------------------------------------------------------------------
describe("runContainedProcess — happy path (SC_R04_SHELL_CONTAINMENT)", () => {
  test("approved argv+env, clean in-bounds exit -> completed with a schema-valid receipt + non-empty evidenceRefs, run in the approved cwd", () => {
    const command = makeCommand();
    const adapter = new FakeProcessAdapter(cleanObservation);
    const outcome: ContainedProcessOutcome = withFetchGuard(() =>
      runContainedProcess(baseInput({ command, adapter }), makeDeps()),
    );

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("expected a completed outcome");

    expect(outcome.evidenceRefs.length).toBeGreaterThan(0);
    expect(outcome.receipt.outcome).toBe("effect-confirmed");

    const validation = validateAgainstSchema("execution-receipt.schema.json", outcome.receipt, {
      schemaDir: SCHEMA_DIR,
    });
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);

    // The adapter (the only side-effecting surface) was invoked exactly once,
    // with the exact approved command — including the approved cwd.
    expect(adapter.spawnCalls).toHaveLength(1);
    expect(adapter.spawnCalls[0]).toEqual(command);
    expect(adapter.spawnCalls[0]?.cwd).toBe(worktreeRoot);
  });

  test("the receipt's inputHash matches the action fingerprint of path/argv/allowlisted env", () => {
    const command = makeCommand();
    const allowlist = makeAllowlist();
    const outcome = withFetchGuard(() =>
      runContainedProcess(
        baseInput({ command, allowlist, adapter: new FakeProcessAdapter(cleanObservation) }),
        makeDeps(),
      ),
    );
    if (outcome.kind !== "completed") throw new Error("expected a completed outcome");
    expect(outcome.receipt.inputHash).toBe(expectedInputHash(command, allowlist));
  });
});

// ---------------------------------------------------------------------------
// (b) Timeout (Release-0 SC_R04_TOOL_TIMEOUT runtime precedent)
// ---------------------------------------------------------------------------
describe("runContainedProcess — timeout bound enforced (SC_R04_TOOL_TIMEOUT precedent)", () => {
  test("a scripted observation that exceeds the reserved deadline -> timeout, NOT completed, receipt records a non-effect-confirmed outcome, group killed", () => {
    const adapter = new FakeProcessAdapter(timeoutObservation);
    const outcome: ContainedProcessOutcome = withFetchGuard(() =>
      runContainedProcess(baseInput({ adapter, budget: makeBudget({ maxRuntimeMs: 2_000 }) }), makeDeps()),
    );

    expect(outcome.kind).toBe("timeout");
    expect(outcome.kind).not.toBe("completed");
    if (outcome.kind !== "timeout") throw new Error("expected a timeout outcome");

    expect(outcome.receipt).toBeDefined();
    expect(outcome.receipt.outcome).not.toBe("effect-confirmed");

    const validation = validateAgainstSchema("execution-receipt.schema.json", outcome.receipt, {
      schemaDir: SCHEMA_DIR,
    });
    expect(validation.valid).toBe(true);

    expect(adapter.spawnCalls).toHaveLength(1);
    expect(adapter.groupKillCount).toBe(1);
    expect(adapter.leaderKillCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (c) Output overflow (Release-0 SC_R04_TOOL_OUTPUT_OVERFLOW runtime precedent)
// ---------------------------------------------------------------------------
describe("runContainedProcess — output overflow bounded (SC_R04_TOOL_OUTPUT_OVERFLOW precedent)", () => {
  test("scripted output beyond outputLimitBytes -> output-overflow, NOT success, no unbounded-retry signal (terminal outcome kind)", () => {
    const adapter = new FakeProcessAdapter(overflowObservation);
    const outcome: ContainedProcessOutcome = withFetchGuard(() =>
      runContainedProcess(baseInput({ adapter, outputLimitBytes: 1_024 }), makeDeps()),
    );

    expect(outcome.kind).toBe("output-overflow");
    expect(outcome.kind).not.toBe("completed");
    if (outcome.kind !== "output-overflow") throw new Error("expected an output-overflow outcome");
    expect(outcome.receipt.outcome).not.toBe("effect-confirmed");

    // Bounded/terminal: the outcome is one of the FIXED ContainedProcessOutcome
    // kinds — there is no open-ended "retry"/"pending" kind it could carry, so
    // an unbounded context-retry loop is structurally impossible here.
    const terminalKinds: ContainedProcessOutcome["kind"][] = [
      "completed",
      "timeout",
      "output-overflow",
      "cancelled",
      "blocked",
    ];
    expect(terminalKinds).toContain(outcome.kind);

    expect(adapter.spawnCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (d) Cancellation
// ---------------------------------------------------------------------------
describe("runContainedProcess — cancellation honored", () => {
  test("an external cancellation signal + a scripted cancel observation -> cancelled, NOT success, group killed", () => {
    const adapter = new FakeProcessAdapter(cancelledObservation);
    const outcome: ContainedProcessOutcome = withFetchGuard(() =>
      runContainedProcess(baseInput({ adapter, cancelled: true }), makeDeps()),
    );

    expect(outcome.kind).toBe("cancelled");
    expect(outcome.kind).not.toBe("completed");
    if (outcome.kind !== "cancelled") throw new Error("expected a cancelled outcome");
    expect(outcome.receipt.outcome).not.toBe("effect-confirmed");

    expect(adapter.spawnCalls).toHaveLength(1);
    expect(adapter.groupKillCount).toBe(1);
    expect(adapter.leaderKillCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (e) Unapproved argv/env — fail-closed, the security core
// ---------------------------------------------------------------------------
describe("runContainedProcess — unapproved argv/env fail-closed (the security core)", () => {
  test("an argv token carrying a shell metacharacter (injection) is blocked before spawn; the adapter's spawn is NEVER called", () => {
    const adapter = new FakeProcessAdapter(cleanObservation);
    const command = makeCommand({ argv: ["build.sh", "; rm -rf /"] });
    const outcome: ContainedProcessOutcome = withFetchGuard(() =>
      runContainedProcess(baseInput({ command, adapter }), makeDeps()),
    );

    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("expected a blocked outcome");
    expect(outcome.reason.length).toBeGreaterThan(0);
    expect(adapter.spawnCalls).toHaveLength(0);
  });

  test("a command-substitution injection argv token is blocked before spawn; adapter never called", () => {
    const adapter = new FakeProcessAdapter(cleanObservation);
    const command = makeCommand({ argv: ["build.sh", "$(cat /etc/passwd)"] });
    const outcome = withFetchGuard(() => runContainedProcess(baseInput({ command, adapter }), makeDeps()));

    expect(outcome.kind).toBe("blocked");
    expect(adapter.spawnCalls).toHaveLength(0);
  });

  test("an env var outside the allowlist present on the command is blocked before spawn; adapter never called", () => {
    const adapter = new FakeProcessAdapter(cleanObservation);
    const command = makeCommand({
      env: { PATH: "/usr/bin:/bin", NODE_ENV: "production", AWS_SECRET_ACCESS_KEY: "leaked-secret" },
    });
    const outcome: ContainedProcessOutcome = withFetchGuard(() =>
      runContainedProcess(baseInput({ command, adapter }), makeDeps()),
    );

    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("expected a blocked outcome");
    expect(outcome.reason.length).toBeGreaterThan(0);
    expect(adapter.spawnCalls).toHaveLength(0);
  });

  test("a path that escapes the approved worktree root is blocked before spawn (reuses guardAction traversal denial); adapter never called", () => {
    const adapter = new FakeProcessAdapter(cleanObservation);
    const command = makeCommand({ path: "/etc/passwd", argv: ["cat", "/etc/passwd"] });
    const outcome = withFetchGuard(() => runContainedProcess(baseInput({ command, adapter }), makeDeps()));

    expect(outcome.kind).toBe("blocked");
    expect(adapter.spawnCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (f) Budget breach — reuses W12 inheritBudget fail-closed semantics
// ---------------------------------------------------------------------------
describe("runContainedProcess — budget breach fail-closed (reuses inheritBudget)", () => {
  test("budget.maxRuntimeMs exceeding parentRemaining.maxRuntimeMs -> blocked, adapter never called", () => {
    const adapter = new FakeProcessAdapter(cleanObservation);
    const budget = makeBudget({ maxRuntimeMs: 60_000 });
    const parentRemaining = makeParentRemaining({ maxRuntimeMs: 30_000 });

    const outcome: ContainedProcessOutcome = withFetchGuard(() =>
      runContainedProcess(baseInput({ adapter, budget, parentRemaining }), makeDeps()),
    );

    expect(outcome.kind).toBe("blocked");
    expect(adapter.spawnCalls).toHaveLength(0);

    // Confirms this reuses `inheritBudget`'s own fail-closed verdict, not a
    // separately-invented rule.
    const direct = inheritBudget(parentRemaining, budget);
    expect(direct.ok).toBe(false);
  });

  test("a budget request exactly equal to the parent's remaining is NOT blocked on this ground (boundary, not exceeding)", () => {
    const adapter = new FakeProcessAdapter(cleanObservation);
    const budget = makeBudget({ maxRuntimeMs: 30_000 });
    const parentRemaining = makeParentRemaining({ maxRuntimeMs: 30_000 });

    const outcome = withFetchGuard(() =>
      runContainedProcess(baseInput({ adapter, budget, parentRemaining }), makeDeps()),
    );
    expect(outcome.kind).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// (g) Spawn-error / ambiguous observation — never a false "completed"
// ---------------------------------------------------------------------------
describe("runContainedProcess — spawn-error / ambiguous observation never reports completed", () => {
  test("a scripted spawn-error observation yields a non-completed terminal outcome", () => {
    const adapter = new FakeProcessAdapter(spawnErrorObservation);
    const outcome: ContainedProcessOutcome = withFetchGuard(() =>
      runContainedProcess(baseInput({ adapter }), makeDeps()),
    );

    expect(outcome.kind).not.toBe("completed");
    const acceptableKinds: ContainedProcessOutcome["kind"][] = ["blocked", "timeout", "output-overflow", "cancelled"];
    expect(acceptableKinds).toContain(outcome.kind);
  });
});

// ---------------------------------------------------------------------------
// (h) No-orphan: process-GROUP kill, never leader-only, on timeout and cancel
// ---------------------------------------------------------------------------
describe("runContainedProcess — no-orphan: process-group kill (not leader-only) on timeout and cancel", () => {
  test("timeout kills the process GROUP, not just the leader", () => {
    const adapter = new FakeProcessAdapter(timeoutObservation);
    withFetchGuard(() => runContainedProcess(baseInput({ adapter }), makeDeps()));
    expect(adapter.groupKillCount).toBe(1);
    expect(adapter.leaderKillCount).toBe(0);
  });

  test("cancellation kills the process GROUP, not just the leader", () => {
    const adapter = new FakeProcessAdapter(cancelledObservation);
    withFetchGuard(() => runContainedProcess(baseInput({ adapter, cancelled: true }), makeDeps()));
    expect(adapter.groupKillCount).toBe(1);
    expect(adapter.leaderKillCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (b2) exitCode surfaced on the `completed` outcome (review-hardening fix #2)
// ---------------------------------------------------------------------------
// RED today: `ContainedProcessOutcome`'s `completed` variant carries only
// `{kind:"completed", receipt, evidenceRefs}` — the observation's `exitCode` is
// never copied onto the outcome, so a caller that needs the real exit status
// (e.g. to distinguish a command's own `exit 2` from a clean `exit 0`) has no
// way to read it without reaching into adapter internals. This pins the fix:
// `outcome.exitCode` must equal the observation's `exitCode` on every
// `completed` outcome, including a non-zero in-bounds exit (still
// containment-`completed`, not a new outcome kind).
describe("runContainedProcess — completed outcome surfaces the real exitCode (review-hardening fix #2)", () => {
  test("a clean-exit observation carrying exitCode:0 surfaces exitCode:0 on the OUTCOME itself", () => {
    const adapter = new FakeProcessAdapter({ ...cleanObservation, exitCode: 0 });
    const outcome: ContainedProcessOutcome = withFetchGuard(() =>
      runContainedProcess(baseInput({ adapter }), makeDeps()),
    );

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("expected a completed outcome");
    expect((outcome as unknown as { exitCode?: number }).exitCode).toBe(0);
  });

  test("a clean-exit observation carrying a non-zero in-bounds exitCode:2 is still `completed`, with exitCode:2 recoverable from the outcome", () => {
    const nonZeroCleanObservation: ProcessObservation = { ...cleanObservation, exitCode: 2 };
    const adapter = new FakeProcessAdapter(nonZeroCleanObservation);
    const outcome: ContainedProcessOutcome = withFetchGuard(() =>
      runContainedProcess(baseInput({ adapter }), makeDeps()),
    );

    // Containment semantics: a non-zero command exit is still a confirmed,
    // in-bounds clean exit — NOT reclassified as `blocked`/`output-overflow`/etc.
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("expected a completed outcome");
    expect((outcome as unknown as { exitCode?: number }).exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// (h2) Mutation-proof branch pins (review-hardening fix #4)
// ---------------------------------------------------------------------------
// These pin two executor branches that are reachable today but were previously
// UNPINNED by any test (a mutation deleting either clause would still pass the
// suite as it stood). They may already PASS against the current impl — that is
// expected and desired; they lock the behavior rather than drive new code.
describe("runContainedProcess — mutation-proof branch pins (review-hardening fix #4)", () => {
  test("(4a) a CLEAN observation + input.cancelled:true is reclassified to `cancelled` (NOT `completed`) — pins the `|| input.cancelled === true` clause", () => {
    const adapter = new FakeProcessAdapter(cleanObservation); // kind: "clean-exit", NOT "cancelled"
    const outcome: ContainedProcessOutcome = withFetchGuard(() =>
      runContainedProcess(baseInput({ adapter, cancelled: true }), makeDeps()),
    );

    // If the `|| input.cancelled === true` disjunct were removed, a clean
    // observation would fall through to `completed` here — this assertion
    // fails under that mutation.
    expect(outcome.kind).toBe("cancelled");
    expect(outcome.kind).not.toBe("completed");
  });

  test("(4b) a CLEAN observation whose outputBytes exceeds the run's OWN outputLimitBytes is reclassified to `output-overflow` — pins the executor's finer-limit reclassification", () => {
    const adapter = new FakeProcessAdapter(cleanObservation); // kind: "clean-exit", outputBytes: 128
    const outcome: ContainedProcessOutcome = withFetchGuard(() =>
      runContainedProcess(baseInput({ adapter, outputLimitBytes: 64 }), makeDeps()),
    );

    // The observation kind is "clean-exit", not "output-overflow" — only the
    // executor's own outputBytes > outputLimitBytes comparison can produce this.
    expect(outcome.kind).toBe("output-overflow");
    expect(outcome.kind).not.toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// (j) Evidence causal ids reuse caller-supplied run/session/correlation ids
// (review-polish item A, flow 028/T5).
//
// RED today: `RunContainedProcessInput` carries no `runId`/`sessionId`/
// `correlationId` fields, and `buildEvidence` always mints FRESH ids from
// `deps.idSeq()` for `causal.runId`/`sessionId`/`correlationId` regardless of
// any caller-known identifiers — so a caller can never correlate the built
// evidence back to the run/session/correlation it actually belongs to.
//
// PINNED NAMES for T6: add OPTIONAL `runId?: string`, `sessionId?: string`,
// `correlationId?: string` directly on `RunContainedProcessInput`; when
// present, `buildEvidence` must thread them onto `EvidenceRecord.causal.runId`/
// `sessionId`/`correlationId` INSTEAD OF minting fresh `deps.idSeq()` values
// for those three fields (idSeq is still used for `evidenceId`/`artifactId`/
// `provenanceId`, which have no caller-known equivalent).
//
// This test also assumes the built `EvidenceRecord` becomes reachable off the
// `completed` outcome (as an `evidence` field, mirroring how `exitCode` was
// surfaced onto the outcome by the review-hardening fix #2 tests above) so the
// causal ids are inspectable from the public API; if T6 chooses a different
// way to expose them, the causal-id-reuse CONTRACT itself (not this exact
// access path) is what must hold.
// ---------------------------------------------------------------------------
describe("runContainedProcess — evidence causal ids reuse caller-supplied ids (review-polish item A)", () => {
  test("runId/sessionId/correlationId supplied on the input equal the built evidence's causal ids, not fresh idSeq values", () => {
    const adapter = new FakeProcessAdapter(cleanObservation);
    const inputWithCausalIds = {
      ...baseInput({ adapter }),
      runId: "run-external-1",
      sessionId: "session-external-1",
      correlationId: "corr-external-1",
    } as unknown as RunContainedProcessInput;

    const outcome: ContainedProcessOutcome = withFetchGuard(() =>
      runContainedProcess(inputWithCausalIds, makeDeps()),
    );

    expect(outcome.kind).toBe("completed");
    const evidence = (
      outcome as unknown as {
        evidence?: { causal: { runId: string; sessionId: string; correlationId: string } };
      }
    ).evidence;

    expect(evidence).toBeDefined();
    expect(evidence?.causal.runId).toBe("run-external-1");
    expect(evidence?.causal.sessionId).toBe("session-external-1");
    expect(evidence?.causal.correlationId).toBe("corr-external-1");
  });
});

// ---------------------------------------------------------------------------
// (k) outcome.evidenceRefs use the SAME prefixed encoding as receipt.evidenceRefs
// (review-polish item F, flow 028/T5).
//
// RED today: `outcome.evidenceRefs` is `[evidence.evidenceId]` — a BARE id —
// while `receipt.evidenceRefs` prefixes its evidence entry as
// `evidence:${evidence.evidenceId}`. A caller reading `outcome.evidenceRefs`
// alone cannot tell which encoding convention a given string follows, unlike
// the receipt's own self-describing convention.
// ---------------------------------------------------------------------------
describe("runContainedProcess — outcome.evidenceRefs match the receipt's prefixed encoding (review-polish item F)", () => {
  test("a completed outcome's evidenceRefs entries are prefixed 'evidence:' like the receipt's, not a bare evidenceId", () => {
    const adapter = new FakeProcessAdapter(cleanObservation);
    const outcome: ContainedProcessOutcome = withFetchGuard(() =>
      runContainedProcess(baseInput({ adapter }), makeDeps()),
    );

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("expected a completed outcome");

    expect(outcome.evidenceRefs.length).toBeGreaterThan(0);
    for (const ref of outcome.evidenceRefs) {
      expect(ref.startsWith("evidence:")).toBe(true);
    }
    const receiptEvidenceRef = outcome.receipt.evidenceRefs.find((ref) => ref.startsWith("evidence:"));
    expect(receiptEvidenceRef).toBeDefined();
    if (receiptEvidenceRef === undefined) throw new Error("expected the receipt to carry an evidence: ref");
    expect(outcome.evidenceRefs).toContain(receiptEvidenceRef);
  });
});

// ---------------------------------------------------------------------------
// (i) Determinism
// ---------------------------------------------------------------------------
describe("runContainedProcess — determinism (no Date.now/Math.random)", () => {
  test("same input + same deps twice yields deep-equal outcomes", () => {
    const command = makeCommand();
    const run1 = withFetchGuard(() =>
      runContainedProcess(
        baseInput({ command, adapter: new FakeProcessAdapter(cleanObservation) }),
        makeDeps(),
      ),
    );
    const run2 = withFetchGuard(() =>
      runContainedProcess(
        baseInput({ command, adapter: new FakeProcessAdapter(cleanObservation) }),
        makeDeps(),
      ),
    );

    expect(run1).toEqual(run2);
  });

  test("a blocked outcome is also deterministic across two identical runs", () => {
    const command = makeCommand({ argv: ["build.sh", "; rm -rf /"] });
    const run1 = withFetchGuard(() =>
      runContainedProcess(
        baseInput({ command, adapter: new FakeProcessAdapter(cleanObservation) }),
        makeDeps(),
      ),
    );
    const run2 = withFetchGuard(() =>
      runContainedProcess(
        baseInput({ command, adapter: new FakeProcessAdapter(cleanObservation) }),
        makeDeps(),
      ),
    );
    expect(run1).toEqual(run2);
  });
});

// ---------------------------------------------------------------------------
// No real fs/network mutation anywhere (mirrors execute.test.ts section 5)
// ---------------------------------------------------------------------------
describe("runContainedProcess — no real fs/network anywhere", () => {
  test("never calls fetch on the happy path", () => {
    withFetchGuard(() => runContainedProcess(baseInput({ adapter: new FakeProcessAdapter(cleanObservation) }), makeDeps()));
  });

  test("never calls fetch on a blocked path", () => {
    const command = makeCommand({ argv: ["env"] });
    withFetchGuard(() =>
      runContainedProcess(baseInput({ command, adapter: new FakeProcessAdapter(cleanObservation) }), makeDeps()),
    );
  });
});
