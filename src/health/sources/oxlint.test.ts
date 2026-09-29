import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { oxlintAdapter } from "./oxlint";
import { eslintAdapter } from "./eslint";
import { typescriptAdapter } from "./typescript";
import { runAdapter } from "../run";
import { DEFAULT_HEALTH_CONFIG } from "../config";
import type { HealthContext, RawSourceResult } from "../types";

// AC1/AC2/AC6 fixtures. A fixture root is a temp tree holding only what the
// adapter under test looks for -- a config file and/or a fake
// `node_modules/.bin/<tool>` -- so "which linter does this project use" is
// decided by the tree, never by this repository's own tooling.
function root(label: string): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(tmpdir(), `keryx-${label}-${unique}`);
}

function ctx(cwd: string): HealthContext {
  return { cwd } as HealthContext;
}

// `run` mode, and `required` straight from the shipped defaults, so these
// fixtures exercise the same required/optional split the gate will see.
function runCfg(source: string): { mode: "run"; required: boolean } {
  const entry = DEFAULT_HEALTH_CONFIG.sources[source] ?? { mode: "auto", required: false };
  return { mode: "run", required: entry.required };
}

// A tool that answers `--version` and otherwise prints the given body and
// exits with the given code -- the shape a real lint/type run has (findings
// AND a non-zero exit), which `runAdapter` must not read as a broken source.
function fakeTool(body: string, exitCode: number, version = "Version 1.0.0"): string {
  return [
    "#!/bin/sh",
    `if [ "$1" = "--version" ]; then echo ${version}; exit 0; fi`,
    "cat <<'TOOL_OUT'",
    body,
    "TOOL_OUT",
    `exit ${exitCode}`,
    "",
  ].join("\n");
}

const ONE_ERROR = JSON.stringify([
  { filePath: "src/a.ts", messages: [{ ruleId: "no-unused-vars", severity: 2, message: "unused", line: 4 }] },
]);

