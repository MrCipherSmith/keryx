import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_HEALTH_CONFIG } from "./config";
import { computeGate } from "./gate";
import { runAdapter, runHealth, writeOutputs } from "./run";
import { createCodeHealthService } from "./service";
import type {
  Finding,
  GateResult,
  HealthContext,
  HealthReport,
  Priority,
  ScopeMetrics,
  SourceAdapter,
  SourceRunInfo,
} from "./types";

type GateWithCoverage = GateResult & { coverage?: "complete" | "partial" | "incomplete" };

function project(): ScopeMetrics {
  return {
    key: "project",
    kind: "project",
    name: "project",
    loc: 1,
    findingCounts: {
      total: 0,
      bySeverity: { error: 0, warning: 0, info: 0 },
      byPriority: { P0: 0, P1: 0, P2: 0, P3: 0 },
      bySource: {},
    },
    coverage: null,
    churn: null,
    complexity: null,
    health_score: 100,
    risk_score: 0,
    trend: "stable",
    regression_score: 0,
  };
}

function source(overrides: Partial<SourceRunInfo>): SourceRunInfo {
  return {
    source: "eslint",
    status: "available",
    mode: "auto",
    required: true,
    imported: false,
    command: null,
    toolVersion: null,
    findings: 0,
    ...overrides,
  };
}

function finding(priority: Priority): Finding {
  return {
    schemaVersion: 1,
    id: `synthetic-${priority}`,
    source: "dependencyAudit",
    severity: "error",
    priority,
    category: "dependency",
    message: "Synthetic blocking advisory",
    file: "package.json",
    line: null,
    symbol: "synthetic-package",
    scope: {
      project: "current",
      module: null,
      file: "package.json",
      entity: null,
      skill: null,
    },
    suggestedAction: null,
    provenance: { command: null, toolVersion: null, rawLog: null },
  };
}

function compute(sources: SourceRunInfo[], findings: Finding[] = []): GateWithCoverage {
  return computeGate({
    findings,
    projectMetrics: project(),
    sources,
    config: DEFAULT_HEALTH_CONFIG,
    strict: false,
  }) as GateWithCoverage;
}

test("required missing, skipped, disabled, and failed checks are incomplete while an optional skip stays visible and non-blocking", () => {
  const requiredCases: SourceRunInfo[] = [
    source({ status: "missing" }),
    source({ status: "skipped" }),
    source({ mode: "disabled", status: "skipped" }),
    source({ status: "configured-but-failed", error: "synthetic execution failure" }),
  ];

  for (const required of requiredCases) {
    const gate = compute([required]);
    expect(String(gate.status)).toBe("incomplete");
    expect(gate.coverage).toBe("incomplete");
    expect(gate.reasons.join("\n")).toContain(required.source);
  }

  const optional = compute([
    source({ source: "coverage", required: false, mode: "import", status: "skipped" }),
  ]);
  // Unchanged, and the point of the required/optional split: an optional
  // source's absence must not BLOCK.
  expect(optional.status).toBe("pass");
  expect(optional.reasons.join("\n")).toMatch(/optional.*coverage.*skipped/i);
  // Changed by F-240-03 (flow 240 T7), deliberately. This used to assert
  // `"complete"`. A coverage import that was ENABLED (`mode: "import"`, not
  // `"disabled"`) and produced nothing is a check that did not run, and the
  // report may not describe the resulting picture as complete. `partial` is the
  // word for "nothing required is broken, but something enabled went
  // unmeasured".
  expect(optional.coverage).toBe("partial");
});

