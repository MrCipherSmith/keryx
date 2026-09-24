// Failure-semantics matrix through the hook RUNTIME (flow 306, W6, task T7).
//
// `semantics.test.ts` already pins `failureEffect` as a pure function; this
// file proves the runtime actually WIRES that table through `createHookRuntime`
// (`fire()`'s per-hook `HookInvocationRecord`/`HookWarning`) and, for the
// events the W6 spec ties to `run.ts`'s own semantics, through `runOffline`
// end-to-end. Every failure is driven by a scripted fake `HookProcessRunner` —
// no real timers longer than the hook's own (small) `timeoutMs`, no real
// process spawn.
//
// Covers (AC5): gate timeout/crash deny in all three profiles; gate malformed
// silent-approves unless decide() said `ask` (in which case deny) — proven
// end-to-end through `runOffline` post-T7 fix, since only `runOffline` knows
// what `decide()` said; gate-advisory fails open (`hook-advisory-failed`) in
// read-only-review/monitored-trusted-local and fails closed in
// unattended-untrusted; observe/context/SessionStart fail open with a
// recorded warning in every profile.
//
// Covers (AC4): an observe hook that crashes, and one that never resolves
// until its own timeout, do not block `fire()` past that timeout, do not
// change the observed tool result in `runOffline`, and record
// `hook-observer-failed`.
//
// Covers (AC9, runOffline part): `interactive: false` + a gate hook `ask` on
// a call `decide()` would `allow` resolves to `deny`.
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { HarnessConfig } from "../config";
import { createHookRuntime } from "./runtime";
import type { HookProcessRunner, HookRunRequest, HookRunResult } from "./runner";
import type { HookClass, HookEventName, HookRegistration } from "./types";
import { FakeProvider, type FakeProviderTranscript, requestHashOf } from "../provider/fake-provider";
import type { NormalizedRequest, ProviderPort } from "../provider/types";
import { resolveLocalProfile } from "../policy/profiles";
import type { PolicyProfileId } from "../policy/types";
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

const CLOCK = () => "2026-01-01T00:00:00.000Z";

