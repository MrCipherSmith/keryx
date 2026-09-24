// W6 Wave-1 exit criterion guard tests (flow 306, W6, task T7).
//
// AC2 (W6-AC2): no hook or combination of hooks may turn a `decide()` deny
// into `allow` or `ask`, under any of the three real security profiles, for
// both a HARD deny (`hardDeny: true`, unoverridable per ADR-0003) and a
// baseline (non-hard) deny. This drives the FULL offline loop (`runOffline`)
// with a real `createHookRuntime` over a scripted fake `HookProcessRunner`,
// so the guarantee is proven at the point it actually matters: the composed
// decision `run.ts` gates execution on.
//
// A second describe block sweeps the pure primitives (`composeDecision` +
// `failureEffect`) directly over decide-outcome x hook-result x class x
// profile x interactive, asserting the same non-loosening invariant using
// `OUTCOME_RANK` (deny=0 < ask=1 < allow=2): a hook (or a hook's failure
// effect) may only keep or LOWER that rank, never raise it, and a hook `ask`
// under `interactive: false` always resolves to `deny`.
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { HarnessConfig } from "../config";
import { composeDecision } from "./compose";
import { createHookRuntime } from "./runtime";
import { failureEffect } from "./semantics";
import type { HookProcessRunner, HookRunRequest, HookRunResult } from "./runner";
import type { HookRegistration, HookClass, HookFailureKind } from "./types";
import { FakeProvider, type FakeProviderTranscript, requestHashOf } from "../provider/fake-provider";
import type { NormalizedRequest, ProviderPort } from "../provider/types";
import { decide } from "../policy/engine";
import { OUTCOME_RANK } from "../policy/ranks";
import { LOCAL_PROFILE_NAMES, resolveLocalProfile } from "../policy/profiles";
import type { LocalProfileName } from "../policy/profiles";
import type { PolicyContext, PolicyDecision, PolicyOutcome, PolicyProfile, PolicyProfileId } from "../policy/types";
import { FakeToolExecutor } from "../tool/fake-tool";
import { ToolRegistry } from "../tool/registry";
import type { ToolDefinition, ToolRisk } from "../tool/types";
import type { HarnessRunInput } from "../types";
import { runOffline } from "../run/run";
import type { RunDeps, RunResult } from "../run/run";

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


function makeClockIdSeq(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return { clock: () => "2026-01-01T00:00:00.000Z", idSeq: () => `id-${counter++}` };
}

function buildConfig(): HarnessConfig {
  return {
    schemaVersion: 1,
    enabled: true,
    defaultRole: "build",
    defaultProvider: "fake-provider",
    defaultModel: "fixture-model",
    policyProfile: "read-only-review",
    limits: { maxRunSeconds: 300, maxConcurrentChildren: 1, maxToolOutputBytes: 65_536, maxRetries: 1 },
  };
}

function buildInput(overrides?: Partial<HarnessRunInput>): HarnessRunInput {
  return {
    schemaVersion: 1,
    request: "run the fixture scenario",
    projectRoot: "/repo",
    role: "build",
    policy: "read-only-review",
    budget: { maxSeconds: 60, maxToolCalls: 5, maxRetries: 1 },
    provider: "fake-provider",
    model: "fixture-model",
    credentialRef: "cred-ref-1",
    ...overrides,
  };
}

/** A minimal tool definition of the given risk, accepting any object input. */
function makeTool(toolId: string, risk: ToolRisk): ToolDefinition {
  return {
    schemaVersion: 1,
    toolId,
    version: "0.1.0",
    description: `Guard-test fixture tool (${risk}).`,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    risk,
    capabilities: [risk],
    limits: { timeoutMs: 1_000, maxOutputBytes: 65_536, concurrencyKey: toolId },
    replay: { deterministic: true, recordedResultSupported: true },
    classification: {
      read: risk === "read",
      write: risk === "write" || risk === "destructive",
      network: risk === "network",
      subprocess: risk === "shell",
      credential: risk === "credential",
    },
  };
}

