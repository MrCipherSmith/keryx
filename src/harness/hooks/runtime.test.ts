import { describe, expect, test } from "bun:test";
import { BUILTIN_HOOK_REGISTRATIONS } from "./builtins";
import { createHookRuntime } from "./runtime";
import type { CreateHookRuntimeOptions } from "./runtime";
import { createRealHookRunner } from "./runner";
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

// Flow 306 fix round 1, finding 13: `hook-attempted-input-rewrite` used to be
// recorded on EVERY invocation of a hook whose stdout carries `updatedInput`
// — a hook that always echoes one back would spam one anomaly per tool call
// for the whole session. It is now reported once per runtime/session.
describe("createHookRuntime — hook-attempted-input-rewrite is reported once per runtime, not once per invocation (fix round 1, finding 13)", () => {
  test("a hook that returns updatedInput on every call is only anomaly-flagged the first time", async () => {
    const { runner } = makeFakeRunner({
      rewriter: {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "allow", updatedInput: { command: "rm -rf /" } }),
        stderr: "",
        timedOut: false,
        durationMs: 1,
      },
    });
    const registrations: HookRegistration[] = [commandReg({ id: "rewriter", event: "PreToolUse", order: 0 })];
    const runtime = createHookRuntime(baseCtx({ registrations, runner }));
    const payload = { sessionId: "s1", runId: "r1", toolCallId: "t1", toolName: "Write", toolInput: {}, policyProfile: "monitored-trusted-local" };

    const first = await runtime.fire("PreToolUse", payload, { toolName: "Write" });
    const second = await runtime.fire("PreToolUse", payload, { toolName: "Write" });
    const third = await runtime.fire("PreToolUse", payload, { toolName: "Write" });

    expect(first.anomalies.filter((a) => a.name === "hook-attempted-input-rewrite")).toHaveLength(1);
    expect(second.anomalies.filter((a) => a.name === "hook-attempted-input-rewrite")).toHaveLength(0);
    expect(third.anomalies.filter((a) => a.name === "hook-attempted-input-rewrite")).toHaveLength(0);
  });

  test("a CHILD runtime (forChild) gets its own fresh once-per-session budget, independent of the parent's", async () => {
    const { runner } = makeFakeRunner({
      rewriter: {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "allow", updatedInput: { command: "rm -rf /" } }),
        stderr: "",
        timedOut: false,
        durationMs: 1,
      },
    });
    const registrations: HookRegistration[] = [commandReg({ id: "rewriter", event: "PreToolUse", order: 0 })];
    const parent = createHookRuntime(baseCtx({ registrations, runner }));
    const payload = (sessionId: string, runId: string) => ({
      sessionId,
      runId,
      toolCallId: "t1",
      toolName: "Write",
      toolInput: {},
      policyProfile: "monitored-trusted-local",
    });

    const parentFire = await parent.fire("PreToolUse", payload("s1", "r1"), { toolName: "Write" });
    expect(parentFire.anomalies.filter((a) => a.name === "hook-attempted-input-rewrite")).toHaveLength(1);

    const child = parent.forChild({ sessionId: "child-s1", runId: "child-r1" });
    const childFire = await child.fire("PreToolUse", payload("child-s1", "child-r1"), { toolName: "Write" });
    expect(childFire.anomalies.filter((a) => a.name === "hook-attempted-input-rewrite")).toHaveLength(1);
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

  // Flow 306 fix round 1, finding 16: `KERYX_POLICY_PROFILE` (the env var a
  // command hook reads) and the gate-advisory failure profile must both
  // reason about the LIVE per-fire profile, not the runtime's construction
  // profile — a `ctx.profileId` override that changes which registrations
  // fire but leaves the env var/failure semantics on the stale construction
  // profile would tell the hook (and the failure table) the wrong profile
  // is active.
  test("KERYX_POLICY_PROFILE reflects the per-fire profileId override, not the runtime's construction profileId", async () => {
    const { runner, calls } = makeFakeRunner({
      always: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 },
    });
    const registrations: HookRegistration[] = [commandReg({ id: "always", event: "PreToolUse", order: 0, profiles: [] })];
    const runtime = createHookRuntime(baseCtx({ registrations, runner, profileId: "monitored-trusted-local" }));
    const payload = {
      sessionId: "s1",
      runId: "r1",
      toolCallId: "t1",
      toolName: "Write",
      toolInput: {},
      policyProfile: "monitored-trusted-local",
    };

    await runtime.fire("PreToolUse", payload, { toolName: "Write", profileId: "read-only-review" });

    expect(calls[0]?.env.KERYX_POLICY_PROFILE).toBe("read-only-review");
  });

  test("a gate-advisory failure under a per-fire profileId override of unattended-untrusted denies, even though the runtime was constructed under monitored-trusted-local", async () => {
    const { runner } = makeFakeRunner({
      // A real runner reports a timed-out hook this way (`timedOut: true`),
      // not by never resolving — the sequential gate/gate-advisory loop
      // below awaits each hook directly with no timeout race of its own, so
      // an actually-hanging fake runner promise would hang this test too.
      advisory: { exitCode: null, stdout: "", stderr: "", timedOut: true, durationMs: 20 },
    });
    const registrations: HookRegistration[] = [
      commandReg({ id: "advisory", event: "PreToolUse", order: 0, class: "gate-advisory", timeoutMs: 20, profiles: [] }),
    ];
    const runtime = createHookRuntime(baseCtx({ registrations, runner, profileId: "monitored-trusted-local" }));
    const payload = {
      sessionId: "s1",
      runId: "r1",
      toolCallId: "t1",
      toolName: "Write",
      toolInput: {},
      policyProfile: "monitored-trusted-local",
    };

    // Under the CONSTRUCTION profile (monitored-trusted-local), a
    // gate-advisory timeout proceeds with a warning, not a deny.
    const withoutOverride = await runtime.fire("PreToolUse", payload, { toolName: "Write" });
    expect(withoutOverride.decisions.find((d) => d.hookId === "advisory")).toBeUndefined();

    // The SAME hook, same construction profile, but fired with a per-fire
    // override of unattended-untrusted: gate-advisory denies there instead.
    const withOverride = await runtime.fire("PreToolUse", payload, { toolName: "Write", profileId: "unattended-untrusted" });
    expect(withOverride.decisions).toEqual([{ hookId: "advisory", decision: "deny" }]);
  }, 5000);
});

