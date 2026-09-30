import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { runHealth } from "./run";

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
    const second = await run(p.root);
    expect(second.project?.regression_score).toBe(0);
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

test("a regression in an already-measured source still fails, and does not get re-baselined away", async () => {
  const p = await project();
  try {
    await run(p.root);
    const before = await baselineFile(p.root);

    await p.nameOxlint();
    await p.setOxlint(1);
    await p.setEslint(3); // eslint was measured by the baseline: this is a real drop
    const { gate, project: metrics } = await run(p.root);
    expect(metrics?.regression_score).toBeGreaterThanOrEqual(10);
    expect(gate.status).toBe("fail");
    // Adopting this run would hide the eslint regression.
    expect(await baselineFile(p.root)).toEqual(before);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});