function buildRegistry(...defs: ToolDefinition[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const def of defs) registry.register(def);
  return registry;
}

function makeTranscript(
  transcriptId: string,
  calls: { toolCallId: string; toolName: string; input: Record<string, unknown> }[],
): FakeProviderTranscript {
  const events: FakeProviderTranscript["events"] = [
    ...calls.map((call, index) => ({
      sequence: index,
      kind: "tool_call" as const,
      payload: { toolName: call.toolName, toolCallId: call.toolCallId, input: call.input },
    })),
    { sequence: calls.length, kind: "text_delta" as const, payload: { text: "Task complete." } },
    { sequence: calls.length + 1, kind: "finish" as const, payload: {} },
  ];
  return {
    schemaVersion: 1,
    transcriptId,
    providerId: "fake-provider",
    providerRevision: "fake-1.0.0",
    requestHash: "0".repeat(64),
    events,
  };
}

function buildFixtureRequest(requestId: string): NormalizedRequest {
  return {
    providerId: "fake-provider",
    modelId: "fixture-model",
    systemInstruction: "fixture system instruction",
    messages: [{ role: "user", content: "fixture prompt" }],
    budget: { maxOutputTokens: 1000, runReservation: 1000 },
    stream: true,
    requestId,
    parentRunId: "run-fixture",
  };
}

function fixtureProvider(transcript: FakeProviderTranscript, requestId: string): ProviderPort {
  const request = buildFixtureRequest(requestId);
  const stamped: FakeProviderTranscript = { ...transcript, requestHash: requestHashOf(request) };
  const fake = new FakeProvider([stamped]);
  return {
    describe: () => fake.describe(),
    stream: (_request, opts) => fake.stream(request, opts),
  };
}

/**
 * One scripted hook-process outcome, or `{ timeoutSim: true }`. `fire()` only
 * races the observe/context PARALLEL group against `timeoutMs` itself; a
 * `gate`/`gate-advisory` hook's timeout has to come from the runner, exactly
 * as the real spawn-based runner enforces it (`spawnAndCollect`'s own
 * `setTimeout` + kill). So `timeoutSim` resolves after `req.timeoutMs` with
 * `timedOut: true`, rather than hanging forever — a real hang here would hang
 * `fire()` itself for a gate-class hook, not exercise the timeout path.
 */
type ScriptedResult = HookRunResult | { timeoutSim: true };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeScriptedRunner(script: Record<string, ScriptedResult>): { runner: HookProcessRunner; calls: HookRunRequest[] } {
  const calls: HookRunRequest[] = [];
  const runner: HookProcessRunner = {
    async run(req: HookRunRequest): Promise<HookRunResult> {
      calls.push(req);
      const key = req.argv[1] ?? "";
      const scripted = script[key];
      if (scripted === undefined) {
        return { exitCode: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "", timedOut: false, durationMs: 1 };
      }
      if ("timeoutSim" in scripted) {
        await delay(req.timeoutMs);
        return { exitCode: null, stdout: "", stderr: "", timedOut: true, durationMs: req.timeoutMs };
      }
      return scripted;
    },
  };
  return { runner, calls };
}

const SCRIPTS: Record<string, ScriptedResult> = {
  allow: { exitCode: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "", timedOut: false, durationMs: 1 },
  ask: { exitCode: 0, stdout: JSON.stringify({ decision: "ask" }), stderr: "", timedOut: false, durationMs: 1 },
  malformed: { exitCode: 0, stdout: "not valid json {{{", stderr: "", timedOut: false, durationMs: 1 },
  "exit0-empty": { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 },
  crash: { exitCode: 1, stdout: "", stderr: "boom", timedOut: false, durationMs: 1 },
  timeout: { timeoutSim: true },
};

function commandReg(overrides: Partial<HookRegistration> & { id: string; event: HookRegistration["event"] }): HookRegistration {
  return {
    matcher: "*",
    class: "gate",
    handler: { kind: "command", argv: ["fake", overrides.id] },
    timeoutMs: 20,
    runsIn: "sandbox",
    network: "none",
    appliesToChildAgents: true,
    profiles: [],
    enabled: true,
    scope: "project",
    order: 0,
    ...overrides,
  };
}

