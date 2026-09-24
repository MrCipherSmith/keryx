// Flow 306 (W6, T20; fix round 3, T21): the `keryx.impact-evidence` port
// adapter's own mapping — request shape, outcome->decision mapping, and the
// crash-propagates contract.
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
  test("maps ImpactEvidenceInput to an ImpactEvidenceRequest with the same file list and the constructed profile", async () => {
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
      files: ["/proj/src/a.ts"],
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

  // F-001 (fix round 3): a multi-file `apply_patch` batch must reach the
  // provider with EVERY target file, not just the first — a batch cannot let
  // files 2..n dodge the gate.
  test("a multi-file ImpactEvidenceInput carries every file through to the request", async () => {
    let seen: ImpactEvidenceRequest | undefined;
    const port = createShellImpactEvidenceProvider({
      root: "/proj",
      profile: "monitored-trusted-local",
      provider: async (request) => {
        seen = request;
        return decision();
      },
    });

    await port.evidenceFor({
      sessionId: "s1",
      files: ["/proj/src/a.ts", "/proj/src/b.ts"],
      toolName: "Edit",
      projectRoot: "/proj",
      firstEditInSession: true,
    });

    expect(seen?.files).toEqual(["/proj/src/a.ts", "/proj/src/b.ts"]);
  });

  // Fix round 3 (F-005/hermeticity): an injected `env` is forwarded so a
  // caller never has to mutate the real `process.env` global to flip W8's
  // `KERYX_DISABLE_IMPACT_GATE` kill switch (or any other env-driven branch
  // `provider.ts` reads through `ImpactEvidenceRequest.env`).
  test("an injected env is forwarded on the request", async () => {
    let seen: ImpactEvidenceRequest | undefined;
    const port = createShellImpactEvidenceProvider({
      root: "/proj",
      profile: "monitored-trusted-local",
      env: { KERYX_DISABLE_IMPACT_GATE: "1" },
      provider: async (request) => {
        seen = request;
        return decision();
      },
    });

    await port.evidenceFor({
      sessionId: "s1",
      files: ["/proj/a.ts"],
      toolName: "Write",
      projectRoot: "/proj",
      firstEditInSession: true,
    });

    expect(seen?.env).toEqual({ KERYX_DISABLE_IMPACT_GATE: "1" });
  });

  test("no injected env leaves the request's env field absent", async () => {
    let seen: ImpactEvidenceRequest | undefined;
    const port = createShellImpactEvidenceProvider({
      root: "/proj",
      profile: "monitored-trusted-local",
      provider: async (request) => {
        seen = request;
        return decision();
      },
    });

    await port.evidenceFor({
      sessionId: "s1",
      files: ["/proj/a.ts"],
      toolName: "Write",
      projectRoot: "/proj",
      firstEditInSession: true,
    });

    expect(seen?.env).toBeUndefined();
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
      files: ["/proj/a.ts"],
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
      files: ["/proj/a.ts"],
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
      files: ["/proj/a.ts"],
      toolName: "Write",
      projectRoot: "/proj",
      firstEditInSession: true,
    });
    expect(result).toEqual({ decision: "ask", additionalContext: "please acknowledge" });
  });

  // Fix round 3, F-003: previously BOTH of W8's escalating outcomes ("ask"
  // and its own strict/gate-class "deny") were folded down to "ask" here,
  // which let an operator approve what W8 strict mode requires to fail
  // closed. A W8 "deny" now maps to a real "deny".
  test("deny (W8's own strict/gate class) maps to decision: 'deny', not 'ask'", async () => {
    const port = createShellImpactEvidenceProvider({
      root: "/proj",
      profile: "unattended-untrusted",
      provider: async () => decision({ outcome: "deny", reason: "path-outside-root" }),
    });
    const result = await port.evidenceFor({
      sessionId: "s",
      files: ["/proj/a.ts"],
      toolName: "Write",
      projectRoot: "/proj",
      firstEditInSession: true,
    });
    expect(result.decision).toBe("deny");
  });

  // Fix round 3, F-003: W8's `warnings` used to be dropped entirely.
  test("warnings on an allow decision are forwarded, not dropped", async () => {
    const port = createShellImpactEvidenceProvider({
      root: "/proj",
      profile: "monitored-trusted-local",
      provider: async () =>
        decision({ outcome: "allow", warnings: ["skipped 1 path(s) outside the project root"] }),
    });
    const result = await port.evidenceFor({
      sessionId: "s",
      files: ["/proj/a.ts"],
      toolName: "Write",
      projectRoot: "/proj",
      firstEditInSession: true,
    });
    expect(result.warnings).toEqual(["skipped 1 path(s) outside the project root"]);
  });

  test("no warnings leaves the result's warnings field absent", async () => {
    const port = createShellImpactEvidenceProvider({
      root: "/proj",
      profile: "monitored-trusted-local",
      provider: async () => decision({ outcome: "allow", warnings: [] }),
    });
    const result = await port.evidenceFor({
      sessionId: "s",
      files: ["/proj/a.ts"],
      toolName: "Write",
      projectRoot: "/proj",
      firstEditInSession: true,
    });
    expect(result.warnings).toBeUndefined();
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
        files: ["/proj/a.ts"],
        toolName: "Write",
        projectRoot: "/proj",
        firstEditInSession: true,
      }),
    ).rejects.toThrow("evidence service unavailable");
  });
});
