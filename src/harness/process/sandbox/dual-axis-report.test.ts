import { describe, expect, test } from "bun:test";
import {
  buildDualAxisReportMarkdown,
  countSecretLeaks,
  DUAL_AXIS_CONTRACT,
  overallDualAxisVerdict,
  scanArtifactsForSecrets,
  type DualAxisRow,
} from "./dual-axis-report";
import {
  resolveCredentialMasks,
  resolveMasksFromSandboxEnv,
  type ProviderMaskSource,
} from "./mask-resolve";

const FIXTURE_KEY = "sk-test-fixture-not-real";

const providers: ProviderMaskSource[] = [
  { envKey: "DEEPSEEK_API_KEY", baseUrl: "https://api.deepseek.com" },
];

describe("DUAL_AXIS_CONTRACT (AC-V1)", () => {
  test("Axis A is not mask proof; Axis B is mask proof", () => {
    expect(DUAL_AXIS_CONTRACT.axisA.isMaskProof).toBe(false);
    expect(DUAL_AXIS_CONTRACT.axisB.isMaskProof).toBe(true);
    expect(DUAL_AXIS_CONTRACT.axisC.isMaskProof).toBe(false);
  });

  test("Axis A PASS does not prove masking when Axis B fails", () => {
    const rows: DualAxisRow[] = [
      { axis: "Preflight", verdict: "PASS", notes: "ok" },
      { axis: "A", verdict: "PASS", notes: "model turn ok" },
      { axis: "B", verdict: "FAIL", notes: "key still cleartext" },
      { axis: "C", verdict: "PASS", notes: "parity" },
    ];
    expect(overallDualAxisVerdict({ rows, redactionHits: 0, requireAxisBPass: true })).toBe("FAIL");
  });

  test("Axis A PASS alone with requireAxisBPass and missing B is FAIL", () => {
    const rows: DualAxisRow[] = [
      { axis: "Preflight", verdict: "PASS", notes: "ok" },
      { axis: "A", verdict: "PASS", notes: "model ok — not mask proof" },
    ];
    expect(overallDualAxisVerdict({ rows, redactionHits: 0, requireAxisBPass: true })).toBe("FAIL");
  });

  test("overall PASS only when B passes and no redaction hits", () => {
    const rows: DualAxisRow[] = [
      { axis: "Preflight", verdict: "PASS", notes: "ok" },
      { axis: "A", verdict: "PASS", notes: "model" },
      { axis: "B", verdict: "PASS", notes: "sentinel" },
      { axis: "C", verdict: "PASS", notes: "parity" },
    ];
    expect(overallDualAxisVerdict({ rows, redactionHits: 0, requireAxisBPass: true })).toBe("PASS");
  });
});

describe("S1–S4 reassert (AC-V2)", () => {
  test("S1: auto derive deepseek + tls auto-derived", () => {
    const r = resolveCredentialMasks({
      mode: "auto",
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY },
      explicitSpecs: [],
      providers,
      allowAutoTls: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolution.masks).toEqual([
      { name: "DEEPSEEK_API_KEY", injectHosts: ["api.deepseek.com"], source: "auto" },
    ]);
    expect(r.resolution.tlsTerminate).toBe(true);
    expect(r.resolution.tlsSource).toBe("auto-derived");
  });

  test("S2: manual only → empty masks", () => {
    const r = resolveCredentialMasks({
      mode: "manual",
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY },
      explicitSpecs: [],
      providers,
      allowAutoTls: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolution.masks).toEqual([]);
  });

  test("S3: masks + tlsExplicit false → ok:false", () => {
    const r = resolveCredentialMasks({
      mode: "manual",
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY },
      explicitSpecs: ["DEEPSEEK_API_KEY@api.deepseek.com"],
      providers,
      tlsExplicit: false,
      allowAutoTls: false,
    });
    expect(r.ok).toBe(false);
  });

  test("S4: merge explicit hosts win", () => {
    const r = resolveCredentialMasks({
      mode: "auto",
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY },
      explicitSpecs: ["DEEPSEEK_API_KEY@b.example.com"],
      providers,
      allowAutoTls: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolution.masks[0]).toEqual({
      name: "DEEPSEEK_API_KEY",
      injectHosts: ["b.example.com"],
      source: "merged",
    });
  });

  test("Axis C parity still holds via shared env builder", () => {
    const env = {
      KERYX_SANDBOX_MASK_MODE: "auto",
      DEEPSEEK_API_KEY: FIXTURE_KEY,
    };
    const shell = resolveMasksFromSandboxEnv({ env, providers });
    const harness = resolveMasksFromSandboxEnv({
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY },
      modeOverride: "auto",
      providers,
    });
    expect(shell.ok && harness.ok).toBe(true);
    if (!shell.ok || !harness.ok) return;
    expect(shell.resolution.masks).toEqual(harness.resolution.masks);
  });
});