/**
 * The per-profile deny scenarios this suite drives. Computed from the frozen
 * profile defaults (`profiles.ts`) rather than re-declared: a hard-deny risk
 * is one of `write`/`shell`/`network`/`delegate` whose profile default is
 * itself `deny` (ADR-0003 `HARD_DENY_RISKS`); a baseline (non-hard) deny is
 * reached either directly (`credential`/`destructive` fall back to the
 * profile's `write` default, which denies without being a hard-deny risk) or
 * via the headless fail-closed rule (`interactive: false` turns a baseline
 * `ask` into `deny`, still `hardDeny: false`).
 *
 * `monitored-trusted-local`'s defaults (`write: ask`, `shell: allow`,
 * `network: ask`, `delegate: ask`) put no risk in a deny default, so no
 * hard-deny scenario is reachable for it through `decide()` as `run.ts`
 * calls it — the ONLY other deny source, the managed flow-file guard, is
 * likewise unreachable because `run.ts` never sets
 * `PolicyContext.targetPath`. That profile's hard-deny case is therefore
 * skipped, with this comment as the recorded reason (task T7 instruction:
 * "skip if run.ts never sets targetPath and say so").
 */
const PROFILE_SCENARIOS: Array<{
  name: LocalProfileName;
  hard?: { risk: ToolRisk; interactive: boolean };
  baseline: { risk: ToolRisk; interactive: boolean };
}> = [
  {
    name: "read-only-review",
    hard: { risk: "write", interactive: true },
    baseline: { risk: "credential", interactive: true },
  },
  {
    name: "monitored-trusted-local",
    // No hard-deny risk reachable (see comment above) — omitted, not faked.
    baseline: { risk: "write", interactive: false },
  },
  {
    name: "unattended-untrusted",
    hard: { risk: "network", interactive: true },
    baseline: { risk: "write", interactive: false },
  },
];

/** Sanity: the scenario table actually produces what its comment claims, independent of `runOffline`. */
function assertScenarioShape(profile: PolicyProfile, scenario: { risk: ToolRisk; interactive: boolean }, expectHard: boolean): void {
  const ctx: PolicyContext = {
    profile,
    interactive: scenario.interactive,
    approvals: [],
    actionFingerprint: "af-sanity",
  };
  const decision = decide({ toolCallId: "sanity", risk: scenario.risk }, ctx, makeClockIdSeq());
  expect(decision.decision).toBe("deny");
  expect((decision as PolicyDecision & { hardDeny?: boolean }).hardDeny).toBe(expectHard);
}

for (const scenario of PROFILE_SCENARIOS) {
  const profile = resolveLocalProfile(scenario.name);
  test(`sanity: ${scenario.name} baseline scenario is a non-hard deny`, () => {
    assertScenarioShape(profile, scenario.baseline, false);
  });
  const hardScenario = scenario.hard;
  if (hardScenario !== undefined) {
    test(`sanity: ${scenario.name} hard scenario is a hard deny`, () => {
      assertScenarioShape(profile, hardScenario, true);
    });
  }
}

test("sanity: PROFILE_SCENARIOS covers exactly the three frozen local profiles", () => {
  expect(PROFILE_SCENARIOS.map((s) => s.name)).toEqual([...LOCAL_PROFILE_NAMES]);
});

