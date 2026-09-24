// Flow 308 (W8, Lane B, T6): AC10-AC15 for the impact-evidence provider.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createImpactEvidenceProvider, impactEvidenceHookClass } from "./provider";
import { readLogRecords } from "./state";
import type { ImpactEvidence, ImpactEvidenceRequest } from "./types";
import type { ImpactEvidenceConfig } from "../types";

const DEFAULT_CONFIG: ImpactEvidenceConfig = { enabled: true, strict: false, exemptGlobs: [], dampenAfter: 3 };

function fakeEvidence(file: string, status: ImpactEvidence["importers"]["status"] = "ok"): ImpactEvidence {
  return {
    file,
    importers: { status, json: JSON.stringify({ target: file, dependents: [], dependencies: [], ranked: [] }, null, 2) },
    relatedTests: { status: "complete", json: JSON.stringify({ schemaVersion: 1, target: file, context: { status: "complete", incompleteReasons: [] }, related: [] }, null, 2) },
    memoryCaveats: [],
  };
}

function baseRequest(root: string, overrides: Partial<ImpactEvidenceRequest> = {}): ImpactEvidenceRequest {
  return {
    root,
    sessionId: "session-1",
    toolName: "Edit",
    files: ["src/a.ts"],
    profile: "monitored-trusted-local",
    env: {},
    ...overrides,
  };
}

