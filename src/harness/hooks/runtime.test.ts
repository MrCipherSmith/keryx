import { describe, expect, test } from "bun:test";
import { BUILTIN_HOOK_REGISTRATIONS } from "./builtins";
import { createHookRuntime } from "./runtime";
import type { CreateHookRuntimeOptions } from "./runtime";
import type { HookProcessRunner, HookRunRequest, HookRunResult } from "./runner";
import type { HookRegistration } from "./types";

const CLOCK = () => "2026-01-01T00:00:00.000Z";

function baseCtx(
  overrides: Partial<CreateHookRuntimeOptions> & Pick<CreateHookRuntimeOptions, "registrations" | "runner">,
): CreateHookRuntimeOptions {
  return {
    clock: CLOCK,
    profileId: "monitored-trusted-local",
    interactive: true,
    sessionId: "s1",
    runId: "r1",
    projectRoot: "/proj",
    ...overrides,
  };
}

function commandReg(overrides: Partial<HookRegistration> & { id: string; event: HookRegistration["event"] }): HookRegistration {
  return {
    matcher: "*",
    class: "gate",
    handler: { kind: "command", argv: ["fake", overrides.id] },
    timeoutMs: 5000,
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

/** A scripted fake runner: `script` maps a hook id (argv[1]) to a canned result or a delay descriptor. */
function makeFakeRunner(
  script: Record<string, HookRunResult | { hang: true }>,
): { runner: HookProcessRunner; calls: HookRunRequest[] } {
  const calls: HookRunRequest[] = [];
  const runner: HookProcessRunner = {
    async run(req: HookRunRequest): Promise<HookRunResult> {
      calls.push(req);
      const key = req.argv[1] ?? "";
      const scripted = script[key];
      if (scripted === undefined) {
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 };
      }
      if ("hang" in scripted) {
        return new Promise<HookRunResult>(() => {
          // Never resolves — used to prove fire() does not wait past timeoutMs.
        });
      }
      return scripted;
    },
  };
  return { runner, calls };
}

describe("createHookRuntime — ordering + short-circuit", () => {
  test("gate hooks run sequentially in order; the first deny stops the rest", async () => {
    const { runner, calls } = makeFakeRunner({
      a: { exitCode: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "", timedOut: false, durationMs: 1 },
      b: { exitCode: 2, stdout: "", stderr: "blocked", timedOut: false, durationMs: 1 },
      c: { exitCode: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "", timedOut: false, durationMs: 1 },
    });
    const registrations: HookRegistration[] = [
      commandReg({ id: "a", event: "PreToolUse", order: 0 }),
      commandReg({ id: "b", event: "PreToolUse", order: 1 }),
      commandReg({ id: "c", event: "PreToolUse", order: 2 }),
    ];
    const runtime = createHookRuntime(baseCtx({ registrations, runner }));
    const result = await runtime.fire("PreToolUse", { sessionId: "s1", runId: "r1", toolCallId: "t1", toolName: "Bash", toolInput: {}, policyProfile: "monitored-trusted-local" }, { toolName: "Bash" });

    expect(calls.map((c) => c.argv[1])).toEqual(["a", "b"]); // "c" never started
    expect(result.decisions).toEqual([
      { hookId: "a", decision: "allow" },
      { hookId: "b", decision: "deny" },
    ]);
    expect(result.records).toHaveLength(2);
    expect(result.records[1]?.reason).toBe("blocked");
  });
});

describe("createHookRuntime — parallel observe/context never awaited past timeout", () => {
  test("a hanging observe hook does not block fire(), and is recorded as a timeout", async () => {
    const { runner } = makeFakeRunner({
      quick: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 },
      slow: { hang: true },
    });
    const registrations: HookRegistration[] = [
      commandReg({ id: "quick", event: "PostToolUse", class: "observe", order: 0 }),
      commandReg({ id: "slow", event: "PostToolUse", class: "observe", order: 1, timeoutMs: 40 }),
    ];
    const runtime = createHookRuntime(baseCtx({ registrations, runner }));

    const startedAt = Date.now();
    const result = await runtime.fire("PostToolUse", { sessionId: "s1", runId: "r1", toolCallId: "t1", toolName: "Bash", toolInput: {}, toolOutput: {} }, { toolName: "Bash" });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(1000); // proves we did not wait forever on the hung promise
    const slowRecord = result.records.find((r) => r.hookId === "slow");
    expect(slowRecord?.failure).toBe("timeout");
    expect(result.warnings.some((w) => w.hookId === "slow" && w.name === "hook-observer-failed")).toBe(true);
    // Observe hooks never change the outcome.
    expect(result.decisions.find((d) => d.hookId === "slow")).toBeUndefined();
  }, 5000);
});