/** One end-to-end drive of `runOffline` for a single (profile, risk, interactive, hookScriptCombo). */
async function driveGuardScenario(opts: {
  profile: PolicyProfile;
  risk: ToolRisk;
  interactive: boolean;
  hookScripts: string[]; // e.g. ["allow"], ["allow","ask"], ["malformed"], ["timeout"]...
}): Promise<{ result: RunResult; decision: PolicyDecision | undefined; runnerCalls: HookRunRequest[] }> {
  const toolId = `fixture.${opts.risk}`;
  const registry = buildRegistry(makeTool(toolId, opts.risk));
  const transcript = makeTranscript(`t-${opts.risk}-${opts.hookScripts.join("-")}`, [
    { toolCallId: "call-1", toolName: toolId, input: { key: "value" } },
  ]);
  const provider = fixtureProvider(transcript, `req-${opts.risk}-${opts.hookScripts.join("-")}-${opts.interactive}`);
  const executor = new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR });

  const script: Record<string, ScriptedResult> = {};
  const registrations: HookRegistration[] = opts.hookScripts.map((name, index) => {
    const hookId = `${name}-${index}`;
    script[hookId] = SCRIPTS[name] ?? SCRIPTS.allow!;
    return commandReg({ id: hookId, event: "PreToolUse", order: index });
  });
  const { runner, calls } = makeScriptedRunner(script);

  const { clock, idSeq } = makeClockIdSeq();
  const runtime = createHookRuntime({
    registrations,
    runner,
    clock,
    profileId: opts.profile.profileId,
    interactive: opts.interactive,
    sessionId: "session-guard",
    runId: "run-guard",
    projectRoot: "/repo",
  });

  const deps: RunDeps = {
    provider,
    toolRegistry: registry,
    toolExecutor: executor,
    policyProfile: opts.profile,
    clock,
    idSeq,
    interactive: opts.interactive,
    hooks: runtime,
  };

  const result = await runOffline(buildInput(), buildConfig(), deps);
  const decision = result.decisions.find((d) => d.toolCallId === "call-1");
  return { result, decision, runnerCalls: calls };
}

describe("W6 exit criterion: a hook can never turn a policy deny into allow or ask", () => {
  const HOOK_COMBOS: string[][] = [
    ["allow"],
    ["ask"],
    ["malformed"],
    ["exit0-empty"],
    ["crash"],
    ["timeout"],
    ["allow", "allow"],
    ["allow", "ask"],
    ["ask", "allow"],
    ["allow", "malformed"],
    ["malformed", "ask"],
  ];

  for (const scenario of PROFILE_SCENARIOS) {
    const profile = resolveLocalProfile(scenario.name);

    describe(`profile ${scenario.name} — baseline (non-hard) deny`, () => {
      for (const combo of HOOK_COMBOS) {
        test(`hooks=[${combo.join(",")}] never loosen a baseline deny`, async () => {
          const { decision, result } = await driveGuardScenario({
            profile,
            risk: scenario.baseline.risk,
            interactive: scenario.baseline.interactive,
            hookScripts: combo,
          });
          expect(decision?.decision).toBe("deny");
          expect((decision as (PolicyDecision & { hardDeny?: boolean }) | undefined)?.hardDeny).toBe(false);
          // The executor was never invoked: no tool_result session entry, no
          // recorded artifact from executing the call.
          expect(result.sessionEntries.some((e) => e.entry.type === "tool_result")).toBe(false);
          expect(result.output.metrics.toolCalls).toBe(0);
        });
      }
    });

    if (scenario.hard !== undefined) {
      const hard = scenario.hard;
      describe(`profile ${scenario.name} — HARD deny`, () => {
        for (const combo of HOOK_COMBOS) {
          test(`hooks=[${combo.join(",")}] never loosen a hard deny (hardDeny stays true)`, async () => {
            const { decision, result } = await driveGuardScenario({
              profile,
              risk: hard.risk,
              interactive: hard.interactive,
              hookScripts: combo,
            });
            expect(decision?.decision).toBe("deny");
            expect((decision as (PolicyDecision & { hardDeny?: boolean }) | undefined)?.hardDeny).toBe(true);
            expect(result.sessionEntries.some((e) => e.entry.type === "tool_result")).toBe(false);
            expect(result.output.metrics.toolCalls).toBe(0);
          });
        }
      });
    } else {
      test(`profile ${scenario.name} — hard deny is not reachable via run.ts's decide() call (documented, not tested)`, () => {
        // See PROFILE_SCENARIOS' doc comment: no risk defaults to deny under
        // this profile, and run.ts never sets ctx.targetPath (the only other
        // deny source, the flow-file guard, is therefore also unreachable).
        expect(scenario.hard).toBeUndefined();
      });
    }
  }
});

