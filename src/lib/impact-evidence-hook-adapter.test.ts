// Flow 306 (W6, T20): the `keryx.impact-evidence` port adapter's own mapping —
// request shape, outcome->decision mapping, and the crash-propagates contract.
import { describe, expect, test } from "bun:test";
import type { ImpactEvidenceDecision, ImpactEvidenceRequest } from "../security/service";
import { createShellImpactEvidenceProvider } from "./impact-evidence-hook-adapter";

function decision(overrides: Partial<ImpactEvidenceDecision> = {}): ImpactEvidenceDecision {
  return {
    hookId: "keryx.impact-evidence",
    hookClass: "gate-advisory",
    outcome: "allow",
    warnings: [],
    record: { at: "t", sessionId: "s", event: "not-applicable", files: [] },
    ...overrides,
  };
}

describe("createShellImpactEvidenceProvider: request mapping", () => {
  test("maps ImpactEvidenceInput to an ImpactEvidenceRequest with a single-file list and the constructed profile", async () => {
    let seen: ImpactEvidenceRequest | undefined;
    const port = createShellImpactEvidenceProvider({
      root: "/proj",
      profile: "unattended-untrusted",
      provider: async (request) => {
        seen = request;
        return decision();
      },
    });

    await port.evidenceFor({
      sessionId: "s1",
      filePath: "/proj/src/a.ts",
      toolName: "Write",
      projectRoot: "/proj",
      firstEditInSession: true,
    });

    expect(seen).toEqual({
      root: "/proj",
      sessionId: "s1",
      toolName: "Write",
      files: ["/proj/src/a.ts"],
      profile: "unattended-untrusted",
    });
  });
});

describe("createShellImpactEvidenceProvider: outcome -> decision mapping", () => {
  test("allow maps to {} (no decision, no auto-approve)", async () => {
    const port = createShellImpactEvidenceProvider({
      root: "/proj",
      profile: "monitored-trusted-local",
      provider: async () => decision({ outcome: "allow" }),
    });
    const result = await port.evidenceFor({
      sessionId: "s",
      filePath: "/proj/a.ts",
      toolName: "Write",
      projectRoot: "/proj",
      firstEditInSession: true,
    });
    expect(result).toEqual({});
  });

  test("allow with additionalContext carries the context through with no decision", async () => {
    const port = createShellImpactEvidenceProvider({
      root: "/proj",
      profile: "monitored-trusted-local",
      provider: async () => decision({ outcome: "allow", additionalContext: "evidence block" }),
    });
    const result = await port.evidenceFor({
      sessionId: "s",
      filePath: "/proj/a.ts",
      toolName: "Write",
      projectRoot: "/proj",
      firstEditInSession: true,
    });
    expect(result).toEqual({ additionalContext: "evidence block" });
  });

  test("ask maps to decision: 'ask', with its additionalContext", async () => {
    const port = createShellImpactEvidenceProvider({
      root: "/proj",
      profile: "monitored-trusted-local",
      provider: async () =>
        decision({ outcome: "ask", reason: "acknowledgement-required", additionalContext: "please acknowledge" }),
    });
    const result = await port.evidenceFor({
      sessionId: "s",
      filePath: "/proj/a.ts",
      toolName: "Write",
      projectRoot: "/proj",
      firstEditInSession: true,
    });
    expect(result).toEqual({ decision: "ask", additionalContext: "please acknowledge" });
  });

  // W6 registers this port only as `class: "gate-advisory"` (never a hard
  // `deny` at this slot) — a W8 strict/gate "deny" (e.g. a rejected path
  // under `unattended-untrusted`) must still surface as an approval ask,
  // never silently collapse to allow.
  test("deny (W8's own strict/gate class) also maps to decision: 'ask', never to allow", async () => {
    const port = createShellImpactEvidenceProvider({
      root: "/proj",
      profile: "unattended-untrusted",
      provider: async () => decision({ outcome: "deny", reason: "path-outside-root" }),
    });
    const result = await port.evidenceFor({
      sessionId: "s",
      filePath: "/proj/a.ts",
      toolName: "Write",
      projectRoot: "/proj",
      firstEditInSession: true,
    });
    expect(result.decision).toBe("ask");
  });
});

describe("createShellImpactEvidenceProvider: failure propagation", () => {
  test("a rejected provider call throws out of evidenceFor (W6's runtime applies gate-advisory failure semantics)", async () => {
    const port = createShellImpactEvidenceProvider({
      root: "/proj",
      profile: "monitored-trusted-local",
      provider: async () => {
        throw new Error("evidence service unavailable");
      },
    });

    await expect(
      port.evidenceFor({
        sessionId: "s",
        filePath: "/proj/a.ts",
        toolName: "Write",
        projectRoot: "/proj",
        firstEditInSession: true,
      }),
    ).rejects.toThrow("evidence service unavailable");
  });
});
