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