function makeClockIdSeq(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return { clock: CLOCK, idSeq: () => `id-${counter++}` };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Raw process outcomes the fake runner can produce; `timeoutSim` waits out `req.timeoutMs` itself (see guard.test.ts's identical rationale). */
type ScriptedResult = HookRunResult | { timeoutSim: true };

function makeScriptedRunner(script: Record<string, ScriptedResult>): { runner: HookProcessRunner; calls: HookRunRequest[] } {
  const calls: HookRunRequest[] = [];
  const runner: HookProcessRunner = {
    async run(req: HookRunRequest): Promise<HookRunResult> {
      calls.push(req);
      const key = req.argv[1] ?? "";
      const scripted = script[key];
      if (scripted === undefined) {
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 };
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

/** Build a scripted result for one raw failure kind (crash / timeout — malformed is exercised via real stdout text below). */
function scriptedFor(failure: "timeout" | "crash"): ScriptedResult {
  if (failure === "timeout") return { timeoutSim: true };
  return { exitCode: 1, stdout: "", stderr: "boom", timedOut: false, durationMs: 1 };
}

/** The `HookAnomalyName` `semantics.ts`'s `reasonNameFor` emits for a raw failure kind. */
function reasonNameFor(failure: "timeout" | "crash"): string {
  return failure === "timeout" ? "hook-timeout" : "hook-crashed";
}

const PROFILES: readonly PolicyProfileId[] = ["read-only-review", "monitored-trusted-local", "unattended-untrusted"];

// ---------------------------------------------------------------------------
// 1. Grid through `createHookRuntime.fire()`: gate timeout/crash deny in all
//    profiles; the exact reason name is recorded.
// ---------------------------------------------------------------------------

describe("failure matrix through the runtime — gate timeout/crash deny in every profile", () => {
  for (const profileId of PROFILES) {
    for (const failure of ["timeout", "crash"] as const) {
      test(`gate ${failure} denies in ${profileId} with reason hook-${failure}`, async () => {
        const { runner } = makeScriptedRunner({ h: scriptedFor(failure) });
        const runtime = createHookRuntime({
          registrations: [commandReg({ id: "h", event: "PreToolUse" })],
          runner,
          clock: CLOCK,
          profileId,
          interactive: true,
          sessionId: "s1",
          runId: "r1",
          projectRoot: "/repo",
        });
        const result = await runtime.fire(
          "PreToolUse",
          { sessionId: "s1", runId: "r1", toolCallId: "t1", toolName: "Write", toolInput: {}, policyProfile: profileId },
          { toolName: "Write", decideOutcome: "allow" },
        );
        expect(result.decisions).toEqual([{ hookId: "h", decision: "deny" }]);
        expect(result.records[0]?.failure).toBe(failure);
        expect(result.records[0]?.reason).toBe(reasonNameFor(failure));
        expect(result.records[0]?.changedOutcome).toBe(true);
        // A gate deny is not a "warning" (fail-closed, not fail-open) — no
        // `hook-*-failed` warning is recorded for a deny path.
        expect(result.warnings).toEqual([]);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 2. gate-advisory: fail-open (with hook-advisory-failed) in read-only-review
//    and monitored-trusted-local; fail-closed (deny) in unattended-untrusted.
// ---------------------------------------------------------------------------

describe("failure matrix through the runtime — gate-advisory fail-open/fail-closed by profile", () => {
  const FAIL_OPEN_PROFILES: readonly PolicyProfileId[] = ["read-only-review", "monitored-trusted-local"];

  for (const profileId of FAIL_OPEN_PROFILES) {
    for (const failure of ["timeout", "crash"] as const) {
      test(`gate-advisory ${failure} proceeds with hook-advisory-failed in ${profileId}`, async () => {
        const { runner } = makeScriptedRunner({ h: scriptedFor(failure) });
        const runtime = createHookRuntime({
          registrations: [commandReg({ id: "h", event: "PreToolUse", class: "gate-advisory" })],
          runner,
          clock: CLOCK,
          profileId,
          interactive: true,
          sessionId: "s1",
          runId: "r1",
          projectRoot: "/repo",
        });
        const result = await runtime.fire(
          "PreToolUse",
          { sessionId: "s1", runId: "r1", toolCallId: "t1", toolName: "Write", toolInput: {}, policyProfile: profileId },
          { toolName: "Write", decideOutcome: "allow" },
        );
        expect(result.decisions).toEqual([]); // no decision — fail-open, never a deny
        expect(result.warnings).toEqual([{ name: "hook-advisory-failed", hookId: "h", detail: "hook-advisory-failed" }]);
      });
    }
  }

  for (const failure of ["timeout", "crash"] as const) {
    test(`gate-advisory ${failure} denies in unattended-untrusted (no advisory-failed warning — a deny, not a fail-open)`, async () => {
      const { runner } = makeScriptedRunner({ h: scriptedFor(failure) });
      const runtime = createHookRuntime({
        registrations: [commandReg({ id: "h", event: "PreToolUse", class: "gate-advisory" })],
        runner,
        clock: CLOCK,
        profileId: "unattended-untrusted",
        interactive: true,
        sessionId: "s1",
        runId: "r1",
        projectRoot: "/repo",
      });
      const result = await runtime.fire(
        "PreToolUse",
        { sessionId: "s1", runId: "r1", toolCallId: "t1", toolName: "Write", toolInput: {}, policyProfile: "unattended-untrusted" },
        { toolName: "Write", decideOutcome: "allow" },
      );
      expect(result.decisions).toEqual([{ hookId: "h", decision: "deny" }]);
      expect(result.records[0]?.reason).toBe("hook-advisory-failed");
    });
  }
});

// ---------------------------------------------------------------------------
// 3. observe/context always fail open with a warning, every profile.
// ---------------------------------------------------------------------------

describe("failure matrix through the runtime — observe/context fail open with a warning in every profile", () => {
  for (const profileId of PROFILES) {
    for (const cls of ["observe", "context"] as const) {
      for (const failure of ["timeout", "crash"] as const) {
        test(`${cls} ${failure} proceeds with a warning in ${profileId}`, async () => {
          const { runner } = makeScriptedRunner({ h: scriptedFor(failure) });
          const event: HookEventName = cls === "observe" ? "PostToolUse" : "PreCompact";
          const runtime = createHookRuntime({
            registrations: [commandReg({ id: "h", event, class: cls })],
            runner,
            clock: CLOCK,
            profileId,
            interactive: true,
            sessionId: "s1",
            runId: "r1",
            projectRoot: "/repo",
          });
          const payload =
            cls === "observe"
              ? { sessionId: "s1", runId: "r1", toolCallId: "t1", toolName: "Write", toolInput: {}, toolOutput: {} }
              : { sessionId: "s1", runId: "r1", reason: "auto" as const };
          const result = await runtime.fire(event, payload, { toolName: "Write" });
          expect(result.decisions).toEqual([]);
          const expectedWarning = cls === "observe" ? "hook-observer-failed" : "hook-context-failed";
          expect(result.warnings).toEqual([{ name: expectedWarning, hookId: "h", detail: expectedWarning }]);
        });
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 4. SessionStart fails open for every class, every profile.
// ---------------------------------------------------------------------------

describe("failure matrix through the runtime — SessionStart fails open for every class", () => {
  const CLASSES: readonly HookClass[] = ["gate", "gate-advisory", "observe", "context"];
  for (const profileId of PROFILES) {
    for (const cls of CLASSES) {
      test(`${cls} failure on SessionStart proceeds with a warning in ${profileId}`, async () => {
        const { runner } = makeScriptedRunner({ h: scriptedFor("crash") });
        const runtime = createHookRuntime({
          registrations: [commandReg({ id: "h", event: "SessionStart", class: cls })],
          runner,
          clock: CLOCK,
          profileId,
          interactive: true,
          sessionId: "s1",
          runId: "r1",
          projectRoot: "/repo",
        });
        const result = await runtime.fire("SessionStart", {
          sessionId: "s1",
          runId: "r1",
          projectRoot: "/repo",
          policyProfile: profileId,
        });
        expect(result.decisions).toEqual([]); // SessionStart is never gate-capable
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]?.hookId).toBe("h");
      });
    }
  }
});

// ---------------------------------------------------------------------------
// End-to-end via `runOffline`: shared fixtures for the remaining sections.
// ---------------------------------------------------------------------------


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

function makeTool(toolId: string, risk: ToolRisk): ToolDefinition {
  return {
    schemaVersion: 1,
    toolId,
    version: "0.1.0",
    description: `Failure-matrix fixture tool (${risk}).`,
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

async function driveRun(opts: {
  risk: ToolRisk;
  interactive: boolean;
  preToolUseRegistrations: HookRegistration[];
  postToolUseRegistrations?: HookRegistration[];
  script: Record<string, ScriptedResult>;
}): Promise<{ result: RunResult }> {
  const toolId = `fixture.${opts.risk}`;
  const registry = new ToolRegistry();
  registry.register(makeTool(toolId, opts.risk));
  const transcript = makeTranscript(`t-${toolId}-${opts.interactive}`, [
    { toolCallId: "call-1", toolName: toolId, input: { key: "value" } },
  ]);
  const provider = fixtureProvider(transcript, `req-${toolId}-${opts.interactive}-${Object.keys(opts.script).join(",")}`);
  const executor = new FakeToolExecutor(registry, { schemaDir: SCHEMA_DIR });
  const { runner } = makeScriptedRunner(opts.script);

  const { clock, idSeq } = makeClockIdSeq();
  const runtime = createHookRuntime({
    registrations: [...opts.preToolUseRegistrations, ...(opts.postToolUseRegistrations ?? [])],
    runner,
    clock,
    profileId: "monitored-trusted-local",
    interactive: opts.interactive,
    sessionId: "session-fm",
    runId: "run-fm",
    projectRoot: "/repo",
  });

  const deps: RunDeps = {
    provider,
    toolRegistry: registry,
    toolExecutor: executor,
    policyProfile: resolveLocalProfile("monitored-trusted-local"),
    clock,
    idSeq,
    interactive: opts.interactive,
    hooks: runtime,
  };

  const result = await runOffline(buildInput(), buildConfig(), deps);
  return { result };
}

// ---------------------------------------------------------------------------
// 5. AC4: an observe hook that crashes / times out never blocks `fire()` past
//    its own timeout, and never changes the recorded tool result.
// ---------------------------------------------------------------------------

describe("AC4: PostToolUse observe-hook failures never block or alter the tool result", () => {
  test("a crashing observe hook does not change the tool result and records hook-observer-failed", async () => {
    const startedAt = Date.now();
    const { result } = await driveRun({
      risk: "read",
      interactive: true,
      preToolUseRegistrations: [],
      postToolUseRegistrations: [commandReg({ id: "obs-crash", event: "PostToolUse", class: "observe" })],
      script: { "obs-crash": scriptedFor("crash") },
    });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(2000);
    expect(result.output.status).toBe("completed");
    expect(result.sessionEntries.some((e) => e.entry.type === "tool_result")).toBe(true);
    expect(result.hookWarnings?.some((w) => w.hookId === "obs-crash" && w.name === "hook-observer-failed")).toBe(true);
  });

  test("an observe hook that never resolves until its timeout does not block fire() and does not change the tool result", async () => {
    const startedAt = Date.now();
    const { result } = await driveRun({
      risk: "read",
      interactive: true,
      preToolUseRegistrations: [],
      postToolUseRegistrations: [commandReg({ id: "obs-timeout", event: "PostToolUse", class: "observe", timeoutMs: 25 })],
      script: { "obs-timeout": scriptedFor("timeout") },
    });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(2000); // proves fire() did not wait past the ~25ms budget
    expect(result.output.status).toBe("completed");
    expect(result.sessionEntries.some((e) => e.entry.type === "tool_result")).toBe(true);
    expect(result.hookWarnings?.some((w) => w.hookId === "obs-timeout" && w.name === "hook-observer-failed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. AC9 (runOffline part): interactive false + gate ask on a decide()-allow
//    resolves to deny.
// ---------------------------------------------------------------------------

describe("AC9 (runOffline part): a gate ask on a decide()-allow denies when interactive is false", () => {
  test("read risk (decide()=allow under monitored-trusted-local) + gate ask + interactive:false => deny", async () => {
    const { result } = await driveRun({
      risk: "read",
      interactive: false,
      preToolUseRegistrations: [commandReg({ id: "ask-hook", event: "PreToolUse" })],
      script: { "ask-hook": { exitCode: 0, stdout: JSON.stringify({ decision: "ask" }), stderr: "", timedOut: false, durationMs: 1 } },
    });
    const decision = result.decisions.find((d) => d.toolCallId === "call-1");
    expect(decision?.decision).toBe("deny");
    expect(result.sessionEntries.some((e) => e.entry.type === "tool_result")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. The malformed-output asymmetry, proven end-to-end (this is the T7 run.ts
//    fix's whole point): decideOutcome is now known to `PreToolUse` BEFORE
//    composition, so a gate hook's malformed stdout on exit 0 silent-approves
//    a decide()-allow call but denies a decide()-ask call.
// ---------------------------------------------------------------------------

describe("gate malformed-output asymmetry, end-to-end through runOffline (post-T7 ordering fix)", () => {
  const malformedScript: Record<string, ScriptedResult> = {
    "malformed-hook": { exitCode: 0, stdout: "not valid json {{{", stderr: "", timedOut: false, durationMs: 1 },
  };

  test("decide()=allow (read risk, monitored-trusted-local): malformed stdout silent-approves — call still executes", async () => {
    const { result } = await driveRun({
      risk: "read",
      interactive: true,
      preToolUseRegistrations: [commandReg({ id: "malformed-hook", event: "PreToolUse" })],
      script: malformedScript,
    });
    const decision = result.decisions.find((d) => d.toolCallId === "call-1");
    expect(decision?.decision).toBe("allow");
    expect(result.sessionEntries.some((e) => e.entry.type === "tool_result")).toBe(true);
    expect(result.hookWarnings?.some((w) => w.hookId === "malformed-hook" && w.name === "hook-malformed-output")).toBe(true);
  });

  test("decide()=ask (write risk, monitored-trusted-local, interactive) + malformed stdout => deny, not silent-approve", async () => {
    const { result } = await driveRun({
      risk: "write", // monitored-trusted-local defaults write: "ask"
      interactive: true,
      preToolUseRegistrations: [commandReg({ id: "malformed-hook", event: "PreToolUse" })],
      script: malformedScript,
    });
    const decision = result.decisions.find((d) => d.toolCallId === "call-1");
    expect(decision?.decision).toBe("deny");
    expect(result.sessionEntries.some((e) => e.entry.type === "tool_result")).toBe(false);
    // Fail-closed on the malformed-output-when-ask path is a `deny` record
    // (`hook-malformed-output` reason on the hook_invocation), not a warning —
    // the semantics table only warns on the FAIL-OPEN paths.
    const malformedRecord = result.hookInvocations?.find((r) => r.hookId === "malformed-hook");
    expect(malformedRecord?.reason).toBe("hook-malformed-output");
    expect(malformedRecord?.outcome).toBe("deny");
  });
});