/**
 * F-240-03 (flow 240 T7). Measured against the production `computeGate` and
 * `DEFAULT_HEALTH_CONFIG` before the fix:
 *
 *   dependencyAudit MISSING (no bun, no npm) -> status=pass coverage=complete
 *     reasons=["OPTIONAL: dependencyAudit source missing",
 *              "PASS: no gate conditions triggered"]
 *   dependencyAudit configured-but-failed    -> status=warn coverage=complete
 *
 * `coverage` was computed from broken REQUIRED sources alone, so a dependency
 * audit that never ran — the tool absent, or `npm audit` returning
 * `{"error":{"code":"ENOLOCK"}}` — was recorded as a run that found nothing.
 * Combined with there being no scheduled audit anywhere in `.github/workflows/`,
 * the zero-advisory state this phase reached had no guard at all.
 *
 * The status column is unchanged on purpose: whether a missing optional source
 * should BLOCK is answered by `sources[*].required`, and that answer (optional,
 * with a networked tool) is argued in `src/health/config.ts`. What changes is
 * that the gate can no longer call the picture complete.
 */
test("F-240-03: an optional source that never ran makes coverage partial, without blocking", () => {
  const audit = (overrides: Partial<SourceRunInfo>): SourceRunInfo =>
    source({ source: "dependencyAudit", required: false, mode: "auto", ...overrides });

  const missing = compute([audit({ status: "missing" })]);
  expect(missing.status).toBe("pass");
  expect(missing.coverage).toBe("partial");
  expect(missing.reasons.join("\n")).toContain("OPTIONAL: dependencyAudit source missing");
  expect(missing.reasons.join("\n")).toMatch(/COVERAGE: partial.*dependencyAudit/);

  const failed = compute([audit({ status: "configured-but-failed", error: "synthetic" })]);
  expect(failed.status).toBe("warn");
  expect(failed.coverage).toBe("partial");

  const excludedByFilter = compute([audit({ status: "skipped", error: "excluded by source filter" })]);
  expect(excludedByFilter.coverage).toBe("partial");
});

test("F-240-03: a source that RAN and found nothing is complete, and a disabled one does not count against it", () => {
  const ran = compute([
    source({
      source: "dependencyAudit",
      required: false,
      mode: "auto",
      status: "available",
      execution: "completed",
      parse: "parsed",
      findings: 0,
    }),
  ]);
  expect(ran.status).toBe("pass");
  // The distinction the vocabulary now carries: ran-and-clean, not never-ran.
  expect(ran.coverage).toBe("complete");
  expect(ran.reasons.join("\n")).not.toContain("COVERAGE: partial");

  // An operator switching a check off is a configuration fact, not an
  // unmeasured check — otherwise `sonarqube` (disabled by default) would make
  // every run in every checkout permanently `partial`, and a status nothing can
  // ever clear is a status nobody reads.
  const disabled = compute([
    source({ source: "sonarqube", required: false, mode: "disabled", status: "skipped" }),
  ]);
  expect(disabled.status).toBe("pass");
  expect(disabled.coverage).toBe("complete");
});

test("F-240-03: a broken REQUIRED source still outranks partial", () => {
  const gate = compute([
    source({ source: "eslint", required: true, status: "missing" }),
    source({ source: "dependencyAudit", required: false, mode: "auto", status: "missing" }),
  ]);
  expect(String(gate.status)).toBe("incomplete");
  expect(gate.coverage).toBe("incomplete");
});

test("blocking findings dominate an incomplete required check without hiding incomplete coverage", () => {
  const gate = compute(
    [source({ source: "eslint", required: true, status: "skipped" })],
    [finding("P0")],
  );

  expect(gate.status).toBe("fail");
  expect(gate.coverage).toBe("incomplete");
  expect(gate.reasons.join("\n")).toMatch(/finding/i);
  expect(gate.reasons.join("\n")).toMatch(/eslint/i);
});

