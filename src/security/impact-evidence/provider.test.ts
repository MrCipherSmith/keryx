// Flow 308 (W8, Lane B, T6): AC10-AC15 for the impact-evidence provider.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createImpactEvidenceProvider,
  impactEvidenceHookClass,
  normalizeRequestFiles,
  redactCommandForLog,
} from "./provider";
import { readLogRecords } from "./state";
import type { ImpactEvidence, ImpactEvidenceRequest } from "./types";
import type { ImpactEvidenceConfig } from "../types";
import { computeConfigChecksum, mergeSecurityConfig, renderSecurityConfig } from "../config";

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

  test("F17: dampening is per-file — a dampened file gets a condensed notice, a sibling first-touch file still gets full evidence", async () => {
    const computeEvidence = async (_root: string, file: string) => fakeEvidence(file);
    const dampenSoonConfig: ImpactEvidenceConfig = { ...DEFAULT_CONFIG, dampenAfter: 2 };
    const provider = createImpactEvidenceProvider({ computeEvidence, loadConfig: async () => dampenSoonConfig });

    // Two denied first-touch requests for src/a.ts alone cross dampenAfter:2.
    await provider(baseRequest(root, { sessionId: "s1", files: ["src/a.ts"], denied: true })); // denial 1
    await provider(baseRequest(root, { sessionId: "s1", files: ["src/a.ts"], denied: true })); // denial 2 -> dampened

    // Same session, a batch naming the now-dampened src/a.ts alongside a
    // fresh first-touch src/b.ts that was never denied.
    const decision = await provider(baseRequest(root, { sessionId: "s1", files: ["src/a.ts", "src/b.ts"] }));
    expect(decision.additionalContext).toContain("dampened after repeated denials for: src/a.ts");
    // Full evidence for src/b.ts is still rendered (not just named) — its
    // "## src/b.ts" section header, not merely a mention.
    expect(decision.additionalContext).toContain("## src/b.ts");
    expect(decision.additionalContext).not.toContain("## src/a.ts");
  });

  test("N8: strict mode does not re-ask with the FULL block forever — a re-ask without acknowledgement gets the condensed notice and is later acknowledged", async () => {
    const computeEvidence = async (_root: string, file: string) => fakeEvidence(file);
    const strictConfig: ImpactEvidenceConfig = { ...DEFAULT_CONFIG, strict: true, dampenAfter: 100 };
    const provider = createImpactEvidenceProvider({ computeEvidence, loadConfig: async () => strictConfig });

    // 1st ask: no acknowledgement yet -> full block, outcome ask.
    const first = await provider(baseRequest(root, { sessionId: "s-ack", files: ["src/a.ts"] }));
    expect(first.outcome).toBe("ask");
    expect(first.additionalContext).toContain("## src/a.ts");

    // 2nd request, still no acknowledgement -> asked again, but CONDENSED,
    // not the full block recomputed (dampenAfter is high, so this is not
    // the ordinary denial-count dampening path).
    const second = await provider(baseRequest(root, { sessionId: "s-ack", files: ["src/a.ts"] }));
    expect(second.outcome).toBe("ask");
    expect(second.additionalContext).not.toContain("## src/a.ts");
    expect(second.additionalContext).toContain("src/a.ts");

    // 3rd request, WITH a non-empty acknowledgement -> allowed and marked
    // touched.
    const third = await provider(
      baseRequest(root, { sessionId: "s-ack", files: ["src/a.ts"], acknowledgement: "reviewed the evidence" }),
    );
    expect(third.outcome).toBe("allow");

    // 4th request, same file, same session -> already touched, no re-ask.
    const fourth = await provider(baseRequest(root, { sessionId: "s-ack", files: ["src/a.ts"] }));
    expect(fourth.record.event).toBe("skipped-repeat");
  });

  test("N8: an unacknowledged re-ask still counts toward the ordinary dampening threshold", async () => {
    const computeEvidence = async (_root: string, file: string) => fakeEvidence(file);
    const strictConfig: ImpactEvidenceConfig = { ...DEFAULT_CONFIG, strict: true, dampenAfter: 2 };
    const provider = createImpactEvidenceProvider({ computeEvidence, loadConfig: async () => strictConfig });

    await provider(baseRequest(root, { sessionId: "s-ack-dampen", files: ["src/a.ts"] })); // ask 1
    const second = await provider(baseRequest(root, { sessionId: "s-ack-dampen", files: ["src/a.ts"] })); // ask 2 -> crosses dampenAfter:2
    expect(second.outcome).toBe("ask");
    expect(second.record.event).toBe("dampened");
  });

  test("F12: strict (gate) mode fails CLOSED on evidence-service failure in every profile, reason hook-crashed", async () => {
    const throwingCompute = async (): Promise<ImpactEvidence> => {
      throw new Error("boom");
    };
    const strictConfig: ImpactEvidenceConfig = { ...DEFAULT_CONFIG, strict: true };

    for (const profile of ["read-only-review", "monitored-trusted-local", "unattended-untrusted"] as const) {
      const provider = createImpactEvidenceProvider({ computeEvidence: throwingCompute, loadConfig: async () => strictConfig });
      const decision = await provider(baseRequest(root, { sessionId: `s-strict-${profile}`, files: ["src/x.ts"], profile }));
      expect(decision.outcome).toBe("deny");
      expect(decision.reason).toBe("hook-crashed");
      expect(decision.hookClass).toBe("gate");
    }
  });

  test("F14: an absolute file_path inside root is normalized to a root-relative POSIX path before evidence is computed", async () => {
    const seen: string[] = [];
    const computeEvidence = async (_root: string, file: string) => {
      seen.push(file);
      return fakeEvidence(file);
    };
    const provider = createImpactEvidenceProvider({ computeEvidence, loadConfig: async () => DEFAULT_CONFIG });

    const absolute = path.join(root, "src", "a.ts");
    const decision = await provider(baseRequest(root, { files: [absolute] }));

    expect(seen).toEqual(["src/a.ts"]);
    expect(decision.additionalContext).toContain("src/a.ts");
    expect(decision.additionalContext).not.toContain(absolute);
  });

  test("F14: a path that normalizes outside root is dropped with a warning and a path-rejected log entry", async () => {
    const computeEvidence = async (_root: string, file: string) => fakeEvidence(file);
    const provider = createImpactEvidenceProvider({ computeEvidence, loadConfig: async () => DEFAULT_CONFIG });

    const outside = path.join(path.dirname(root), "elsewhere", "secret.ts");
    const decision = await provider(baseRequest(root, { sessionId: "s-outside", files: [outside] }));

    expect(decision.warnings.some((w) => w.includes("outside the project root"))).toBe(true);
    const records = await readLogRecords(root);
    expect(records.some((r) => r.sessionId === "s-outside" && r.event === "path-rejected" && r.files.includes(outside))).toBe(
      true,
    );
  });

  test("normalizeRequestFiles: relative traversal (`../x`) is rejected the same way an absolute escape is", () => {
    const result = normalizeRequestFiles("/proj", ["../outside.ts", "./src/a.ts", "src/b.ts"]);
    expect(result.files.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.rejected).toEqual(["../outside.ts"]);
  });

  test("F14 (round 2): a MID-PATH `..` that never starts with `../` still resolves outside root and is rejected", async () => {
    const computeEvidence = async (_root: string, file: string) => fakeEvidence(file);
    const provider = createImpactEvidenceProvider({ computeEvidence, loadConfig: async () => DEFAULT_CONFIG });

    // Lexically this does not start with "../" — round 1's `startsWith`
    // check let it straight through. `unattended-untrusted` so a rejected
    // path denies (F14(d)) rather than merely warning.
    const decision = await provider(
      baseRequest(root, { sessionId: "s-midpath", files: ["src/../../../etc/passwd"], profile: "unattended-untrusted" }),
    );
    expect(decision.outcome).toBe("deny");
    expect(decision.reason).toBe("path-outside-root");
    const records = await readLogRecords(root);
    expect(
      records.some(
        (r) => r.sessionId === "s-midpath" && r.event === "path-rejected" && r.files.includes("src/../../../etc/passwd"),
      ),
    ).toBe(true);
  });

  test("F14 (round 2): a symlink under root pointing OUTSIDE root is rejected even though it is lexically inside root", async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), "keryx-impact-evidence-outside-"));
    await writeFile(path.join(outsideDir, "secret.ts"), "export const secret = 1;\n", "utf8");
    await mkdir(path.join(root, "src"), { recursive: true });
    await symlink(outsideDir, path.join(root, "src", "linked"));

    const computeEvidence = async (_root: string, file: string) => fakeEvidence(file);
    const provider = createImpactEvidenceProvider({ computeEvidence, loadConfig: async () => DEFAULT_CONFIG });
    const decision = await provider(
      baseRequest(root, { sessionId: "s-symlink", files: ["src/linked/secret.ts"], profile: "unattended-untrusted" }),
    );
    expect(decision.outcome).toBe("deny");
    expect(decision.reason).toBe("path-outside-root");
    const records = await readLogRecords(root);
    expect(
      records.some(
        (r) => r.sessionId === "s-symlink" && r.event === "path-rejected" && r.files.includes("src/linked/secret.ts"),
      ),
    ).toBe(true);

    await rm(outsideDir, { recursive: true, force: true });
  });

  test("F14 (round 2): a request whose only file is rejected DENIES under gate (strict) and under unattended-untrusted, rather than falling through to allow", async () => {
    const outside = path.join(path.dirname(root), "elsewhere-deny-test", "secret.ts");

    const strictConfig: ImpactEvidenceConfig = { ...DEFAULT_CONFIG, strict: true };
    const strictProvider = createImpactEvidenceProvider({ loadConfig: async () => strictConfig });
    const strictDecision = await strictProvider(baseRequest(root, { sessionId: "s-deny-strict", files: [outside] }));
    expect(strictDecision.outcome).toBe("deny");
    expect(strictDecision.reason).toBe("path-outside-root");

    const untrustedProvider = createImpactEvidenceProvider({ loadConfig: async () => DEFAULT_CONFIG });
    const untrustedDecision = await untrustedProvider(
      baseRequest(root, { sessionId: "s-deny-unattended", files: [outside], profile: "unattended-untrusted" }),
    );
    expect(untrustedDecision.outcome).toBe("deny");
    expect(untrustedDecision.reason).toBe("path-outside-root");

    // Supervised advisory still allows through, with a warning — a human is
    // watching there.
    const supervisedProvider = createImpactEvidenceProvider({ loadConfig: async () => DEFAULT_CONFIG });
    const supervisedDecision = await supervisedProvider(
      baseRequest(root, { sessionId: "s-deny-supervised", files: [outside], profile: "monitored-trusted-local" }),
    );
    expect(supervisedDecision.outcome).toBe("allow");
    expect(supervisedDecision.warnings.some((w) => w.includes("outside the project root"))).toBe(true);
  });

  test("F15: the log stores a redacted command (hash + family), never the raw destructive command text", async () => {
    const provider = createImpactEvidenceProvider({ loadConfig: async () => DEFAULT_CONFIG });
    await provider(baseRequest(root, { sessionId: "s-redact", files: [], command: "rm -rf /" }));

    const records = await readLogRecords(root);
    const record = records.find((r) => r.sessionId === "s-redact" && r.event === "rollback-required");
    expect(record?.detail).toBeDefined();
    expect(record?.detail).not.toBe("rm -rf /");
    expect(record?.detail).not.toContain("rm -rf /");
    expect(record?.detail).toContain("family:rm");
    expect(record?.detail).toMatch(/^sha256:[0-9a-f]{12} family:rm$/);
  });

  test("redactCommandForLog: identical commands hash identically, different commands do not", () => {
    const a = redactCommandForLog("rm -rf /tmp/x");
    const b = redactCommandForLog("rm -rf /tmp/x");
    const c = redactCommandForLog("git reset --hard");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain("/tmp/x");
  });

  test("F11: a tampered impactEvidence.enabled:false kill switch is ignored — the gate stays on and logs config-untrusted", async () => {
    const merged = mergeSecurityConfig({ impactEvidence: { enabled: true, strict: false, exemptGlobs: [], dampenAfter: 3 } });
    const sealed = { ...merged, configChecksum: computeConfigChecksum(merged) };
    // Tamper the kill switch WITHOUT resealing the checksum.
    const tampered = { ...sealed, impactEvidence: { ...sealed.impactEvidence!, enabled: false } };

    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "security.config.json"), JSON.stringify(tampered, null, 2), "utf8");
    await mkdir(path.join(root, ".metaproject", "data", "gdgraph", "storage"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"),
      '{"id":"src/a.ts","kind":"file","path":"src/a.ts","language":"typescript"}\n',
      "utf8",
    );
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");

    // No `loadConfig` override here — this exercises the REAL on-disk config
    // + checksum path (`resolveImpactEvidenceConfigTrusted`), unlike every
    // other test in this file.
    const provider = createImpactEvidenceProvider();
    const decision = await provider(baseRequest(root, { sessionId: "s-tampered", files: ["src/a.ts"] }));

    expect(decision.record.event).not.toBe("disabled-config");
    expect(decision.warnings.some((w) => w.includes("checksum"))).toBe(true);

    const records = await readLogRecords(root);
    expect(records.some((r) => r.sessionId === "s-tampered" && r.event === "config-untrusted")).toBe(true);
  });

  test("F11: a hand-written impactEvidence.enabled:false with NO configChecksum at all is ignored too — the gate stays on and logs config-untrusted with detail 'absent'", async () => {
    // No `configChecksum` field whatsoever — the round-1 fix only caught a
    // checksum that was present and WRONG; an absent one used to be treated
    // as "verified" (nothing to tamper with yet) and the kill switch was
    // honored.
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "security.config.json"),
      JSON.stringify({ impactEvidence: { enabled: false } }, null, 2),
      "utf8",
    );
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");

    const provider = createImpactEvidenceProvider();
    const decision = await provider(baseRequest(root, { sessionId: "s-no-checksum", files: ["src/a.ts"] }));

    expect(decision.record.event).not.toBe("disabled-config");

    const records = await readLogRecords(root);
    const record = records.find((r) => r.sessionId === "s-no-checksum" && r.event === "config-untrusted");
    expect(record).toBeDefined();
    expect(record?.detail).toBe("absent");
  });

  test("F11: an impactEvidence block resealed via renderSecurityConfig (a real configChecksum) is honored, including a loosening enabled:false", async () => {
    const merged = mergeSecurityConfig({ impactEvidence: { enabled: false, strict: false, exemptGlobs: [], dampenAfter: 3 } });
    const rendered = renderSecurityConfig(merged);

    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "security.config.json"), rendered, "utf8");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");

    const provider = createImpactEvidenceProvider();
    const decision = await provider(baseRequest(root, { sessionId: "s-sealed", files: ["src/a.ts"] }));

    // The honestly-sealed kill switch is honored: the gate allows and logs
    // disabled-config, not config-untrusted.
    expect(decision.record.event).toBe("disabled-config");
    const records = await readLogRecords(root);
    expect(records.some((r) => r.sessionId === "s-sealed" && r.event === "config-untrusted")).toBe(false);
  });
});
