import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { LEGACY_BASELINE_SOURCES, measuredSources, scoredSourcesOfReport } from "./baseline";
import { DEFAULT_HEALTH_CONFIG } from "./config";
import { computeMetrics } from "./scopes";
import { runHealth } from "./run";
import { createCodeHealthService } from "./service";

// A baseline stores scores, and a score is only comparable against findings
// from the sources it measured. When a source starts being measured (oxlint,
// new in flow 352, on a project that already named it), its findings are new
// MEASUREMENT of unchanged code: they are left out of the regression
// comparison, the gate says so, and they join the comparison when an operator
// runs `keryx health baseline update`. `health run` never rewrites an
// existing baseline.

type Diagnostic = { message: string; code: string; severity: string; filename: string; labels: Array<{ span: { line: number } }> };

function oxlintErrors(count: number): Diagnostic[] {
  return Array.from({ length: count }, (_, i) => ({
    message: `m${i}`, code: "eslint(no-unused-vars)", severity: "error", filename: "src/a.ts", labels: [{ span: { line: i + 1 } }],
  }));
}

function eslintErrors(count: number): unknown[] {
  return [{ filePath: "src/a.ts", messages: Array.from({ length: count }, (_, i) => ({ ruleId: "no-debugger", severity: 2, message: `e${i}`, line: i + 1 })) }];
}

// Each fake tool prints whatever its `.out` file holds, so a test changes the
// tree's findings between runs without rewriting the tool.
function tool(outFile: string, exitCode: number): string {
  return `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.0; exit 0; fi\ncat '${outFile}'\nexit ${exitCode}\n`;
}