describe("createHookRuntime — non-tool gate-capable events tighten a base allow", () => {
  test("UserPromptSubmit: a gate hook ask tightens allow to ask (interactive)", async () => {
    const { runner } = makeFakeRunner({
      guard: { exitCode: 0, stdout: JSON.stringify({ decision: "ask" }), stderr: "", timedOut: false, durationMs: 1 },
    });
    const registrations: HookRegistration[] = [commandReg({ id: "guard", event: "UserPromptSubmit", order: 0 })];
    const runtime = createHookRuntime(baseCtx({ registrations, runner, interactive: true }));
    const result = await runtime.fire("UserPromptSubmit", { sessionId: "s1", runId: "r1", prompt: "hi" });
    expect(result.tightened).toBe("ask");
  });

  test("UserPromptSubmit: the same ask fails closed to deny when non-interactive", async () => {
    const { runner } = makeFakeRunner({
      guard: { exitCode: 0, stdout: JSON.stringify({ decision: "ask" }), stderr: "", timedOut: false, durationMs: 1 },
    });
    const registrations: HookRegistration[] = [commandReg({ id: "guard", event: "UserPromptSubmit", order: 0 })];
    const runtime = createHookRuntime(baseCtx({ registrations, runner, interactive: false }));
    const result = await runtime.fire("UserPromptSubmit", { sessionId: "s1", runId: "r1", prompt: "hi" });
    expect(result.tightened).toBe("deny");
  });

  test("PreToolUse never sets `tightened` (composition happens externally)", async () => {
    const { runner } = makeFakeRunner({});
    const registrations: HookRegistration[] = [commandReg({ id: "x", event: "PreToolUse", order: 0 })];
    const runtime = createHookRuntime(baseCtx({ registrations, runner }));
    const result = await runtime.fire("PreToolUse", { sessionId: "s1", runId: "r1", toolCallId: "t1", toolName: "Bash", toolInput: {}, policyProfile: "monitored-trusted-local" }, { toolName: "Bash" });
    expect(result.tightened).toBeUndefined();
  });
});

describe("createHookRuntime — inheritedHookIds", () => {
  test("dedupes ids and excludes disabled / appliesToChildAgents:false", async () => {
    const registrations: HookRegistration[] = [
      commandReg({ id: "a", event: "PreToolUse", order: 0, appliesToChildAgents: true }),
      commandReg({ id: "b", event: "PreToolUse", order: 1, appliesToChildAgents: false }),
      commandReg({ id: "c", event: "PostToolUse", order: 2, enabled: false }),
      commandReg({ id: "a", event: "PostToolUse", order: 3 }), // same id, different event -> deduped
    ];
    const runtime = createHookRuntime(baseCtx({ registrations, runner: makeFakeRunner({}).runner }));
    expect(runtime.inheritedHookIds()).toEqual(["a"]);
  });
});

