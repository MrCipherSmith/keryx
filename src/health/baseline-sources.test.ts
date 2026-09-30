import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { LEGACY_BASELINE_SOURCES } from "./baseline";
import { DEFAULT_HEALTH_CONFIG } from "./config";
import { computeMetrics } from "./scopes";
import { runHealth } from "./run";
import { createCodeHealthService } from "./service";

// A baseline stores scores, and a score is only comparable against findings
// from the sources it measured. When a source starts being measured (oxlint,
// new in flow 352, on a project that already named it), its findings are new
// MEASUREMENT of unchanged code -- they must not read as a health regression
// and fail the gate (review round 2, R2-01).

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

async function project(): Promise<{ root: string; setEslint: (n: number) => Promise<void>; setOxlint: (n: number) => Promise<void>; nameOxlint: () => Promise<void> }> {
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
  await writeFile(
    path.join(root, ".metaproject", "health.config.json"),
    JSON.stringify({ sources: { typescript: off, tests: off, coverage: off, dependencyAudit: off, sonarqube: off, complexity: off } }),
  );
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
  const nameOxlint = async () =>
    writeFile(path.join(root, "package.json"), JSON.stringify({ name: "p", devDependencies: { eslint: "^9", oxlint: "^1" } }));
  return { root, setEslint, setOxlint, nameOxlint };
}

async function baselineFile(root: string): Promise<{ sources?: string[]; scopes: Record<string, { health_score: number }> }> {
  return JSON.parse(await readFile(path.join(root, ".metaproject", "health", "baselines", "scores.json"), "utf8"));
}

async function run(root: string) {
  const { report } = await runHealth({ cwd: root });
  return { gate: report.gate, project: report.metrics.find((m) => m.key === "project") };
}

