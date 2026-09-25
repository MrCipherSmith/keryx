import { describe, expect, test } from "bun:test";
import {
  BUILTIN_HOOK_IDS,
  BUILTIN_HOOK_REGISTRATIONS,
  LEARNING_OBSERVER_EVENT_KIND,
  NOOP_IMPACT_EVIDENCE_PROVIDER,
  NOOP_LEARNING_OBSERVATION_SINK,
  resolveKeryxArgv,
} from "./builtins";

describe("BUILTIN_HOOK_REGISTRATIONS", () => {
  test("exposes exactly the five distinct built-in ids", () => {
    const ids = new Set(BUILTIN_HOOK_REGISTRATIONS.map((r) => r.id));
    expect(ids).toEqual(new Set(BUILTIN_HOOK_IDS));
    expect(BUILTIN_HOOK_IDS.length).toBe(5);
  });

  test("keryx.ctx-guard is a PreToolUse gate on Bash", () => {
    const reg = BUILTIN_HOOK_REGISTRATIONS.find((r) => r.id === "keryx.ctx-guard");
    expect(reg?.event).toBe("PreToolUse");
    expect(reg?.matcher).toBe("Bash");
    expect(reg?.class).toBe("gate");
    expect(reg?.handler).toEqual({ kind: "command", argv: ["keryx", "ctx", "hook", "claude"] });
  });

  test("keryx.security-check-input is a UserPromptSubmit gate", () => {
    const reg = BUILTIN_HOOK_REGISTRATIONS.find((r) => r.id === "keryx.security-check-input");
    expect(reg?.event).toBe("UserPromptSubmit");
    expect(reg?.class).toBe("gate");
  });

  test("keryx.security-check-output is a PreToolUse gate on Write|Edit", () => {
    const reg = BUILTIN_HOOK_REGISTRATIONS.find((r) => r.id === "keryx.security-check-output");
    expect(reg?.event).toBe("PreToolUse");
    expect(reg?.matcher).toBe("Write|Edit");
    expect(reg?.class).toBe("gate");
  });

  test("keryx.learning-observer is registered on exactly the seven documented events, all observe class", () => {
    const regs = BUILTIN_HOOK_REGISTRATIONS.filter((r) => r.id === "keryx.learning-observer");
    const events = new Set(regs.map((r) => r.event));
    expect(events).toEqual(
      new Set(["PostToolUse", "PostToolUseFailure", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]),
    );
    expect(regs.every((r) => r.class === "observe")).toBe(true);
    expect(regs.every((r) => r.handler.kind === "builtin" && r.handler.name === "learning-observer")).toBe(true);
  });

  test("keryx.impact-evidence is a PreToolUse gate-advisory on Write|Edit", () => {
    const reg = BUILTIN_HOOK_REGISTRATIONS.find((r) => r.id === "keryx.impact-evidence");
    expect(reg?.event).toBe("PreToolUse");
    expect(reg?.matcher).toBe("Write|Edit");
    expect(reg?.class).toBe("gate-advisory");
    expect(reg?.handler).toEqual({ kind: "builtin", name: "impact-evidence" });
  });

  test("LEARNING_OBSERVER_EVENT_KIND maps every one of the seven events", () => {
    expect(LEARNING_OBSERVER_EVENT_KIND.PreToolUse).toBe("tool-start");
    expect(LEARNING_OBSERVER_EVENT_KIND.PostToolUse).toBe("tool-complete");
    expect(LEARNING_OBSERVER_EVENT_KIND.PostToolUseFailure).toBe("tool-failed");
    expect(LEARNING_OBSERVER_EVENT_KIND.UserPromptSubmit).toBe("user-prompt");
    expect(LEARNING_OBSERVER_EVENT_KIND.SessionStart).toBe("session-start");
    expect(LEARNING_OBSERVER_EVENT_KIND.Stop).toBe("turn-stop");
    expect(LEARNING_OBSERVER_EVENT_KIND.SessionEnd).toBe("session-end");
  });
});

describe("default ports", () => {
  test("NOOP_LEARNING_OBSERVATION_SINK.record is a no-op", async () => {
    await NOOP_LEARNING_OBSERVATION_SINK.record({
      kind: "tool-start",
      sessionId: "s",
      runId: "r",
      timestamp: "t",
      payload: {},
    });
    // No throw, no return value to assert — this is the contract.
    expect(true).toBe(true);
  });

  test("NOOP_IMPACT_EVIDENCE_PROVIDER.evidenceFor returns no context, no decision", async () => {
    const result = await NOOP_IMPACT_EVIDENCE_PROVIDER.evidenceFor({
      sessionId: "s",
      files: ["/a.ts"],
      toolName: "Write",
      projectRoot: "/proj",
      firstEditInSession: true,
    });
    expect(result).toEqual({});
  });
});

describe("resolveKeryxArgv", () => {
  test("passes non-keryx argv through unchanged", () => {
    expect(resolveKeryxArgv(["echo", "hi"])).toEqual(["echo", "hi"]);
  });

  test("replaces a leading keryx with execPath + the safe bun flags (R1-01) + scriptPath", () => {
    const resolved = resolveKeryxArgv(["keryx", "ctx", "hook", "claude"], {
      execPath: "/usr/local/bin/node",
      scriptPath: "/repo/dist/cli.js",
    });
    expect(resolved).toEqual([
      "/usr/local/bin/node",
      "--no-env-file",
      "--config=/dev/null",
      "/repo/dist/cli.js",
      "ctx",
      "hook",
      "claude",
    ]);
  });

  test("an empty argv is passed through unchanged", () => {
    expect(resolveKeryxArgv([])).toEqual([]);
  });

  test("recognizes a source-run entry by cli.ts basename", () => {
    const resolved = resolveKeryxArgv(["keryx", "ctx", "hook", "claude"], {
      execPath: "/usr/local/bin/bun",
      scriptPath: "/repo/src/cli.ts",
    });
    expect(resolved).toEqual([
      "/usr/local/bin/bun",
      "--no-env-file",
      "--config=/dev/null",
      "/repo/src/cli.ts",
      "ctx",
      "hook",
      "claude",
    ]);
  });

  test("a compiled keryx binary (execPath basename keryx) spawns itself alone, no second argv", () => {
    const resolved = resolveKeryxArgv(["keryx", "ctx", "hook", "claude"], {
      execPath: "/usr/local/bin/keryx",
    });
    expect(resolved).toEqual(["/usr/local/bin/keryx", "ctx", "hook", "claude"]);
  });

  test("an unrelated host entry (e.g. bun test's own runner) falls back to plain keryx on PATH, never re-execs the host", () => {
    const resolved = resolveKeryxArgv(["keryx", "ctx", "hook", "claude"], {
      execPath: "/usr/local/bin/bun",
      scriptPath: "/usr/local/bin/bun-test-runner.js",
    });
    expect(resolved).toEqual(["keryx", "ctx", "hook", "claude"]);
  });

  test("a missing scriptPath and non-keryx execPath falls back to plain keryx on PATH", () => {
    const resolved = resolveKeryxArgv(["keryx", "ctx", "hook", "claude"], {
      execPath: "/usr/local/bin/bun",
    });
    expect(resolved).toEqual(["keryx", "ctx", "hook", "claude"]);
  });
});