test("AC1: an oxlint-only fixture detects oxlint and parses one error as source oxlint", async () => {
  const cwd = root("oxlint-only");
  const bin = path.join(cwd, "node_modules", ".bin", "oxlint");
  try {
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(path.join(cwd, ".oxlintrc.json"), "{}\n");
    await writeFile(bin, fakeTool(ONE_ERROR, 1));
    await chmod(bin, 0o755);

    expect(await oxlintAdapter.detect(ctx(cwd))).toBe("available");
    const outcome = await runAdapter(oxlintAdapter, ctx(cwd), runCfg("oxlint"), `test-${Date.now()}`);
    expect(outcome.info.command).toContain(bin);
    expect(outcome.info.command).toContain("--format json");
    expect(outcome.info.status).toBe("available");
    expect(outcome.info.execution).toBe("completed");
    expect(outcome.info.parse).toBe("parsed");
    expect(outcome.info.findings).toBe(1);
    // The finding belongs to the linter that actually ran -- NOT to eslint.
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.source).toBe("oxlint");
    expect(outcome.findings[0]?.message).toBe("unused");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("AC2: an eslint-only fixture still detects eslint, and skips oxlint", async () => {
  const cwd = root("eslint-only");
  const bin = path.join(cwd, "node_modules", ".bin", "eslint");
  try {
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(path.join(cwd, "eslint.config.js"), "export default [];\n");
    await writeFile(bin, fakeTool(ONE_ERROR, 1));
    await chmod(bin, 0o755);

    expect(await eslintAdapter.detect(ctx(cwd))).toBe("available");
    expect(await oxlintAdapter.detect(ctx(cwd))).toBe("skipped");
    const outcome = await runAdapter(eslintAdapter, ctx(cwd), runCfg("eslint"), `test-${Date.now()}`);
    expect(outcome.info.status).toBe("available");
    expect(outcome.findings[0]?.source).toBe("eslint");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("AC2: a project with neither linter skips both", async () => {
  const cwd = root("no-linters");
  try {
    await mkdir(cwd, { recursive: true });
    expect(await oxlintAdapter.detect(ctx(cwd))).toBe("skipped");
    expect(await eslintAdapter.detect(ctx(cwd))).toBe("skipped");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("oxlint configured (config file or package.json) without a binary is missing", async () => {
  const configOnly = root("oxlint-config");
  const packageOnly = root("oxlint-package");
  try {
    await mkdir(configOnly, { recursive: true });
    await writeFile(path.join(configOnly, ".oxlintrc.json"), "{}\n");
    expect(await oxlintAdapter.detect(ctx(configOnly))).toBe("missing");

    await mkdir(packageOnly, { recursive: true });
    await writeFile(
      path.join(packageOnly, "package.json"),
      JSON.stringify({ name: "p", devDependencies: { oxlint: "^1.0.0" } }),
    );
    expect(await oxlintAdapter.detect(ctx(packageOnly))).toBe("missing");
  } finally {
    await rm(configOnly, { recursive: true, force: true });
    await rm(packageOnly, { recursive: true, force: true });
  }
});

test("an oxlint binary with no project config is skipped -- config is the intent", async () => {
  // oxlint arrives transitively in repositories that lint with ESLint; a
  // present binary must never start a second, unrequested lint verdict.
  const cwd = root("oxlint-bin-only");
  const bin = path.join(cwd, "node_modules", ".bin", "oxlint");
  try {
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(bin, "#!/bin/sh\nexit 0\n");
    await chmod(bin, 0o755);
    expect(await oxlintAdapter.detect(ctx(cwd))).toBe("skipped");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("oxlint eslint-style JSON parses and validates as an oxlint run", () => {
  const raw = {
    source: "oxlint", content: ONE_ERROR, command: "oxlint . --format json",
    toolVersion: "Version 1.0.0", exitCode: 1, rawPath: "", imported: false,
  } as RawSourceResult;
  const findings = oxlintAdapter.parse(raw, ctx("/tmp"));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.source).toBe("oxlint");
  expect(findings[0]?.priority).toBe("P1");
  expect(oxlintAdapter.validate?.(raw)).toEqual({ valid: true, format: "oxlint-json" });
});

test("AC6: unparseable oxlint output is configured-but-failed, not an empty success", async () => {
  const cwd = root("oxlint-garbage");
  const bin = path.join(cwd, "node_modules", ".bin", "oxlint");
  try {
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(path.join(cwd, ".oxlintrc.json"), "{}\n");
    await writeFile(bin, fakeTool("this is not json", 1));
    await chmod(bin, 0o755);
    const outcome = await runAdapter(oxlintAdapter, ctx(cwd), runCfg("oxlint"), `test-${Date.now()}`);
    expect(outcome.info.status).toBe("configured-but-failed");
    expect(outcome.info.parse).toBe("failed");
    expect(outcome.info.findings).toBe(0);
    // Named, and inside run.ts's closed validation vocabulary (T70 F-002).
    expect(outcome.info.error).toBe("oxlint JSON format was not recognized");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("AC6: a non-zero tsc exit with recognized TS errors yields findings, not a missing source", async () => {
  const cwd = root("tsc-errors");
  const bin = path.join(cwd, "node_modules", ".bin", "tsc");
  try {
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(path.join(cwd, "tsconfig.json"), "{}\n");
    await writeFile(bin, fakeTool("src/a.ts(1,7): error TS2322: Type 'string' is not assignable.", 2, "Version 7.0.2"));
    await chmod(bin, 0o755);

    expect(await typescriptAdapter.detect(ctx(cwd))).toBe("available");
    const outcome = await runAdapter(typescriptAdapter, ctx(cwd), runCfg("typescript"), `test-${Date.now()}`);
    expect(outcome.info.status).toBe("available");
    expect(outcome.info.exitCode).toBe(2);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.source).toBe("typescript");
    expect(outcome.findings[0]?.message).toContain("TS2322");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