test("a source filter records omitted required checks and cannot report a clean gate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-health-filter-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");

    const { report } = await runHealth({ cwd: root, sources: ["complexity"] });
    const gate = report.gate as GateWithCoverage;
    const sourceNames = report.sources.map((entry) => entry.source);

    expect(String(gate.status)).toBe("incomplete");
    expect(gate.coverage).toBe("incomplete");
    expect(sourceNames).toContain("eslint");
    expect(sourceNames).toContain("typescript");
    expect(gate.reasons.join("\n")).toMatch(/filter|selected|scope/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed dependency audit JSON at exit zero is an incomplete parse, not a clean check", async () => {
  const root = await auditFixture("not-json", 0);
  try {
    const { report } = await runHealth({ cwd: root, sources: ["dependencyAudit"] });
    const gate = report.gate as GateWithCoverage;
    const audit = report.sources.find((entry) => entry.source === "dependencyAudit");

    expect(report.findings).toHaveLength(0);
    expect(String(gate.status)).toBe("incomplete");
    expect(gate.coverage).toBe("incomplete");
    expect(audit?.error).toMatch(/parse|format|json/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a recognized Bun audit finding at exit one is retained and fails with complete coverage", async () => {
  const content = JSON.stringify({
    "synthetic-runtime-package": [
      {
        id: "SYNTH-BUN-RUNTIME-1",
        title: "Synthetic runtime advisory",
        severity: "critical",
        vulnerable_versions: "<2.0.0",
      },
    ],
  });
  const root = await auditFixture(content, 1);
  try {
    const { report } = await runHealth({ cwd: root, sources: ["dependencyAudit"] });
    const gate = report.gate as GateWithCoverage;
    const audit = report.sources.find((entry) => entry.source === "dependencyAudit");

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.priority).toBe("P0");
    expect(audit?.findings).toBe(1);
    expect(gate.status).toBe("fail");
    expect(gate.coverage).toBe("complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supported empty audit output completes while an unknown JSON shape is incomplete", async () => {
  const emptyRoot = await auditFixture("{}", 0);
  const unknownRoot = await auditFixture('{"synthetic":"unknown-shape"}', 0);
  try {
    const empty = (await runHealth({ cwd: emptyRoot, sources: ["dependencyAudit"] })).report;
    const emptyAudit = empty.sources.find((entry) => entry.source === "dependencyAudit");
    expect(empty.gate.status).toBe("pass");
    expect(empty.gate.coverage).toBe("complete");
    expect(emptyAudit).toMatchObject({ execution: "completed", parse: "parsed", findings: 0 });

    const unknown = (await runHealth({ cwd: unknownRoot, sources: ["dependencyAudit"] })).report;
    const unknownAudit = unknown.sources.find((entry) => entry.source === "dependencyAudit");
    expect(unknown.gate.status).toBe("incomplete");
    expect(unknownAudit).toMatchObject({ execution: "completed", parse: "failed", findings: 0 });
    expect(unknownAudit?.error).toMatch(/format|recognized/i);
  } finally {
    await Promise.all([
      rm(emptyRoot, { recursive: true, force: true }),
      rm(unknownRoot, { recursive: true, force: true }),
    ]);
  }
});

test("a nonzero tool exit without findings is an execution failure even for valid JSON", async () => {
  const root = await auditFixture("{}", 2);
  try {
    const { report } = await runHealth({ cwd: root, sources: ["dependencyAudit"] });
    const audit = report.sources.find((entry) => entry.source === "dependencyAudit");
    expect(report.gate.status).toBe("incomplete");
    expect(audit).toMatchObject({ execution: "failed", parse: "parsed", exitCode: 2 });
    expect(audit?.error).toMatch(/exited 2/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function auditFixture(content: string, exitCode: number): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-health-audit-"));
  const metaproject = path.join(root, ".metaproject");
  const binDir = path.join(root, "node_modules", ".bin");
  await mkdir(metaproject, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(
    path.join(metaproject, "health.config.json"),
    JSON.stringify({
      sources: {
        eslint: { mode: "disabled", required: false },
        typescript: { mode: "disabled", required: false },
        tests: { mode: "disabled", required: false },
        coverage: { mode: "disabled", required: false },
        dependencyAudit: { mode: "run", required: true },
        sonarqube: { mode: "disabled", required: false },
        complexity: { mode: "disabled", required: false },
      },
    }),
    "utf8",
  );
  const executable = path.join(binDir, "bun");
  await writeFile(
    executable,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '1.3.12\\n'; exit 0; fi\nprintf '%s\\n' '${content}'\nexit ${exitCode}\n`,
    "utf8",
  );
  await chmod(executable, 0o755);
  return root;
}

test("partially malformed audit preserves a blocking finding and incomplete coverage", async () => {
  const root = await auditFixture(JSON.stringify({ vulnerabilities: {
    malformed: null,
    good: { severity: "high", via: [] },
  } }), 0);
  try {
    const { report } = await runHealth({ cwd: root, sources: ["dependencyAudit"] });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.priority).toBe("P0");
    expect(report.gate).toMatchObject({ status: "fail", coverage: "incomplete" });
    expect(report.sources.find((source) => source.source === "dependencyAudit"))
      .toMatchObject({ execution: "completed", parse: "failed", findings: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// T62 F-005 regressions: a health source whose execution throws must never
// echo the caught text into `SourceRunInfo.error` — the value `computeGate`
// interpolates into `gate.reasons`, which reaches both the committable
// `latest.json` artifact and, through the flow completion gate, the durable
// `flow.json` history. The planted message carries a filesystem path AND a
// fake credential (same shape T47/T49 used for the analogous leak in
// `src/flow/*`); neither may survive into the source's `error` or into any
// gate reason, but the gate must still name which source failed and still
// fold to the same "incomplete" verdict a required, unavailable source has
// always produced.
//
// These drive the real production functions directly -- `runAdapter` (the
// function containing all three F-005 catch sites, exported from `run.ts`
// only for this) and `computeGate` (already exported and already used by
// this file's own `compute()` helper above) -- rather than going through
// the full `runHealth()` orchestration via a mocked `./sources` module.
// That approach was tried first and rejected: `mock.module("./sources", ...)`
// replaces the shared module registry for the rest of the `bun test`
// process, and it corrupted an unrelated `runHealth()` call in
// `provenance.test.ts` when both files ran together (reproduced with either
// file ordered first — see run.ts's comment on the export). Calling
// `runAdapter` + `computeGate` directly exercises exactly the two hops
// F-005 names (`SourceRunInfo.error → computeGate → HealthReport.gate.reasons`)
// with zero shared-module risk.
const ATTACKER_PATH = "/Users/attacker/.ssh/id_rsa";
const FAKE_CREDENTIAL = "AKIAIOSFODNN7EXAMPLE";

function leakyError(stage: string): Error {
  const err = new Error(
    `${stage}: ENOENT: no such file or directory, open '${ATTACKER_PATH}' token=${FAKE_CREDENTIAL}`,
  );
  (err as NodeJS.ErrnoException).code = "ENOENT";
  return err;
}

function unreachable(): never {
  throw new Error("unreachable in this regression — the throwing stage should run first");
}

async function healthContext(cwd: string): Promise<HealthContext> {
  return {
    cwd,
    config: DEFAULT_HEALTH_CONFIG,
    strict: false,
    scopeSelector: { kind: "project" },
    changedFiles: null,
    sourceFiles: [],
    moduleOf: () => null,
  };
}

/** The exact path `writeOutputs`/`readLatest` use for the committable
 * artifact, mirroring `dataRoot`'s own join in `util.ts` (not imported here
 * to keep this file's F-004 regressions independent of that helper). */
function artifactPath(cwd: string, file: "latest.json" | "latest.md"): string {
  return path.join(cwd, ".metaproject", "data", "health", "artifacts", file);
}

/** Runs `runAdapter` for a synthetic, throwing adapter, then folds the
 * resulting `SourceRunInfo` through the real `computeGate` exactly the way
 * `runHealth` does, and returns both so a test can assert on each hop. */
async function runThrowingSource(
  adapter: SourceAdapter,
): Promise<{ info: SourceRunInfo; gate: GateWithCoverage }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-health-source-throw-"));
  try {
    const ctx = await healthContext(root);
    const { info } = await runAdapter(adapter, ctx, { mode: "auto", required: true }, "test-stamp");
    const gate = compute([info]);
    return { info, gate };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("F-005: a source whose detect() throws never echoes the caught path or credential", async () => {
  const { info, gate } = await runThrowingSource({
    id: "eslint",
    detect: async () => {
      throw leakyError("detection");
    },
    import: async () => unreachable(),
    run: async () => unreachable(),
    parse: () => [],
  });

  expect(info.status).toBe("configured-but-failed");
  expect(info.execution).toBe("failed");
  expect(info.error).toBeDefined();
  expect(info.error).not.toContain(ATTACKER_PATH);
  expect(info.error).not.toContain(FAKE_CREDENTIAL);
  expect(info.error).toMatch(/detection failed/);

  const reasons = gate.reasons.join("\n");
  expect(reasons).not.toContain(ATTACKER_PATH);
  expect(reasons).not.toContain(FAKE_CREDENTIAL);
  expect(reasons).toMatch(/eslint/);
  expect(gate.status).toBe("incomplete");
});

test("F-005: a source whose import()/run() throws never echoes the caught path or credential", async () => {
  const { info, gate } = await runThrowingSource({
    id: "eslint",
    detect: async () => "available",
    import: async () => {
      throw leakyError("execution");
    },
    run: async () => unreachable(),
    parse: () => [],
  });

  expect(info.status).toBe("configured-but-failed");
  expect(info.execution).toBe("failed");
  expect(info.error).toBeDefined();
  expect(info.error).not.toContain(ATTACKER_PATH);
  expect(info.error).not.toContain(FAKE_CREDENTIAL);
  expect(info.error).toMatch(/execution failed/);

  const reasons = gate.reasons.join("\n");
  expect(reasons).not.toContain(ATTACKER_PATH);
  expect(reasons).not.toContain(FAKE_CREDENTIAL);
  expect(reasons).toMatch(/eslint/);
  expect(gate.status).toBe("incomplete");
});

test("F-005: a source whose parse() throws never echoes the caught path or credential", async () => {
  const { info, gate } = await runThrowingSource({
    id: "eslint",
    detect: async () => "available",
    import: async () => ({
      source: "eslint",
      command: null,
      toolVersion: null,
      exitCode: 0,
      rawPath: "",
      content: "{}",
      imported: true,
    }),
    run: async () => unreachable(),
    parse: () => {
      throw leakyError("parse");
    },
  });

  expect(info.status).toBe("configured-but-failed");
  expect(info.parse).toBe("failed");
  expect(info.error).toBeDefined();
  expect(info.error).not.toContain(ATTACKER_PATH);
  expect(info.error).not.toContain(FAKE_CREDENTIAL);
  expect(info.error).toMatch(/parse failed/);

  const reasons = gate.reasons.join("\n");
  expect(reasons).not.toContain(ATTACKER_PATH);
  expect(reasons).not.toContain(FAKE_CREDENTIAL);
  expect(reasons).toMatch(/eslint/);
  expect(gate.status).toBe("incomplete");
});

test("F-002: a source whose validate() reports an unsafe error never echoes attacker-supplied text", async () => {
  const { info, gate } = await runThrowingSource({
    id: "eslint",
    detect: async () => "available",
    import: async () => ({
      source: "eslint",
      command: null,
      toolVersion: null,
      exitCode: 0,
      rawPath: "",
      content: "[]",
      imported: true,
    }),
    run: async () => unreachable(),
    parse: () => [],
    validate: () => ({
      valid: false,
      error: `synthetic validation failure ${ATTACKER_PATH} ${FAKE_CREDENTIAL}`,
    }),
  });

  expect(info.status).toBe("configured-but-failed");
  expect(info.parse).toBe("failed");
  expect(info.error).toBeDefined();
  expect(info.error).not.toContain(ATTACKER_PATH);
  expect(info.error).not.toContain(FAKE_CREDENTIAL);
  // Not in the closed vocabulary any shipped adapter can return, so it falls
  // back to the same constant an unrecognized/absent validate() error uses.
  expect(info.error).toBe("source output format was not recognized");

  const reasons = gate.reasons.join("\n");
  expect(reasons).not.toContain(ATTACKER_PATH);
  expect(reasons).not.toContain(FAKE_CREDENTIAL);
  expect(reasons).toMatch(/eslint/);
  expect(gate.status).toBe("incomplete");
});

test("F-002: validate()'s own closed-vocabulary errors still pass through unchanged", async () => {
  const { info } = await runThrowingSource({
    id: "eslint",
    detect: async () => "available",
    import: async () => ({
      source: "eslint",
      command: null,
      toolVersion: null,
      exitCode: 0,
      rawPath: "",
      content: "not json",
      imported: true,
    }),
    run: async () => unreachable(),
    parse: () => [],
    validate: () => ({ valid: false, error: "ESLint JSON parse failed" }),
  });

  // A known-safe, closed-vocabulary string from a shipped adapter is
  // diagnostic value, not a leak -- it must survive unchanged.
  expect(info.error).toBe("ESLint JSON parse failed");
});

test("F-005: a source whose error carries a recognizable errno keeps that category, safely", async () => {
  const { info, gate } = await runThrowingSource({
    id: "eslint",
    detect: async () => {
      throw leakyError("detection");
    },
    import: async () => unreachable(),
    run: async () => unreachable(),
    parse: () => [],
  });

  // The errno code IS safe diagnostic value and is deliberately kept -- only
  // the path and the credential are required to be absent (asserted above).
  expect(info.error).toContain("ENOENT");
  expect(gate.reasons.join("\n")).toContain("ENOENT");
});

// T70 F-004: the F-005/F-002 regressions above stop at `runAdapter` + an
// in-memory `computeGate` call (`runThrowingSource`) and never reach
// `writeOutputs` or the persisted artifact -- the surface F-005's own
// problem statement named (the committable `latest.{json,md}` and, through
// the flow completion gate, `flow.json`'s durable history). This closes
// that gap by driving the same REAL functions one hop further: `runAdapter`
// (unchanged) -> `computeGate` (unchanged) -> the REAL `writeOutputs`
// (exported from `run.ts`, test-only, same discipline as `runAdapter`) ->
// the artifact read back from disk -> the REAL
// `createCodeHealthService().gate({cwd})`, the exact value
// `src/flow/service.ts`'s completion gate folds into `flow.json`.
//
// Deliberately does NOT mock `./sources`/`FINDING_ADAPTERS` to go through
// the full `runHealth()` orchestration. That was tried first here too:
// `mock.module("./sources", () => ({...real, FINDING_ADAPTERS: [adapter]}))`,
// restored synchronously in the same test's `finally` -- the exact pattern
// `src/flow/service.test.ts:548-565` uses successfully for the analogous
// `./store` leak regression. Run together with `provenance.test.ts` (T69's
// own reproduction case), in both file orders, it reproduced the identical
// corruption T69-implementation.md already documented: an unrelated
// `provenance.test.ts` assertion ("strict health runs an available compiler
// instead of treating missing import format as missing source") saw
// `source?.status` as `undefined` instead of `"available"`, because the
// single-adapter mock leaked across the file boundary despite the
// same-test restore. `./sources` is imported by nearly every `runHealth()`
// caller in this process (unlike `./store`/`./review-gate`, which only
// `src/flow/*` touches), and this is the second, independent confirmation
// of that hazard -- recorded in `run.ts`'s `writeOutputs` export comment
// and in T75-implementation.md rather than silently worked around a second
// time. Calling `runAdapter` + `computeGate` + `writeOutputs` directly
// exercises every hop F-004 named with zero shared-module risk.
test("F-004/F-005: a detect() throw never reaches the persisted artifact or the service-read gate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-health-artifact-"));
  try {
    const ctx = await healthContext(root);
    const { info } = await runAdapter(
      { id: "eslint", detect: async () => { throw leakyError("detection"); }, import: async () => unreachable(), run: async () => unreachable(), parse: () => [] },
      ctx,
      { mode: "auto", required: true },
      "test-stamp",
    );
    const gate = compute([info]);
    const report: HealthReport = {
      schemaVersion: DEFAULT_HEALTH_CONFIG.schemaVersion,
      generatedAt: new Date().toISOString(),
      scope: "project",
      strict: false,
      gitRef: null,
      gate,
      sources: [info],
      metrics: [],
      findings: [],
    };
    await writeOutputs(root, report, DEFAULT_HEALTH_CONFIG, "test-stamp");

    const jsonBytes = await readFile(artifactPath(root, "latest.json"), "utf8");
    const mdBytes = await readFile(artifactPath(root, "latest.md"), "utf8");
    const serviceGate = await createCodeHealthService().gate({ cwd: root });

    expect(info.error).toBeDefined();
    expect(info.error).not.toContain(ATTACKER_PATH);
    expect(info.error).not.toContain(FAKE_CREDENTIAL);
    expect(info.error).toMatch(/detection failed/);
    expect(gate.status).toBe("incomplete");

    for (const bytes of [jsonBytes, mdBytes]) {
      expect(bytes).not.toContain(ATTACKER_PATH);
      expect(bytes).not.toContain(FAKE_CREDENTIAL);
    }
    const serviceReasons = serviceGate.reasons.join("\n");
    expect(serviceReasons).not.toContain(ATTACKER_PATH);
    expect(serviceReasons).not.toContain(FAKE_CREDENTIAL);
    expect(serviceReasons).toMatch(/eslint/);
    expect(serviceGate.status).toBe("incomplete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("F-004/F-002: a validate() error never reaches the persisted artifact or the service-read gate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-health-artifact-"));
  try {
    const ctx = await healthContext(root);
    const { info } = await runAdapter(
      {
        id: "eslint",
        detect: async () => "available",
        import: async () => ({
          source: "eslint",
          command: null,
          toolVersion: null,
          exitCode: 0,
          rawPath: "",
          content: "[]",
          imported: true,
        }),
        run: async () => unreachable(),
        parse: () => [],
        validate: () => ({
          valid: false,
          error: `synthetic validation failure ${ATTACKER_PATH} ${FAKE_CREDENTIAL}`,
        }),
      },
      ctx,
      { mode: "auto", required: true },
      "test-stamp",
    );
    const gate = compute([info]);
    const report: HealthReport = {
      schemaVersion: DEFAULT_HEALTH_CONFIG.schemaVersion,
      generatedAt: new Date().toISOString(),
      scope: "project",
      strict: false,
      gitRef: null,
      gate,
      sources: [info],
      metrics: [],
      findings: [],
    };
    await writeOutputs(root, report, DEFAULT_HEALTH_CONFIG, "test-stamp");

    const jsonBytes = await readFile(artifactPath(root, "latest.json"), "utf8");
    const mdBytes = await readFile(artifactPath(root, "latest.md"), "utf8");
    const serviceGate = await createCodeHealthService().gate({ cwd: root });

    expect(info.error).toBe("source output format was not recognized");
    expect(gate.status).toBe("incomplete");

    for (const bytes of [jsonBytes, mdBytes]) {
      expect(bytes).not.toContain(ATTACKER_PATH);
      expect(bytes).not.toContain(FAKE_CREDENTIAL);
    }
    const serviceReasons = serviceGate.reasons.join("\n");
    expect(serviceReasons).not.toContain(ATTACKER_PATH);
    expect(serviceReasons).not.toContain(FAKE_CREDENTIAL);
    expect(serviceReasons).toMatch(/eslint/);
    expect(serviceGate.status).toBe("incomplete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