async function project(): Promise<{
  root: string;
  setEslint: (n: number) => Promise<void>;
  setOxlint: (n: number) => Promise<void>;
  nameOxlint: () => Promise<void>;
  unnameOxlint: () => Promise<void>;
  coverageMode: (mode: string) => Promise<void>;
  writeCoverage: (summary: unknown) => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-baseline-sources-"));
  const bin = path.join(root, "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  // 2000 LOC: one P1 finding is a 10-point drop, the default failOnRegressionDrop.
  await writeFile(path.join(root, "src", "a.ts"), Array.from({ length: 2000 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
  await writeFile(path.join(root, "eslint.config.js"), "export default [];\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "p", devDependencies: { eslint: "^9" } }));
  const off = { mode: "disabled", required: false };
  const config = path.join(root, ".metaproject", "health.config.json");
  const sources: Record<string, unknown> = { typescript: off, tests: off, coverage: off, dependencyAudit: off, sonarqube: off, complexity: off };
  await writeFile(config, JSON.stringify({ sources }));
  const eslintOut = path.join(root, "eslint.out");
  const oxlintOut = path.join(root, "oxlint.out");
  await writeFile(path.join(bin, "eslint"), tool(eslintOut, 0));
  await writeFile(path.join(bin, "oxlint"), tool(oxlintOut, 0));
  await chmod(path.join(bin, "eslint"), 0o755);
  await chmod(path.join(bin, "oxlint"), 0o755);
  const setEslint = async (n: number) => writeFile(eslintOut, JSON.stringify(n === 0 ? [] : eslintErrors(n)));
  const setOxlint = async (n: number) => writeFile(oxlintOut, JSON.stringify({ diagnostics: oxlintErrors(n) }));
  await setEslint(0);
  await setOxlint(0);
  return {
    root,
    setEslint,
    setOxlint,
    nameOxlint: async () =>
      writeFile(path.join(root, "package.json"), JSON.stringify({ name: "p", devDependencies: { eslint: "^9", oxlint: "^1" } })),
    unnameOxlint: async () =>
      writeFile(path.join(root, "package.json"), JSON.stringify({ name: "p", devDependencies: { eslint: "^9" } })),
    coverageMode: async (mode: string) => {
      sources.coverage = { mode, required: false };
      await writeFile(config, JSON.stringify({ sources }));
    },
    writeCoverage: async (summary: unknown) => {
      await mkdir(path.join(root, "coverage"), { recursive: true });
      await writeFile(path.join(root, "coverage", "coverage-summary.json"), JSON.stringify(summary));
    },
  };
}

function scoresPath(root: string): string {
  return path.join(root, ".metaproject", "health", "baselines", "scores.json");
}

async function baselineFile(root: string): Promise<{ sources?: string[]; scopes: Record<string, { health_score: number }> }> {
  return JSON.parse(await readFile(scoresPath(root), "utf8"));
}

async function writeLegacyBaseline(root: string): Promise<void> {
  // What an older keryx left behind: a perfect score and no `sources` field.
  await mkdir(path.dirname(scoresPath(root)), { recursive: true });
  await writeFile(
    scoresPath(root),
    JSON.stringify({ generatedAt: "2026-01-01T00:00:00.000Z", scopes: { project: { health_score: 100, risk_score: 0 } } }),
  );
}

async function run(root: string) {
  const { report } = await runHealth({ cwd: root });
  return { report, gate: report.gate, project: report.metrics.find((m) => m.key === "project") };
}

const NEW_SOURCE_NOTE = /NOTE: not in the baseline yet, so not compared for regression: (.*); run `keryx health baseline update`/;

function noteFor(reasons: string[]): string | undefined {
  for (const reason of reasons) {
    const match = NEW_SOURCE_NOTE.exec(reason);
    if (match) return match[1];
  }
  return undefined;
}

// --- a new source is excluded, named, and never folded by a run -----------

test("a source that starts being measured is not a regression, is named, and joins the comparison on baseline update", async () => {
  const p = await project();
  try {
    const first = await run(p.root); // no oxlint intent yet
    expect(first.gate.status).toBe("pass");
    expect((await baselineFile(p.root)).sources).toEqual(["eslint"]);
    expect(noteFor(first.gate.reasons)).toBeUndefined();

    await p.nameOxlint();
    await p.setOxlint(3);
    const before = await readFile(scoresPath(p.root), "utf8");
    const second = await run(p.root);
    expect(second.project?.health_score).toBe(70); // the findings are reported...
    expect(second.project?.regression_score).toBe(0); // ...but are not a regression
    expect(second.project?.trend).not.toBe("regressed");
    expect(second.gate.status).toBe("pass");
    expect(noteFor(second.gate.reasons)).toBe("oxlint");
    // A run never rewrites an existing baseline.
    expect(await readFile(scoresPath(p.root), "utf8")).toBe(before);

    const update = await createCodeHealthService().updateBaseline({ cwd: p.root });
    expect(update.refused).toBeUndefined();
    expect((await baselineFile(p.root)).sources).toEqual(["eslint", "oxlint"]);

    const third = await run(p.root);
    expect(third.project?.regression_score).toBe(0);
    expect(noteFor(third.gate.reasons)).toBeUndefined();

    await p.setOxlint(6); // oxlint is in the baseline now: three more errors are a real drop
    const fourth = await run(p.root);
    expect(fourth.project?.regression_score).toBe(30);
    expect(fourth.gate.status).toBe("fail");
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("the new source is left out in every scope, and the note repeats until the baseline is updated", async () => {
  const p = await project();
  try {
    await run(p.root); // baseline: project + module:src
    await p.nameOxlint();
    await p.setOxlint(3);
    for (let i = 0; i < 2; i += 1) {
      const { report } = await run(p.root);
      for (const metric of report.metrics) {
        expect(metric.regression_score).toBeLessThanOrEqual(0);
        expect(metric.trend).not.toBe("regressed");
      }
      expect(noteFor(report.gate.reasons)).toBe("oxlint");
    }
    // No scope was added or changed by those runs.
    expect(Object.keys((await baselineFile(p.root)).scopes).sort()).toEqual(["module:src", "project"]);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("a regression in an already-measured source still fails while a new source appears", async () => {
  const p = await project();
  try {
    await run(p.root);
    await p.nameOxlint();
    await p.setOxlint(1);
    await p.setEslint(3); // eslint was measured by the baseline: this is a real drop
    for (let i = 0; i < 2; i += 1) {
      const { gate, project: metrics } = await run(p.root);
      expect(metrics?.regression_score).toBe(30);
      expect(gate.status).toBe("fail");
    }
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

// --- legacy baselines (written before `sources` existed) ------------------

test("upgrade: a legacy baseline reads oxlint as new, names it, and is not rewritten", async () => {
  const p = await project();
  try {
    await writeLegacyBaseline(p.root);
    await p.nameOxlint();
    await p.setOxlint(3);
    const before = await readFile(scoresPath(p.root), "utf8");

    const { gate, project: metrics } = await run(p.root);
    expect(metrics?.health_score).toBeLessThan(100);
    expect(metrics?.regression_score).toBe(0);
    expect(gate.status).not.toBe("fail");
    expect(noteFor(gate.reasons)).toBe("oxlint");
    expect(await readFile(scoresPath(p.root), "utf8")).toBe(before);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("upgrade: a source the legacy baseline measured is never new, even after it went missing", async () => {
  const p = await project();
  try {
    await writeLegacyBaseline(p.root);
    await p.nameOxlint();
    await rm(path.join(p.root, "node_modules", ".bin", "eslint")); // eslint missing this run
    await run(p.root);

    await writeFile(path.join(p.root, "node_modules", ".bin", "eslint"), tool(path.join(p.root, "eslint.out"), 0));
    await chmod(path.join(p.root, "node_modules", ".bin", "eslint"), 0o755);
    await p.setEslint(5);
    const { gate, project: metrics } = await run(p.root);
    expect(metrics?.regression_score).toBe(50);
    expect(gate.status).toBe("fail");
    expect(noteFor(gate.reasons)).toBe("oxlint");
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("the legacy source set is pinned: it is a fact about history, not a list to extend", () => {
  // Adding a post-352 source here would make legacy baselines treat it as
  // already measured, so its first findings would read as a regression.
  expect([...LEGACY_BASELINE_SOURCES]).toEqual(["complexity", "coverage", "dependencyAudit", "eslint", "sonarqube", "tests", "typescript"]);
});

// --- coverage: counted as measured whenever its data shaped the scores -----

test("a coverage report applied while coverage was disabled is recorded, so enabling coverage later hides no drift", async () => {
  const p = await project(); // coverage disabled
  try {
    await p.writeCoverage({ total: { lines: { pct: 50 } } });
    await run(p.root);
    expect((await baselineFile(p.root)).sources).toContain("coverage");

    await p.coverageMode("import");
    expect((await run(p.root)).project?.regression_score).toBe(0);

    await p.setEslint(1); // one P1: a real 10-point drop
    const { gate, project: metrics } = await run(p.root);
    expect(metrics?.regression_score).toBe(10);
    expect(gate.status).toBe("fail");
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("`health baseline update` records applied coverage too, so enabling coverage later hides no drift", async () => {
  const p = await project(); // coverage disabled
  try {
    await p.writeCoverage({ total: { lines: { pct: 50 } } });
    await run(p.root);
    const update = await createCodeHealthService().updateBaseline({ cwd: p.root });
    expect(update.refused).toBeUndefined();
    expect((await baselineFile(p.root)).sources).toContain("coverage");

    await p.coverageMode("import");
    expect((await run(p.root)).project?.regression_score).toBe(0);
    await p.setEslint(1);
    const { gate, project: metrics } = await run(p.root);
    expect(metrics?.regression_score).toBe(10);
    expect(gate.status).toBe("fail");
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("a coverage report that appears on a baselined project is new measurement until the baseline is updated", async () => {
  const p = await project();
  try {
    await p.coverageMode("import");
    await run(p.root); // baseline without any coverage report
    await p.writeCoverage({ total: { lines: { pct: 50 } } });
    const first = await run(p.root);
    expect(first.project?.health_score).toBeLessThan(100);
    expect(first.project?.regression_score).toBe(0);
    expect(noteFor(first.gate.reasons)).toBe("coverage");

    await createCodeHealthService().updateBaseline({ cwd: p.root });
    await p.setEslint(1);
    const { gate, project: metrics } = await run(p.root);
    expect(metrics?.regression_score).toBe(10);
    expect(gate.status).toBe("fail");
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("a coverage file with no line data is not recorded, so a later real report is new, not a regression", async () => {
  const p = await project();
  try {
    await p.coverageMode("import");
    // What `getCoverage` reads as `available` but with no percentages: nothing applied.
    await p.writeCoverage({ "src/a.ts": { statements: {} } });
    await run(p.root);
    expect((await baselineFile(p.root)).sources).not.toContain("coverage");

    await p.writeCoverage({ total: { lines: { pct: 50 } } });
    const { gate, project: metrics } = await run(p.root);
    expect(metrics?.regression_score).toBe(0);
    expect(gate.status).not.toBe("fail");
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("per-file coverage with no `total` still counts as applied coverage", async () => {
  const p = await project(); // coverage disabled
  try {
    await p.writeCoverage({ "src/a.ts": { lines: { pct: 50 } } });
    await run(p.root);
    expect((await baselineFile(p.root)).sources).toContain("coverage");
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("a coverage report seen for the first time is new measurement: its penalty is not a regression", async () => {
  const file = "src/a.ts";
  const metrics = await computeMetrics({
    cwd: "/nonexistent-keryx-health-fixture",
    config: DEFAULT_HEALTH_CONFIG,
    findings: [],
    sourceFiles: [file],
    coverage: { status: "available", total: 40, byFile: new Map([[file, 40]]) },
    churn: new Map(),
    baseline: new Map([["project", { health_score: 100, risk_score: 0 }]]),
    newSources: new Set(["coverage"]),
    sourceAnalysis: new Map([[file, { file, loc: 2000, complexity: [] }]]),
  });
  const project = metrics.find((m) => m.key === "project");
  expect(project?.health_score).toBeLessThan(100);
  expect(project?.regression_score).toBe(0);
});

test("a coverage drop still counts when a DIFFERENT source is the new one", async () => {
  const file = "src/a.ts";
  const metrics = await computeMetrics({
    cwd: "/nonexistent-keryx-health-fixture",
    config: DEFAULT_HEALTH_CONFIG,
    findings: [],
    sourceFiles: [file],
    coverage: { status: "available", total: 40, byFile: new Map([[file, 40]]) },
    churn: new Map(),
    baseline: new Map([["project", { health_score: 100, risk_score: 0 }]]),
    newSources: new Set(["oxlint"]),
    sourceAnalysis: new Map([[file, { file, loc: 2000, complexity: [] }]]),
  });
  expect(metrics.find((m) => m.key === "project")?.regression_score).toBeGreaterThan(0);
});

// --- `health baseline update` ---------------------------------------------

test("re-baselining from a --sources run is refused; `changed` records its sources; module keeps the set", async () => {
  const p = await project();
  try {
    await run(p.root);
    await p.nameOxlint();
    await runHealth({ cwd: p.root, sources: ["oxlint"] });
    const before = await readFile(scoresPath(p.root), "utf8");
    const service = createCodeHealthService();
    const refused = await service.updateBaseline({ cwd: p.root });
    expect(refused.refused).toContain("--sources");
    expect(refused.updated).toEqual([]);
    expect(await readFile(scoresPath(p.root), "utf8")).toBe(before);

    // A `changed` re-baseline rewrites every scope, so it records what the report measured.
    await runHealth({ cwd: p.root });
    await service.updateBaseline({ cwd: p.root, scope: { kind: "changed", since: null } });
    expect((await baselineFile(p.root)).sources).toEqual(["eslint", "oxlint"]);

    // A module re-baseline rewrites one scope, so the recorded set is kept --
    // even when the report measured fewer sources than the file records.
    await p.unnameOxlint();
    await runHealth({ cwd: p.root, scope: { kind: "module", name: "src" } });
    const moduleUpdate = await service.updateBaseline({ cwd: p.root, scope: { kind: "module", name: "src" } });
    expect(moduleUpdate.refused).toBeUndefined();
    expect((await baselineFile(p.root)).sources).toEqual(["eslint", "oxlint"]);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("a module re-baseline is refused while the report measured a source the baseline has not recorded", async () => {
  const p = await project();
  try {
    await run(p.root); // baseline records [eslint]
    await p.nameOxlint();
    await p.setOxlint(3);
    await runHealth({ cwd: p.root, scope: { kind: "module", name: "src" } });
    const before = await readFile(scoresPath(p.root), "utf8");
    const result = await createCodeHealthService().updateBaseline({ cwd: p.root, scope: { kind: "module", name: "src" } });
    expect(result.refused).toContain("oxlint");
    expect(await readFile(scoresPath(p.root), "utf8")).toBe(before);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("a module re-baseline is refused while applied coverage is unrecorded, and the report persists its scored set", async () => {
  const p = await project(); // coverage disabled
  try {
    await run(p.root); // baseline [eslint], no coverage report yet
    await p.writeCoverage({ total: { lines: { pct: 50 } } });
    const { report } = await runHealth({ cwd: p.root, scope: { kind: "module", name: "src" } });
    expect(report.scoredSources).toEqual(["coverage", "eslint"]);

    const before = await readFile(scoresPath(p.root), "utf8");
    const result = await createCodeHealthService().updateBaseline({ cwd: p.root, scope: { kind: "module", name: "src" } });
    expect(result.refused).toContain("coverage");
    expect(await readFile(scoresPath(p.root), "utf8")).toBe(before);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

// --- damaged inputs -------------------------------------------------------

test("a damaged scores.json is re-taken from the current run, not a crash", async () => {
  const p = await project();
  try {
    await mkdir(path.dirname(scoresPath(p.root)), { recursive: true });
    await writeFile(scoresPath(p.root), "{");
    const { gate } = await run(p.root);
    expect(gate.status).toBe("pass");
    const file = await baselineFile(p.root);
    expect(file.scopes.project?.health_score).toBe(100);
    expect(file.sources).toEqual(["eslint"]);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("measuredSources and updateBaseline tolerate non-object entries in a damaged report", async () => {
  const eslint = { source: "eslint", status: "available", execution: "completed", parse: "parsed" };
  expect(measuredSources([null, 1, "x", eslint])).toEqual(["eslint"]);

  const p = await project();
  try {
    await run(p.root);
    const latest = path.join(p.root, ".metaproject", "data", "health", "artifacts", "latest.json");
    const report = JSON.parse(await readFile(latest, "utf8")) as { sources: unknown[] };
    report.sources.push(null);
    await writeFile(latest, JSON.stringify(report));
    const result = await createCodeHealthService().updateBaseline({ cwd: p.root });
    expect(result.refused).toBeUndefined();
    expect(result.updated).toContain("project");
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("a stored report without scoredSources falls back to the same rule", () => {
  const eslint = { source: "eslint", status: "available", execution: "completed", parse: "parsed" };
  expect(scoredSourcesOfReport({ sources: [eslint], metrics: [{ coverage: 40 }] })).toEqual(["coverage", "eslint"]);
  expect(scoredSourcesOfReport({ sources: [eslint], metrics: [{ coverage: null }, null] })).toEqual(["eslint"]);
  expect(scoredSourcesOfReport({ sources: [], metrics: [], scoredSources: ["oxlint", "eslint"] })).toEqual(["eslint", "oxlint"]);
});