describe("W6 exit criterion: property sweep over composeDecision + failureEffect", () => {
  const PROFILE_IDS: readonly PolicyProfileId[] = ["read-only-review", "monitored-trusted-local", "unattended-untrusted"];
  const CLASSES: readonly HookClass[] = ["gate", "gate-advisory", "observe", "context"];
  const FAILURES: readonly HookFailureKind[] = ["timeout", "crash", "malformed"];
  const DECIDE_OUTCOMES: Array<{ decision: PolicyOutcome; hardDeny: boolean }> = [
    { decision: "allow", hardDeny: false },
    { decision: "ask", hardDeny: false },
    { decision: "deny", hardDeny: false },
    { decision: "deny", hardDeny: true },
  ];

  function policyDecisionOf(decision: PolicyOutcome, hardDeny: boolean): PolicyDecision & { hardDeny?: boolean } {
    return {
      schemaVersion: 1,
      decisionId: "d1",
      toolCallId: "tc1",
      decision,
      policyProfile: "profile-under-test",
      timestamp: "2026-01-01T00:00:00.000Z",
      matchedRules: ["base:rule"],
      hardDeny,
    };
  }

  test("a failed hook's contributed decision, composed against every decide() outcome, never raises OUTCOME_RANK", () => {
    for (const decideOutcome of DECIDE_OUTCOMES) {
      for (const cls of CLASSES) {
        for (const failure of FAILURES) {
          for (const profileId of PROFILE_IDS) {
            for (const interactive of [true, false]) {
              const effect = failureEffect({ cls, event: "PreToolUse", failure, profileId, decideOutcome: decideOutcome.decision });
              const hookDecision: PolicyOutcome | undefined = effect.effect === "deny" ? "deny" : undefined;
              const hooks = hookDecision !== undefined ? [{ hookId: "h", decision: hookDecision }] : [];
              const policy = policyDecisionOf(decideOutcome.decision, decideOutcome.hardDeny);
              const composed = composeDecision(policy, hooks, { interactive });

              const before = OUTCOME_RANK[decideOutcome.decision];
              const after = OUTCOME_RANK[composed.decision];
              expect(after).toBeLessThanOrEqual(before);

              if (decideOutcome.decision === "deny") {
                // Untouchable, hard or not.
                expect(composed.decision).toBe("deny");
                expect((composed as PolicyDecision & { hardDeny?: boolean }).hardDeny).toBe(decideOutcome.hardDeny);
              }
            }
          }
        }
      }
    }
  });

  test("a clean hook decision, composed against every decide() outcome x profile x interactive, never raises OUTCOME_RANK; ask -> deny when headless", () => {
    const HOOK_DECISIONS: Array<PolicyOutcome | undefined> = [undefined, "allow", "ask", "deny"];
    for (const decideOutcome of DECIDE_OUTCOMES) {
      for (const hookDecision of HOOK_DECISIONS) {
        for (const profileId of PROFILE_IDS) {
          for (const interactive of [true, false]) {
            const policy = policyDecisionOf(decideOutcome.decision, decideOutcome.hardDeny);
            policy.policyProfile = profileId;
            const hooks = hookDecision !== undefined ? [{ hookId: "h", decision: hookDecision }] : [];
            const composed = composeDecision(policy, hooks, { interactive });

            const before = OUTCOME_RANK[decideOutcome.decision];
            const after = OUTCOME_RANK[composed.decision];
            expect(after).toBeLessThanOrEqual(before);

            if (decideOutcome.decision !== "deny" && hookDecision === "ask" && interactive === false) {
              expect(composed.decision).toBe("deny");
            }
            if (decideOutcome.decision === "deny") {
              expect(composed.decision).toBe("deny");
              expect((composed as PolicyDecision & { hardDeny?: boolean }).hardDeny).toBe(decideOutcome.hardDeny);
            }
          }
        }
      }
    }
  });
});