describe("redaction gate (AC-V3)", () => {
  test("REPORT with fixture key fails secret scan", () => {
    const badReport = buildDualAxisReportMarkdown([
      { axis: "Preflight", verdict: "PASS", notes: "ok" },
      { axis: "B", verdict: "PASS", notes: `child saw ${FIXTURE_KEY}` },
    ]);
    expect(badReport).toContain(FIXTURE_KEY);
    const hits = countSecretLeaks(badReport, [FIXTURE_KEY]);
    expect(hits).toBeGreaterThan(0);
    expect(
      overallDualAxisVerdict({
        rows: [{ axis: "B", verdict: "PASS", notes: "ok" }],
        redactionHits: hits,
        requireAxisBPass: true,
      }),
    ).toBe("FAIL");
  });

  test("clean REPORT has zero leaks", () => {
    const report = buildDualAxisReportMarkdown([
      { axis: "Preflight", verdict: "PASS", notes: "key present (name only)" },
      { axis: "A", verdict: "PASS", notes: "model turn — not mask proof" },
      { axis: "B", verdict: "PASS", notes: "sentinel in child env" },
      { axis: "C", verdict: "PASS", notes: "parity" },
    ]);
    expect(report).not.toContain(FIXTURE_KEY);
    const scan = scanArtifactsForSecrets(
      [
        { name: "REPORT.md", text: report },
        { name: "axis-b.md", text: "sentinel keryx-sentinel-xxxx" },
      ],
      [FIXTURE_KEY],
    );
    expect(scan.totalHits).toBe(0);
  });

  test("scanArtifactsForSecrets aggregates hits across RUN_DIR files", () => {
    const scan = scanArtifactsForSecrets(
      [
        { name: "REPORT.md", text: "clean" },
        { name: "axis-b.md", text: `leaked ${FIXTURE_KEY} once` },
      ],
      [FIXTURE_KEY],
    );
    expect(scan.totalHits).toBe(1);
    expect(scan.byArtifact["axis-b.md"]).toBe(1);
    expect(scan.byArtifact["REPORT.md"]).toBe(0);
  });
});

describe("buildDualAxisReportMarkdown", () => {
  test("emits required table headers and axes", () => {
    const md = buildDualAxisReportMarkdown([
      { axis: "Preflight", verdict: "PASS", notes: "ok" },
      { axis: "A", verdict: "SKIP", notes: "no multi-agent" },
      { axis: "B", verdict: "PASS", notes: "sentinel" },
      { axis: "C", verdict: "PASS", notes: "parity" },
    ]);
    expect(md).toContain("| Axis | Verdict | Notes |");
    expect(md).toContain("| Preflight | PASS |");
    expect(md).toContain("| A | SKIP |");
    expect(md).toContain("| B | PASS |");
    expect(md).toContain("| C | PASS |");
    expect(md).toContain("Redaction gate");
  });
});
