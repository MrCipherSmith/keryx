// Tests for the runtime block validator (flow 176, T7). Offline and pure.
// Covers package AC1 (identity/capability), AC2 (read-only vs allowed_actions)
// and AC3 (worktree-write refused with a DISTINGUISHABLE reason).
import { describe, expect, test } from "bun:test";
import { READ_ONLY_FORBIDDEN_ACTIONS, readRuntimeBlock, validateRuntimeBlock } from "./dispatch";
import type { RuntimeBlock } from "./dispatch";

const READ_ONLY_ACTIONS = ["read", "run-command"];

function external(overrides: Partial<RuntimeBlock> = {}): RuntimeBlock {
  return { kind: "external", agent: "codex-cli", sandbox: "read-only", ...overrides };
}

describe("absent or native block (backward compatibility)", () => {
  test("an absent block is the native keryx runtime", () => {
    expect(validateRuntimeBlock(undefined, ["read", "write"])).toEqual({ ok: true, runtime: "keryx" });
  });

  test("an explicit keryx block is accepted regardless of actions", () => {
    // Every dispatch authored before this package must stay valid.
    expect(validateRuntimeBlock({ kind: "keryx" }, ["write", "network"])).toEqual({
      ok: true,
      runtime: "keryx",
    });
  });
});

describe("AC1 — identity and capability", () => {
  test("a known agent with a supported, implemented sandbox is accepted", () => {
    const result = validateRuntimeBlock(external(), READ_ONLY_ACTIONS);
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.runtime).toBe("external");
    expect(result.ok === true && result.runtime === "external" && result.entry.id).toBe("codex-cli");
  });

  test("both shipped agents are accepted", () => {
    expect(validateRuntimeBlock(external({ agent: "claude-cli" }), READ_ONLY_ACTIONS).ok).toBe(true);
  });

  test("an unknown agent is refused as unknown-agent", () => {
    const result = validateRuntimeBlock(external({ agent: "opencode" }), READ_ONLY_ACTIONS);
    expect(result).toMatchObject({ ok: false, code: "unknown-agent" });
    expect(result.ok === false && result.reason).toContain("opencode");
  });

  test("external without an agent is refused as missing-field, not unknown-agent", () => {
    const result = validateRuntimeBlock({ kind: "external", sandbox: "read-only" }, READ_ONLY_ACTIONS);
    expect(result).toMatchObject({ ok: false, code: "missing-field" });
  });

  test("external without a sandbox is refused as missing-field", () => {
    const result = validateRuntimeBlock({ kind: "external", agent: "codex-cli" }, READ_ONLY_ACTIONS);
    expect(result).toMatchObject({ ok: false, code: "missing-field" });
  });

  test("identity is checked before capability", () => {
    // An unknown agent with an impossible sandbox must blame the agent, not the
    // sandbox — the narrowest true reason, not the first that matches.
    const result = validateRuntimeBlock(
      { kind: "external", agent: "nope", sandbox: "worktree-write" },
      READ_ONLY_ACTIONS,
    );
    expect(result).toMatchObject({ ok: false, code: "unknown-agent" });
  });
});

describe("AC3 — worktree-write is refused, distinguishably", () => {
  test("a supported-but-unimplemented sandbox is not-implemented, not agent-cannot", () => {
    // Both shipped entries declare worktree-write because both CLIs support it,
    // so this refusal must come from the RELEASE gate.
    const result = validateRuntimeBlock(external({ sandbox: "worktree-write" }), ["read", "write"]);
    expect(result).toMatchObject({ ok: false, code: "not-implemented" });
    expect(result.ok === false && result.reason).toContain("not implemented in this release");
  });

  test("the two look-alike refusals carry different codes", () => {
    const notImplemented = validateRuntimeBlock(external({ sandbox: "worktree-write" }), ["read"]);
    const unknown = validateRuntimeBlock(external({ agent: "ghost" }), ["read"]);
    expect(notImplemented.ok === false && notImplemented.code).toBe("not-implemented");
    expect(unknown.ok === false && unknown.code).toBe("unknown-agent");
  });
});

describe("AC2 — read-only versus allowed_actions", () => {
  test.each([...READ_ONLY_FORBIDDEN_ACTIONS])("read-only contradicts %s", (action: string) => {
    const result = validateRuntimeBlock(external(), ["read", action]);
    expect(result).toMatchObject({ ok: false, code: "inconsistent-actions" });
    expect(result.ok === false && result.reason).toContain(action);
  });

  test("run-command alone does NOT trigger rejection", () => {
    // An external CLI necessarily runs commands inside its own sandbox; that axis
    // is governed by the sandbox flag and the worktree, not by this check.
    expect(validateRuntimeBlock(external(), ["read", "run-command"]).ok).toBe(true);
  });

  test("several offending actions are all named in one reason", () => {
    const result = validateRuntimeBlock(external(), ["read", "write", "network"]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("write");
    expect(result.ok === false && result.reason).toContain("network");
  });

  test("an empty action list is consistent with read-only", () => {
    expect(validateRuntimeBlock(external(), []).ok).toBe(true);
  });
});

describe("readRuntimeBlock reads defensively", () => {
  test("extracts a well-formed block", () => {
    expect(readRuntimeBlock({ runtime: { kind: "external", agent: "codex-cli" } })).toMatchObject({
      kind: "external",
    });
  });

  test.each([
    ["a non-object dispatch", "nope"],
    ["null", null],
    ["a dispatch with no runtime", { task: {} }],
    ["a non-object runtime", { runtime: "external" }],
    ["a null runtime", { runtime: null }],
    ["an unrecognised kind", { runtime: { kind: "wasm" } }],
    ["a missing kind", { runtime: { agent: "codex-cli" } }],
  ])("returns undefined for %s", (_label, input) => {
    expect(readRuntimeBlock(input)).toBeUndefined();
  });

  test("a malformed block degrades to the native runtime, not to a crash", () => {
    // The schema rejects malformed input; this must not become a second,
    // divergent parser of the same contract.
    const block = readRuntimeBlock({ runtime: { kind: "wasm" } });
    expect(validateRuntimeBlock(block, ["read"])).toEqual({ ok: true, runtime: "keryx" });
  });
});
