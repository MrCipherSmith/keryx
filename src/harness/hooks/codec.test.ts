import { describe, expect, test } from "bun:test";
import { buildHookStdin, HOOK_ADDITIONAL_CONTEXT_MAX_BYTES, parseHookResult } from "./codec";

function raw(overrides: Partial<Parameters<typeof parseHookResult>[0]> = {}) {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

describe("buildHookStdin", () => {
  test("carries camelCase fields plus schemaVersion/timestamp/hookId and snake_case aliases", () => {
    const stdin = buildHookStdin(
      "PreToolUse",
      { sessionId: "s1", runId: "r1", toolCallId: "tc1", toolName: "Bash", toolInput: { command: "ls" }, risk: "shell", policyProfile: "monitored-trusted-local" },
      { hookId: "keryx.ctx-guard", timestamp: "2026-01-01T00:00:00.000Z", projectRoot: "/proj" },
    );
    expect(stdin.event).toBe("PreToolUse");
    expect(stdin.schemaVersion).toBe("1.0.0");
    expect(stdin.timestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(stdin.hookId).toBe("keryx.ctx-guard");
    expect(stdin.hook_event_name).toBe("PreToolUse");
    expect(stdin.session_id).toBe("s1");
    expect(stdin.cwd).toBe("/proj");
    expect(stdin.tool_name).toBe("Bash");
    expect(stdin.tool_input).toEqual({ command: "ls" });
  });

  test("PostToolUse aliases toolOutput to tool_response", () => {
    const stdin = buildHookStdin(
      "PostToolUse",
      { sessionId: "s1", runId: "r1", toolCallId: "tc1", toolName: "Bash", toolInput: {}, toolOutput: { ok: true } },
      { hookId: "h", timestamp: "t" },
    );
    expect(stdin.tool_response).toEqual({ ok: true });
  });

  test("UserPromptSubmit aliases prompt", () => {
    const stdin = buildHookStdin("UserPromptSubmit", { sessionId: "s1", runId: "r1", prompt: "hello" }, { hookId: "h", timestamp: "t" });
    expect(stdin.prompt).toBe("hello");
  });
});

describe("parseHookResult", () => {
  const gateCtx = { cls: "gate" as const, event: "PreToolUse" as const };
  const observeCtx = { cls: "observe" as const, event: "PostToolUse" as const };

  test("empty stdout on exit 0 is a silent approve", () => {
    const result = parseHookResult(raw({ stdout: "   " }), gateCtx);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.decision).toBeUndefined();
    expect(result.anomalies).toEqual([]);
  });

  test("non-JSON stdout is malformed", () => {
    const result = parseHookResult(raw({ stdout: "not json" }), gateCtx);
    expect(result).toEqual({ kind: "failure", failure: "malformed", reason: "stdout is not valid JSON." });
  });

  test("non-object JSON stdout is malformed", () => {
    const result = parseHookResult(raw({ stdout: "[1,2,3]" }), gateCtx);
    expect(result.kind).toBe("failure");
  });

  test("accepts {decision, additionalContext, reason}", () => {
    const result = parseHookResult(
      raw({ stdout: JSON.stringify({ decision: "ask", additionalContext: "ctx", reason: "why" }) }),
      gateCtx,
    );
    expect(result).toEqual({ kind: "ok", decision: "ask", additionalContext: "ctx", reason: "why", anomalies: [] });
  });

  test("accepts Claude hookSpecificOutput shape", () => {
    const result = parseHookResult(
      raw({
        stdout: JSON.stringify({
          hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "nope", additionalContext: "extra" },
        }),
      }),
      gateCtx,
    );
    expect(result).toEqual({ kind: "ok", decision: "deny", additionalContext: "extra", reason: "nope", anomalies: [] });
  });

  test("legacy decision:block maps to deny, approve maps to allow", () => {
    const blockResult = parseHookResult(raw({ stdout: JSON.stringify({ decision: "block" }) }), gateCtx);
    expect(blockResult.kind === "ok" && blockResult.decision).toBe("deny");
    const approveResult = parseHookResult(raw({ stdout: JSON.stringify({ decision: "approve" }) }), gateCtx);
    expect(approveResult.kind === "ok" && approveResult.decision).toBe("allow");
  });

  test("an unrecognised decision string is malformed", () => {
    const result = parseHookResult(raw({ stdout: JSON.stringify({ decision: "maybe" }) }), gateCtx);
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.failure).toBe("malformed");
    }
  });

  test("exit 2 is a deny with trimmed stderr as reason", () => {
    const result = parseHookResult(raw({ exitCode: 2, stderr: "  blocked: secret found  \n" }), gateCtx);
    expect(result).toEqual({ kind: "ok", decision: "deny", reason: "blocked: secret found", anomalies: [] });
  });

  test("other non-zero exit is a crash", () => {
    const result = parseHookResult(raw({ exitCode: 1 }), gateCtx);
    expect(result).toEqual({ kind: "failure", failure: "crash", reason: "Hook exited with code 1." });
  });

  test("timedOut is a timeout failure regardless of exit code", () => {
    const result = parseHookResult(raw({ exitCode: 0, timedOut: true }), gateCtx);
    expect(result).toEqual({ kind: "failure", failure: "timeout", reason: "Hook exceeded its configured timeout." });
  });

  test("a spawnError of sandbox-unavailable classifies distinctly", () => {
    const result = parseHookResult(raw({ spawnError: "sandbox-unavailable" }), gateCtx);
    expect(result).toEqual({ kind: "failure", failure: "sandbox-unavailable", reason: "sandbox-unavailable" });
  });

  test("updatedInput is dropped and recorded as an anomaly", () => {
    const result = parseHookResult(
      raw({ stdout: JSON.stringify({ decision: "allow", updatedInput: { command: "rm -rf /" } }) }),
      gateCtx,
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.anomalies).toContain("hook-attempted-input-rewrite");
    expect((result as unknown as Record<string, unknown>).updatedInput).toBeUndefined();
  });

  test("a decision from an observe hook is ignored with an anomaly", () => {
    const result = parseHookResult(raw({ stdout: JSON.stringify({ decision: "deny" }) }), observeCtx);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.decision).toBeUndefined();
    expect(result.anomalies).toContain("hook-decision-ignored");
  });

  test("a gate decision on a non-gate-capable event is ignored with an anomaly", () => {
    const result = parseHookResult(raw({ stdout: JSON.stringify({ decision: "deny" }) }), { cls: "gate", event: "SessionEnd" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.decision).toBeUndefined();
    expect(result.anomalies).toContain("hook-decision-ignored");
  });

  test("additionalContext over the cap is truncated with an anomaly", () => {
    const big = "x".repeat(HOOK_ADDITIONAL_CONTEXT_MAX_BYTES + 100);
    const result = parseHookResult(raw({ stdout: JSON.stringify({ decision: "allow", additionalContext: big }) }), gateCtx);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.additionalContext?.length).toBeLessThanOrEqual(HOOK_ADDITIONAL_CONTEXT_MAX_BYTES);
    expect(result.anomalies).toContain("hook-context-truncated");
  });
});