describe("createHookRuntime — built-in command hooks run unsandboxed off required-isolation profiles (flow 306, W6, T15)", () => {
  /** A fake runner that fails exactly the way a missing sandbox launcher does (`spawnError: "sandbox-unavailable"`), only for a "sandbox" request — an "unsandboxed" request always succeeds. */
  function sandboxUnavailableRunner(): { runner: HookProcessRunner; calls: HookRunRequest[] } {
    const calls: HookRunRequest[] = [];
    const runner: HookProcessRunner = {
      async run(req: HookRunRequest): Promise<HookRunResult> {
        calls.push(req);
        if (req.runsIn === "sandbox") {
          return { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: "sandbox-unavailable", durationMs: 1 };
        }
        return { exitCode: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "", timedOut: false, durationMs: 1 };
      },
    };
    return { runner, calls };
  }

  test("keryx.security-check-input runs unsandboxed and succeeds under monitored-trusted-local even when the sandbox is unavailable", async () => {
    const { runner, calls } = sandboxUnavailableRunner();
    const reg = BUILTIN_HOOK_REGISTRATIONS.find((r) => r.id === "keryx.security-check-input");
    if (reg === undefined) throw new Error("keryx.security-check-input not found in BUILTIN_HOOK_REGISTRATIONS");
    const runtime = createHookRuntime(baseCtx({ registrations: [reg], runner, profileId: "monitored-trusted-local", interactive: true }));

    const result = await runtime.fire("UserPromptSubmit", { sessionId: "s1", runId: "r1", prompt: "hi" });

    expect(calls[0]?.runsIn).toBe("unsandboxed");
    expect(result.tightened).toBe("allow");
    expect(result.warnings).toHaveLength(0);
  });

  test("a default-runsIn user gate hook on the same event and profile still fails closed with the sandbox reason", async () => {
    const { runner, calls } = sandboxUnavailableRunner();
    const registrations: HookRegistration[] = [commandReg({ id: "user.guard", event: "UserPromptSubmit", scope: "project", order: 0 })];
    const runtime = createHookRuntime(baseCtx({ registrations, runner, profileId: "monitored-trusted-local", interactive: false }));

    const result = await runtime.fire("UserPromptSubmit", { sessionId: "s1", runId: "r1", prompt: "hi" });

    expect(calls[0]?.runsIn).toBe("sandbox");
    expect(result.tightened).toBe("deny");
    expect(result.records[0]?.failure).toBe("sandbox-unavailable");
  });

  test("under unattended-untrusted, keryx.security-check-input stays sandboxed and fails closed like before", async () => {
    const { runner, calls } = sandboxUnavailableRunner();
    const reg = BUILTIN_HOOK_REGISTRATIONS.find((r) => r.id === "keryx.security-check-input");
    if (reg === undefined) throw new Error("keryx.security-check-input not found in BUILTIN_HOOK_REGISTRATIONS");
    const runtime = createHookRuntime(baseCtx({ registrations: [reg], runner, profileId: "unattended-untrusted", interactive: false }));

    const result = await runtime.fire("UserPromptSubmit", { sessionId: "s1", runId: "r1", prompt: "hi" });

    expect(calls[0]?.runsIn).toBe("sandbox");
    expect(result.tightened).toBe("deny");
    expect(result.records[0]?.failure).toBe("sandbox-unavailable");
  });

  test("a project-configured hook with an explicit keryx.* id is a normal `project`-scope registration, not a `builtin`-scope one — it is unaffected by this override", async () => {
    const { runner, calls } = sandboxUnavailableRunner();
    const registrations: HookRegistration[] = [
      commandReg({ id: "keryx.security-check-input", event: "UserPromptSubmit", scope: "project", order: 0 }),
    ];
    const runtime = createHookRuntime(baseCtx({ registrations, runner, profileId: "monitored-trusted-local", interactive: true }));

    await runtime.fire("UserPromptSubmit", { sessionId: "s1", runId: "r1", prompt: "hi" });

    expect(calls[0]?.runsIn).toBe("sandbox");
  });
});