describe("createHookRuntime — built-in ports", () => {
  test("with no ports injected, the built-ins run with their no-op defaults", async () => {
    const { runner } = makeFakeRunner({});
    const runtime = createHookRuntime(
      baseCtx({ registrations: BUILTIN_HOOK_REGISTRATIONS, runner, builtinArgvResolver: (argv) => [...argv] }),
    );
    const result = await runtime.fire("SessionStart", {
      sessionId: "s1",
      runId: "r1",
      projectRoot: "/proj",
      policyProfile: "monitored-trusted-local",
    });
    // learning-observer fires on SessionStart with the default no-op sink; no warnings/failures.
    expect(result.warnings).toEqual([]);
    expect(result.records.some((r) => r.hookId === "keryx.learning-observer")).toBe(true);
  });

  test("impact-evidence only consults the provider on a file's first edit in the session", async () => {
    const { runner } = makeFakeRunner({});
    let calls = 0;
    const runtime = createHookRuntime(
      baseCtx({
        registrations: BUILTIN_HOOK_REGISTRATIONS,
        runner,
        builtinArgvResolver: (argv) => [...argv],
        ports: {
          impactEvidence: {
            evidenceFor: () => {
              calls += 1;
              return { additionalContext: "affected: foo.ts" };
            },
          },
        },
      }),
    );

    const payload = (path: string) => ({
      sessionId: "s1",
      runId: "r1",
      toolCallId: "t1",
      toolName: "Write",
      toolInput: { filePath: path },
      policyProfile: "monitored-trusted-local",
    });

    const first = await runtime.fire("PreToolUse", payload("/a.ts"), { toolName: "Write" });
    expect(calls).toBe(1);
    expect(first.additionalContext).toContain("affected: foo.ts");

    const second = await runtime.fire("PreToolUse", payload("/a.ts"), { toolName: "Write" });
    expect(calls).toBe(1); // same file again -> provider not consulted
    expect(second.additionalContext).toEqual([]);

    await runtime.fire("PreToolUse", payload("/b.ts"), { toolName: "Write" });
    expect(calls).toBe(2); // a different file -> first edit again
  });

  test("a learning-observer sink is invoked with the mapped observation kind", async () => {
    const { runner } = makeFakeRunner({});
    const observed: string[] = [];
    const runtime = createHookRuntime(
      baseCtx({
        registrations: BUILTIN_HOOK_REGISTRATIONS,
        runner,
        builtinArgvResolver: (argv) => [...argv],
        ports: {
          learningSink: {
            record: (obs) => {
              observed.push(obs.kind);
            },
          },
        },
      }),
    );
    await runtime.fire("PreToolUse", { sessionId: "s1", runId: "r1", toolCallId: "t1", toolName: "Read", toolInput: {}, policyProfile: "monitored-trusted-local" }, { toolName: "Read" });
    expect(observed).toContain("tool-start");
  });
});

