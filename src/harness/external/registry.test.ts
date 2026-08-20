// Tests for the external agent registry (flow 176, T6). Offline: nothing here
// spawns a CLI, and detection output is injected as a string.
import { describe, expect, test } from "bun:test";
import {
  EXTERNAL_AGENTS,
  compareVersions,
  externalAgentIds,
  getExternalAgent,
  judgeVersion,
  parseAgentVersion,
  resolveAvailability,
  supportsSandbox,
} from "./registry";
import type { ExternalAgentEntry } from "./types";

const CODEX = getExternalAgent("codex-cli") as ExternalAgentEntry;
const CLAUDE = getExternalAgent("claude-cli") as ExternalAgentEntry;

describe("registry shape", () => {
  test("ships exactly the two agents this release specifies", () => {
    expect(externalAgentIds()).toEqual(["codex-cli", "claude-cli"]);
  });

  test("an unknown agent resolves to undefined so callers fail closed", () => {
    expect(getExternalAgent("opencode")).toBeUndefined();
    expect(getExternalAgent("")).toBeUndefined();
  });

  test("detect argv spends no quota — it is a version flag, not a prompt", () => {
    for (const entry of EXTERNAL_AGENTS) {
      expect(entry.detect).toEqual(["--version"]);
    }
  });

  test("codex declares no streaming input, so operator messages route via resume", () => {
    expect(CODEX.streamingInput).toBe(false);
    expect(CODEX.resumable).toBe(true);
  });

  test("claude declares streaming input, a cost report and a native budget flag", () => {
    expect(CLAUDE.streamingInput).toBe(true);
    expect(CLAUDE.reportsCost).toBe(true);
    expect(CLAUDE.budgetFlag).toBe(true);
  });

  test("codex reports no monetary cost, so a caller must show it as missing not zero", () => {
    expect(CODEX.reportsCost).toBe(false);
  });
});

describe("sandboxModes is agent capability, not the keryx release gate", () => {
  test("both agents declare worktree-write because both CLIs support it", () => {
    // The read-only release gate is a SEPARATE runtime refusal. Keeping them
    // apart is what makes "this agent cannot" and "keryx does not yet"
    // distinguishable reasons (specification §4).
    expect(supportsSandbox(CODEX, "worktree-write")).toBe(true);
    expect(supportsSandbox(CLAUDE, "worktree-write")).toBe(true);
  });

  test("a synthetic entry lacking a mode is refused by the capability check", () => {
    const readOnlyOnly: ExternalAgentEntry = { ...CODEX, sandboxModes: ["read-only"] };
    expect(supportsSandbox(readOnlyOnly, "read-only")).toBe(true);
    expect(supportsSandbox(readOnlyOnly, "worktree-write")).toBe(false);
  });
});

describe("parseAgentVersion", () => {
  test("extracts codex's version from its real banner", () => {
    expect(parseAgentVersion(CODEX, "codex-cli 0.147.0")).toBe("0.147.0");
  });

  test("extracts claude's version from its real banner", () => {
    expect(parseAgentVersion(CLAUDE, "2.1.220 (Claude Code)")).toBe("2.1.220");
  });

  test("a renamed banner yields undefined rather than throwing", () => {
    expect(parseAgentVersion(CODEX, "openai codex, build 9")).toBeUndefined();
  });
});

describe("compareVersions", () => {
  test("orders by numeric component, not lexically", () => {
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("2.1.220", "2.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  test("missing components count as zero", () => {
    expect(compareVersions("2.1", "2.1.0")).toBe(0);
    expect(compareVersions("2", "2.0.1")).toBeLessThan(0);
  });

  test("a non-numeric component compares as zero rather than throwing", () => {
    expect(() => compareVersions("1.2.3-rc1", "1.2.3")).not.toThrow();
    expect(compareVersions("1.2.beta", "1.2.0")).toBe(0);
  });
});

describe("judgeVersion is advisory, never a refusal", () => {
  test("the recorded fixture versions are in range", () => {
    expect(judgeVersion(CODEX, "0.147.0").state).toBe("in-range");
    expect(judgeVersion(CLAUDE, "2.1.220").state).toBe("in-range");
  });

  test("a newer version is in range because no upper bound is pinned", () => {
    // Neither CLI publishes a stable event schema, so hard-failing above a max
    // would break the feature on the vendor's next release.
    expect(judgeVersion(CODEX, "1.0.0").state).toBe("in-range");
  });

  test("an older version reports below-min and names the minimum", () => {
    const verdict = judgeVersion(CODEX, "0.100.0");
    expect(verdict).toEqual({ state: "below-min", min: "0.147.0" });
  });

  test("an upper bound, when one is set, reports above-max", () => {
    const capped: ExternalAgentEntry = { ...CODEX, knownGoodRange: { min: "0.147.0", max: "0.200.0" } };
    expect(judgeVersion(capped, "0.201.0")).toEqual({ state: "above-max", max: "0.200.0" });
  });

  test("an unparseable version is unknown, not a failure", () => {
    expect(judgeVersion(CODEX, undefined).state).toBe("unknown");
  });
});

describe("resolveAvailability never claims a login", () => {
  test("no probe at all is `not-probed`, a first-class state", () => {
    // A green tick meaning "nobody asked" costs the operator a dispatch that
    // cannot run (security-policy §1).
    expect(resolveAvailability(CODEX, undefined)).toEqual({ state: "not-probed" });
  });

  test("a missing binary is binary-missing", () => {
    expect(resolveAvailability(CODEX, { binaryFound: false })).toEqual({ state: "binary-missing" });
  });

  test("a found binary reports available with its version and verdict", () => {
    expect(resolveAvailability(CLAUDE, { binaryFound: true, detectOutput: "2.1.220 (Claude Code)" })).toEqual({
      state: "available",
      version: "2.1.220",
      verdict: { state: "in-range" },
    });
  });

  test("a found binary with an unreadable banner is still available, verdict unknown", () => {
    const availability = resolveAvailability(CODEX, { binaryFound: true, detectOutput: "???" });
    expect(availability.state).toBe("available");
    expect(availability).not.toHaveProperty("version");
  });

  test("`available` means runnable, and can never mean logged in", () => {
    // Deliberately asserted: no state in the union carries authentication.
    const availability = resolveAvailability(CODEX, { binaryFound: true, detectOutput: "codex-cli 0.147.0" });
    expect(Object.keys(availability).sort()).toEqual(["state", "verdict", "version"]);
  });
});