describe("impact-evidence provider", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-impact-evidence-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("impactEvidenceHookClass: gate-advisory by default, gate in strict mode", () => {
    expect(impactEvidenceHookClass(false)).toBe("gate-advisory");
    expect(impactEvidenceHookClass(true)).toBe("gate");
  });

  test("AC10: a second edit of the same file injects no block; a different file gets its own full block", async () => {
    const computeEvidence = async (_root: string, file: string) => fakeEvidence(file);
    const provider = createImpactEvidenceProvider({
      computeEvidence,
      loadConfig: async () => DEFAULT_CONFIG,
    });

    const first = await provider(baseRequest(root, { files: ["src/a.ts"] }));
    expect(first.outcome).toBe("allow");
    expect(first.additionalContext).toBeDefined();
    expect(first.record.event).toBe("injected");

    const second = await provider(baseRequest(root, { files: ["src/a.ts"] }));
    expect(second.outcome).toBe("allow");
    expect(second.additionalContext).toBeUndefined();
    expect(second.record.event).toBe("skipped-repeat");

    const differentFile = await provider(baseRequest(root, { files: ["src/b.ts"] }));
    expect(differentFile.additionalContext).toBeDefined();
    expect(differentFile.additionalContext).toContain("src/b.ts");
    expect(differentFile.record.event).toBe("injected");
  });

  test("AC11: an unindexed target says 'not indexed', never 'no importers found'", async () => {
    const computeEvidence = async (_root: string, file: string) => fakeEvidence(file, "not-indexed");
    const provider = createImpactEvidenceProvider({ computeEvidence, loadConfig: async () => DEFAULT_CONFIG });

    const decision = await provider(baseRequest(root, { files: ["src/unindexed.ts"] }));
    expect(decision.additionalContext).toContain("not indexed");
    expect(decision.additionalContext?.toLowerCase()).not.toContain("no importers found");
  });

  test("AC12: a batch of three first-touch files names all three in one block", async () => {
    const computeEvidence = async (_root: string, file: string) => fakeEvidence(file);
    const provider = createImpactEvidenceProvider({ computeEvidence, loadConfig: async () => DEFAULT_CONFIG });

    const decision = await provider(baseRequest(root, { files: ["src/a.ts", "src/b.ts", "src/c.ts"] }));
    expect(decision.additionalContext).toContain("src/a.ts");
    expect(decision.additionalContext).toContain("src/b.ts");
    expect(decision.additionalContext).toContain("src/c.ts");
  });

  test("AC13: a destructive command requires a non-empty rollback line, in every profile, unless the kill switch is set", async () => {
    for (const profile of ["read-only-review", "monitored-trusted-local", "unattended-untrusted"] as const) {
      const provider = createImpactEvidenceProvider({ loadConfig: async () => DEFAULT_CONFIG });
      const asked = await provider(baseRequest(root, { sessionId: `s-${profile}`, files: [], command: "rm -rf /", profile }));
      expect(asked.outcome).toBe("ask");
      expect(asked.reason).toBe("rollback-line-required");

      const allowed = await provider(
        baseRequest(root, { sessionId: `s-${profile}-ok`, files: [], command: "rm -rf /", rollbackLine: "restore from backup X", profile }),
      );
      expect(allowed.outcome).toBe("allow");
    }
  });

  test("AC13: a non-destructive command is never asked for a rollback line", async () => {
    const provider = createImpactEvidenceProvider({ loadConfig: async () => DEFAULT_CONFIG });
    const decision = await provider(baseRequest(root, { files: [], command: "ls -la" }));
    expect(decision.outcome).toBe("allow");
    expect(decision.reason).toBeUndefined();
  });

  test("AC13/AC15: the kill switch allows a destructive command without a rollback line, and logs disabled-env", async () => {
    const provider = createImpactEvidenceProvider({ loadConfig: async () => DEFAULT_CONFIG });
    const decision = await provider(
      baseRequest(root, { files: [], command: "rm -rf /", env: { KERYX_DISABLE_IMPACT_GATE: "1" } }),
    );
    expect(decision.outcome).toBe("allow");
    expect(decision.record.event).toBe("disabled-env");

    const records = await readLogRecords(root);
    expect(records.some((r) => r.event === "disabled-env")).toBe(true);
  });

  test("AC14: the evidence service throwing denies under unattended-untrusted, and allows-with-warning under the other two profiles", async () => {
    const throwingCompute = async (): Promise<ImpactEvidence> => {
      throw new Error("boom");
    };

    const untrusted = createImpactEvidenceProvider({ computeEvidence: throwingCompute, loadConfig: async () => DEFAULT_CONFIG });
    const deny = await untrusted(baseRequest(root, { sessionId: "s1", files: ["src/x.ts"], profile: "unattended-untrusted" }));
    expect(deny.outcome).toBe("deny");
    expect(deny.reason).toBe("hook-advisory-failed");
    expect(deny.record.event).toBe("service-failed");

    for (const profile of ["read-only-review", "monitored-trusted-local"] as const) {
      const provider = createImpactEvidenceProvider({ computeEvidence: throwingCompute, loadConfig: async () => DEFAULT_CONFIG });
      const decision = await provider(baseRequest(root, { sessionId: `s-${profile}`, files: ["src/x.ts"], profile }));
      expect(decision.outcome).toBe("allow");
      expect(decision.warnings.length).toBeGreaterThan(0);
    }
  });

  test("AC14: hookClass is gate-advisory by default and gate in strict mode", async () => {
    const computeEvidence = async (_root: string, file: string) => fakeEvidence(file);
    const advisory = createImpactEvidenceProvider({ computeEvidence, loadConfig: async () => DEFAULT_CONFIG });
    const advisoryDecision = await advisory(baseRequest(root, { files: ["src/a.ts"] }));
    expect(advisoryDecision.hookClass).toBe("gate-advisory");

    const strictConfig: ImpactEvidenceConfig = { ...DEFAULT_CONFIG, strict: true };
    const strict = createImpactEvidenceProvider({ computeEvidence, loadConfig: async () => strictConfig });
    const strictDecision = await strict(baseRequest(root, { sessionId: "s-strict", files: ["src/a.ts"], acknowledgement: "ok" }));
    expect(strictDecision.hookClass).toBe("gate");
  });

  test("AC15: env kill switch, config kill switch, and a normal run produce distinguishable log events", async () => {
    const computeEvidence = async (_root: string, file: string) => fakeEvidence(file);

    const envDisabled = createImpactEvidenceProvider({ computeEvidence, loadConfig: async () => DEFAULT_CONFIG });
    await envDisabled(baseRequest(root, { sessionId: "env", files: ["src/a.ts"], env: { KERYX_DISABLE_IMPACT_GATE: "1" } }));

    const configDisabled = createImpactEvidenceProvider({
      computeEvidence,
      loadConfig: async () => ({ ...DEFAULT_CONFIG, enabled: false }),
    });
    await configDisabled(baseRequest(root, { sessionId: "config", files: ["src/a.ts"] }));

    const normal = createImpactEvidenceProvider({ computeEvidence, loadConfig: async () => DEFAULT_CONFIG });
    await normal(baseRequest(root, { sessionId: "normal", files: ["src/a.ts"] }));

    const records = await readLogRecords(root);
    expect(records.some((r) => r.sessionId === "env" && r.event === "disabled-env")).toBe(true);
    expect(records.some((r) => r.sessionId === "config" && r.event === "disabled-config")).toBe(true);
    expect(records.some((r) => r.sessionId === "normal" && r.event === "injected")).toBe(true);
  });

  test("AC10 (dampening): repeated denials collapse the block to a condensed notice after dampenAfter", async () => {
    const computeEvidence = async (_root: string, file: string) => fakeEvidence(file);
    const dampenSoonConfig: ImpactEvidenceConfig = { ...DEFAULT_CONFIG, dampenAfter: 2 };
    const provider = createImpactEvidenceProvider({ computeEvidence, loadConfig: async () => dampenSoonConfig });

    const req = (denied: boolean) => baseRequest(root, { sessionId: "dampen", files: ["src/a.ts"], denied });

    await provider(req(true)); // denial 1
    const second = await provider(req(true)); // denial 2 -> at threshold
    expect(second.additionalContext).toContain("dampened");
    expect(second.record.event).toBe("dampened");
  });
});
