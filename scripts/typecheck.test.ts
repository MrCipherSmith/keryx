import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SCRIPTS_CONFIG = path.join(REPO_ROOT, "tsconfig.scripts.json");
const TSC = path.join(REPO_ROOT, "node_modules", ".bin", "tsc");

async function runScriptsTypecheck(project: string): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn([TSC, "--project", project, "--noEmit"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

test("the scripts TypeScript target covers benchmark and stress entrypoints and is currently clean", async () => {
  const text = await readFile(SCRIPTS_CONFIG, "utf8");
  const parsedJson = ts.parseConfigFileTextToJson(SCRIPTS_CONFIG, text);
  expect(parsedJson.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(parsedJson.config, ts.sys, REPO_ROOT);
  const included = new Set(parsed.fileNames.map((file) => path.resolve(file)));

  expect(included.has(path.join(REPO_ROOT, "scripts/benchmark/run-ablation.ts"))).toBe(true);
  expect(included.has(path.join(REPO_ROOT, "scripts/benchmark/run-containment.ts"))).toBe(true);
  expect(included.has(path.join(REPO_ROOT, "scripts/stress/keryx-shell-stress.ts"))).toBe(true);

  const result = await runScriptsTypecheck(SCRIPTS_CONFIG);
  expect(result.exitCode, result.output).toBe(0);
});

test("the scripts TypeScript target fails on an injected strict type error", async () => {
  // The probe is meaningful only when it extends the real scripts target.
  // Without this guard, TypeScript can report both a missing base config and
  // the injected error, producing a false-positive RED-to-GREEN signal.
  await readFile(SCRIPTS_CONFIG, "utf8");
  // Keep the temporary extending config under the repository so TypeScript's
  // normal upward package lookup can resolve this project's `bun-types`.
  const fixture = await mkdtemp(path.join(REPO_ROOT, ".tmp-scripts-typecheck-"));
  try {
    const brokenFile = path.join(fixture, "injected-type-error.ts");
    const fixtureConfig = path.join(fixture, "tsconfig.json");
    await writeFile(brokenFile, 'const phaseZeroMustBeNumber: number = "M10";\n', "utf8");
    await writeFile(
      fixtureConfig,
      `${JSON.stringify({ extends: SCRIPTS_CONFIG, files: [brokenFile] }, null, 2)}\n`,
      "utf8",
    );

    const result = await runScriptsTypecheck(fixtureConfig);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("injected-type-error.ts");
    expect(result.output).toContain("TS2322");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