describe("createHookRuntime — forChild (flow 306, W6, T13)", () => {
  test("the child runtime's own registrations/inheritedHookIds equal exactly the parent's inheritedHookIds()", async () => {
    const registrations: HookRegistration[] = [
      commandReg({ id: "a", event: "PreToolUse", order: 0, appliesToChildAgents: true }),
      commandReg({ id: "b", event: "PreToolUse", order: 1, appliesToChildAgents: false }),
      commandReg({ id: "c", event: "PostToolUse", order: 2, enabled: false }),
      commandReg({ id: "d", event: "PostToolUse", order: 3, appliesToChildAgents: true }),
    ];
    const parent = createHookRuntime(baseCtx({ registrations, runner: makeFakeRunner({}).runner }));
    const parentInherited = parent.inheritedHookIds();
    expect(parentInherited).toEqual(["a", "d"]);

    const child = parent.forChild({ sessionId: "child-s1", runId: "child-r1" });
    // The child's own inheritedHookIds() (its regs run back through the same
    // filter) is exactly the parent's inheritedHookIds() — no more, no less.
    expect(child.inheritedHookIds()).toEqual(parentInherited);
    // The excluded registrations are ACTUALLY absent from the child's
    // registration list, not merely excluded by inheritedHookIds' own filter.
    expect(child.registrations().map((r) => r.id).sort()).toEqual(["a", "d"]);
    expect(child.registrations().some((r) => r.id === "b")).toBe(false);
    expect(child.registrations().some((r) => r.id === "c")).toBe(false);
  });

  test("a disabled or appliesToChildAgents:false registration never fires on the child runtime", async () => {
    const { runner, calls } = makeFakeRunner({
      a: { exitCode: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "", timedOut: false, durationMs: 1 },
      b: { exitCode: 0, stdout: JSON.stringify({ decision: "deny" }), stderr: "", timedOut: false, durationMs: 1 },
    });
    const registrations: HookRegistration[] = [
      commandReg({ id: "a", event: "PreToolUse", order: 0, appliesToChildAgents: true }),
      commandReg({ id: "b", event: "PreToolUse", order: 1, appliesToChildAgents: false }),
    ];
    const parent = createHookRuntime(baseCtx({ registrations, runner }));
    const child = parent.forChild({ sessionId: "child-s1", runId: "child-r1" });
    const result = await child.fire(
      "PreToolUse",
      { sessionId: "child-s1", runId: "child-r1", toolCallId: "t1", toolName: "Bash", toolInput: {}, policyProfile: "monitored-trusted-local" },
      { toolName: "Bash" },
    );
    expect(calls.map((c) => c.argv[1])).toEqual(["a"]); // "b" (parent-only) never ran
    expect(result.decisions).toEqual([{ hookId: "a", decision: "allow" }]);
  });

  test("the child runtime is always non-interactive, regardless of the parent's own flag", async () => {
    const parent = createHookRuntime(baseCtx({ registrations: [], runner: makeFakeRunner({}).runner, interactive: true }));
    const child = parent.forChild({ sessionId: "child-s1", runId: "child-r1" });
    expect(child.interactive).toBe(false);
  });

  test("the child runtime has fresh per-session state: impact-evidence's first-edit tracking does not inherit the parent's", async () => {
    const { runner } = makeFakeRunner({});
    let calls = 0;
    const parent = createHookRuntime(
      baseCtx({
        registrations: BUILTIN_HOOK_REGISTRATIONS,
        runner,
        builtinArgvResolver: (argv) => [...argv],
        ports: {
          impactEvidence: {
            evidenceFor: () => {
              calls += 1;
              return { additionalContext: "affected: foo.ts" };
            },
          },
        },
      }),
    );
    const payload = (sessionId: string, runId: string) => ({
      sessionId,
      runId,
      toolCallId: "t1",
      toolName: "Write",
      toolInput: { filePath: "/a.ts" },
      policyProfile: "monitored-trusted-local",
    });
    await parent.fire("PreToolUse", payload("s1", "r1"), { toolName: "Write" });
    expect(calls).toBe(1);

    const child = parent.forChild({ sessionId: "child-s1", runId: "child-r1" });
    // Same file, but the CHILD runtime has never seen it before — its own
    // `editedFiles` tracking is a fresh instance, not shared with the parent.
    const childResult = await child.fire("PreToolUse", payload("child-s1", "child-r1"), { toolName: "Write" });
    expect(calls).toBe(2);
    expect(childResult.additionalContext).toContain("affected: foo.ts");
  });
});

describe("createHookRuntime — per-fire profileId override (flow 306, W6, T14)", () => {
  test("a registration scoped to one profile only fires when that profile is selected for THIS fire, not the runtime's constructed one", async () => {
    const { runner, calls } = makeFakeRunner({
      "read-only-guard": { exitCode: 0, stdout: JSON.stringify({ decision: "ask" }), stderr: "", timedOut: false, durationMs: 1 },
    });
    const registrations: HookRegistration[] = [
      commandReg({ id: "read-only-guard", event: "PreToolUse", order: 0, profiles: ["read-only-review"] }),
    ];
    // Constructed under monitored-trusted-local (like the shell does).
    const runtime = createHookRuntime(baseCtx({ registrations, runner, profileId: "monitored-trusted-local" }));

    const payload = { sessionId: "s1", runId: "r1", toolCallId: "t1", toolName: "Write", toolInput: {}, policyProfile: "x" };
    const withoutOverride = await runtime.fire("PreToolUse", payload, { toolName: "Write" });
    expect(calls).toEqual([]); // registered for read-only-review only -> did not fire
    expect(withoutOverride.decisions).toEqual([]);

    const withOverride = await runtime.fire("PreToolUse", payload, { toolName: "Write", profileId: "read-only-review" });
    expect(calls.map((c) => c.argv[1])).toEqual(["read-only-guard"]);
    expect(withOverride.decisions).toEqual([{ hookId: "read-only-guard", decision: "ask" }]);
  });
});