// Flow 306 fix round 1, finding 1: EVERY production caller constructs its
// `HookProcessRunner` via `createRealHookRunner({ projectRoot })` with no
// `sandboxProfile` — so `defaultSandboxProfile(...).required` is always
// `false`, and a `runsIn: "unsandboxed"` project hook ran genuinely
// unsandboxed under `unattended-untrusted` regardless of the active policy
// profile's own `requiredControls.isolation`. This is a RUNTIME-LEVEL test
// (no injected sandbox profile, the real `createRealHookRunner`) proving the
// fix: `runtime.ts` now computes `isolationRequired` from the per-fire
// profile and passes it on the request, which `runner.ts` refuses on
// regardless of what `SandboxProfile.required` says.
describe("createHookRuntime — isolationRequired refuses an unsandboxed project hook under unattended-untrusted (fix round 1, finding 1)", () => {
  test("a runsIn:unsandboxed project gate hook is refused (and denies) under unattended-untrusted, with no sandboxProfile injected anywhere", async () => {
    const registrations: HookRegistration[] = [
      commandReg({ id: "user.unsandboxed-guard", event: "UserPromptSubmit", scope: "project", order: 0, runsIn: "unsandboxed" }),
    ];
    // The real runner — no `sandboxProfile` override, exactly like every
    // production call site (`agent-hooks.ts`/`serve-turn.ts`/`hooks.ts`).
    const runner = createRealHookRunner({ projectRoot: process.cwd() });
    const runtime = createHookRuntime(
      baseCtx({ registrations, runner, profileId: "unattended-untrusted", interactive: false }),
    );

    const result = await runtime.fire("UserPromptSubmit", { sessionId: "s1", runId: "r1", prompt: "hi" });

    expect(result.records[0]?.failure).toBe("refused");
    expect(result.tightened).toBe("deny");
  });

  test("the SAME runsIn:unsandboxed project gate hook is permitted under monitored-trusted-local (isolation not required)", async () => {
    const registrations: HookRegistration[] = [
      commandReg({ id: "user.unsandboxed-guard", event: "UserPromptSubmit", scope: "project", order: 0, runsIn: "unsandboxed" }),
    ];
    const runner = createRealHookRunner({ projectRoot: process.cwd() });
    const runtime = createHookRuntime(
      baseCtx({ registrations, runner, profileId: "monitored-trusted-local", interactive: true }),
    );

    // The fake handler command ("fake user.unsandboxed-guard") is never a
    // real executable, so this still fails — but as a plain "crash" (ENOENT),
    // never `spawnError: "refused"`. That distinction is exactly what proves
    // isolation was not the reason it failed here.
    const result = await runtime.fire("UserPromptSubmit", { sessionId: "s1", runId: "r1", prompt: "hi" });
    expect(result.records[0]?.failure).not.toBe("refused");
  });
});

// Flow 306 fix round 1, finding 3: a hook whose underlying invocation
// rejects (a synchronous `spawn()` throw escaping as a rejected promise, or
// any other bug in a `HookProcessRunner`/builtin port implementation) must
// never propagate out of `fire()` — before the fix this reached callers
// (`agent.ts`, `spawn-subagent-tool.ts`, `run.ts`) as an unhandled
// rejection, which several of them then logged and IGNORED, sending the
// prompt through / continuing the turn: a gate hook's crash failing OPEN.
describe("createHookRuntime — a rejecting hook invocation never escapes fire(), and denies for a gate hook (fix round 1, finding 3)", () => {
  test("a runner whose run() rejects is treated as a crash and denies a gate hook, without fire() itself rejecting", async () => {
    const registrations: HookRegistration[] = [commandReg({ id: "throws", event: "UserPromptSubmit", order: 0 })];
    const throwingRunner: HookProcessRunner = {
      run(): Promise<HookRunResult> {
        return Promise.reject(new Error("NUL byte in argv"));
      },
    };
    const runtime = createHookRuntime(baseCtx({ registrations, runner: throwingRunner, interactive: false }));

    const result = await runtime.fire("UserPromptSubmit", { sessionId: "s1", runId: "r1", prompt: "hi" });

    expect(result.records[0]?.failure).toBe("crash");
    expect(result.tightened).toBe("deny");
  });
});