test("a coverage report seen for the first time is new measurement: its penalty is not a regression", async () => {
  // Coverage contributes a penalty, not findings, so excluding a new source's
  // findings alone would still read low coverage as a drop.
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

test("upgrade: a baseline written before sources were recorded does not turn oxlint's first findings into a FAIL", async () => {
  const p = await project();
  try {
    // What an older keryx left behind: a perfect score and no `sources` field.
    await mkdir(path.join(p.root, ".metaproject", "health", "baselines"), { recursive: true });
    await writeFile(
      path.join(p.root, ".metaproject", "health", "baselines", "scores.json"),
      JSON.stringify({ generatedAt: "2026-01-01T00:00:00.000Z", scopes: { project: { health_score: 100, risk_score: 0 } } }),
    );
    await p.nameOxlint();
    await p.setOxlint(3);

    const { gate, project: metrics } = await run(p.root);
    expect(metrics?.health_score).toBeLessThan(100); // the findings are reported...
    expect(metrics?.regression_score).toBe(0); // ...but are not a regression
    expect(gate.status).not.toBe("fail");
    // And the baseline now includes oxlint, so its own regressions count from here on.
    expect((await baselineFile(p.root)).sources).toContain("oxlint");
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("a source that starts being measured is not a regression; once adopted, its own regressions are", async () => {
  const p = await project();
  try {
    const first = await run(p.root); // no oxlint intent yet: baseline measures eslint only
    expect(first.gate.status).toBe("pass");
    expect((await baselineFile(p.root)).sources).toEqual(["eslint"]);

    await p.nameOxlint();
    await p.setOxlint(3);

    // A module-scoped run does not hold every scope: it must not settle the source set.
    await runHealth({ cwd: p.root, scope: { kind: "module", name: "src" } });
    expect((await baselineFile(p.root)).sources).toEqual(["eslint"]);

    const second = await run(p.root);
    expect(second.project?.regression_score).toBe(0);
    expect(second.project?.trend).not.toBe("regressed");
    expect(second.gate.status).not.toBe("fail");
    expect((await baselineFile(p.root)).sources).toEqual(["eslint", "oxlint"]);

    await p.setOxlint(6); // oxlint is part of the baseline now: three more errors are a real drop
    const third = await run(p.root);
    expect(third.project?.regression_score).toBeGreaterThan(0);
    expect(third.gate.status).toBe("fail");
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("a regression in an already-measured source still fails, and the new source's fold does not absorb it", async () => {
  const p = await project();
  try {
    await run(p.root);

    await p.nameOxlint();
    await p.setOxlint(1);
    await p.setEslint(3); // eslint was measured by the baseline: this is a real drop
    const first = await run(p.root);
    expect(first.project?.regression_score).toBe(30);
    expect(first.gate.status).toBe("fail");

    // oxlint's own effect (one P1 = 10 points) was folded in; eslint's was not,
    // so the same tree still reads as the same eslint regression.
    expect((await baselineFile(p.root)).scopes.project?.health_score).toBe(90);
    const again = await run(p.root);
    expect(again.project?.regression_score).toBe(30);
    expect(again.gate.status).toBe("fail");
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("a new source is folded on its first run even when something else regressed, so its growth is never unbounded", async () => {
  const p = await project();
  try {
    await run(p.root);
    await p.nameOxlint();
    await p.setOxlint(1);
    await p.setEslint(1);
    expect((await run(p.root)).gate.status).toBe("fail"); // the eslint drop

    await p.setEslint(0);
    await p.setOxlint(8); // oxlint grows by 7 errors after its first sighting
    const { gate, project: metrics } = await run(p.root);
    expect(metrics?.regression_score).toBe(70);
    expect(gate.status).toBe("fail");
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("upgrade: a source the legacy baseline measured, missing on the run oxlint appears, is not new when it returns", async () => {
  const p = await project();
  try {
    await mkdir(path.join(p.root, ".metaproject", "health", "baselines"), { recursive: true });
    await writeFile(
      path.join(p.root, ".metaproject", "health", "baselines", "scores.json"),
      JSON.stringify({ generatedAt: "2026-01-01T00:00:00.000Z", scopes: { project: { health_score: 100, risk_score: 0 } } }),
    );
    await p.nameOxlint();
    await rm(path.join(p.root, "node_modules", ".bin", "eslint")); // eslint missing this run
    await run(p.root);
    expect((await baselineFile(p.root)).sources).toContain("eslint");

    await writeFile(path.join(p.root, "node_modules", ".bin", "eslint"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.0; exit 0; fi\ncat '${path.join(p.root, "eslint.out")}'\nexit 0\n`);
    await chmod(path.join(p.root, "node_modules", ".bin", "eslint"), 0o755);
    await p.setEslint(5);
    const { gate, project: metrics } = await run(p.root);
    expect(metrics?.regression_score).toBe(50);
    expect(gate.status).toBe("fail");
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("upgrade: a legacy baseline gets its source set written on the first whole-project run", async () => {
  const p = await project();
  try {
    await mkdir(path.join(p.root, ".metaproject", "health", "baselines"), { recursive: true });
    await writeFile(
      path.join(p.root, ".metaproject", "health", "baselines", "scores.json"),
      JSON.stringify({ generatedAt: "2026-01-01T00:00:00.000Z", scopes: { project: { health_score: 100, risk_score: 0 } } }),
    );
    await run(p.root); // no oxlint, nothing new
    const file = await baselineFile(p.root);
    expect(file.sources).toEqual([...LEGACY_BASELINE_SOURCES].sort());
    expect(file.sources).not.toContain("oxlint");
    expect(file.scopes.project?.health_score).toBe(100);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test("re-baselining from a --sources run is refused; a `changed` re-baseline records its sources", async () => {
  const p = await project();
  try {
    await run(p.root);
    await p.nameOxlint();
    // The filtered run measured oxlint (it was not filtered out), so it folds oxlint in.
    await runHealth({ cwd: p.root, sources: ["oxlint"] });
    const beforeRefusal = await baselineFile(p.root);
    expect(beforeRefusal.sources).toEqual(["eslint", "oxlint"]);
    const service = createCodeHealthService();
    const refused = await service.updateBaseline({ cwd: p.root });
    expect(refused.refused).toContain("--sources");
    expect(refused.updated).toEqual([]);
    expect(await baselineFile(p.root)).toEqual(beforeRefusal);

    // A `changed` re-baseline rewrites every scope, so it records what the report measured.
    await p.setOxlint(0);
    await runHealth({ cwd: p.root });
    const withoutOxlintConfig = path.join(p.root, "package.json");
    await writeFile(withoutOxlintConfig, JSON.stringify({ name: "p", devDependencies: { eslint: "^9" } }));
    await runHealth({ cwd: p.root }); // oxlint no longer measured
    await service.updateBaseline({ cwd: p.root, scope: { kind: "changed", since: null } });
    expect((await baselineFile(p.root)).sources).toEqual(["eslint"]);

    // A module re-baseline rewrites one scope, so the recorded set is kept as it was.
    await p.nameOxlint();
    await runHealth({ cwd: p.root });
    const recorded = (await baselineFile(p.root)).sources;
    await service.updateBaseline({ cwd: p.root, scope: { kind: "module", name: "src" } });
    expect((await baselineFile(p.root)).sources).toEqual(recorded);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});
