// Flow 454 AC3: `keryx memory search` with a review package active appends one entry (source "cli") to its
// orchestrator log, and its stdout and exit code are those of the same run with no package active.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { memoryCalls } from "../review/layers-usage";
import { clearActiveReview } from "../review/active-review";
import { createManagedReviewPackage } from "../review/managed";
import { ENV_REVIEW_CALLER, ENV_REVIEW_RECORDED, orchestratorLogPath, startOrchestratorLog } from "../review/orchestrator-log";
import { memoryCliEntry } from "./memory";

const SCHEMA = path.resolve(import.meta.dir, "..", "..", "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json");

describe("AC3: keryx memory search records into the active package", () => {
  let root = "";
  let cwd = "";
  let out: string[] = [];
  let err: string[] = [];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalEnv: Record<string, string | undefined> = {};
  let packageDir = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-memory-orch-log-"));
    cwd = process.cwd();
    process.chdir(root);
    originalEnv = { [ENV_REVIEW_CALLER]: process.env[ENV_REVIEW_CALLER], [ENV_REVIEW_RECORDED]: process.env[ENV_REVIEW_RECORDED] };
    delete process.env[ENV_REVIEW_CALLER];
    delete process.env[ENV_REVIEW_RECORDED];

    await mkdir(path.join(root, ".metaproject", "memory", "decisions"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "memory", "decisions", "canary.md"),
      `# Roll out canary deploys for the release pipeline

Version: 3.4.1
Type: decision
Status: accepted
Confidence: high

## Summary

Adopt canary deploys for the release pipeline.

## Provenance

- Source: pr#901
- Link: https://example.invalid/pr/901
- Author: author:carol
- Confirmed-By: reviewer:alice
- Created: 2026-06-01
- Updated: 2026-06-01
`,
      "utf8",
    );
    const schemas = path.join(root, "docs", "requirements", "managed-review-feedback-loop", "schemas");
    await mkdir(schemas, { recursive: true });
    await writeFile(path.join(schemas, "managed-review-package.schema.json"), await readFile(SCHEMA, "utf8"));
    const created = await createManagedReviewPackage({
      cwd: root,
      mode: "review-flow",
      reviewId: "r-memory-cli",
      target: { kind: "branch", ref: "feat/x" },
      coverage: [{ reviewer: "review-style", status: "skipped", reason: "not selected for the fixture" }],
    });
    packageDir = path.resolve(root, created.path);

    out = [];
    err = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...parts: unknown[]) => void out.push(parts.map(String).join(" "));
    console.error = (...parts: unknown[]) => void err.push(parts.map(String).join(" "));
    process.exitCode = 0;
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = 0;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  });

  async function search(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    out = [];
    err = [];
    process.exitCode = 0;
    await memoryCliEntry(["search", "canary deploys", "--status", "accepted"]);
    return { stdout: out.join("\n"), stderr: err.join("\n"), exitCode: Number(process.exitCode ?? 0) };
  }

  test("with an active package one entry is appended and the output and exit code are unchanged", async () => {
    const without = await search();
    expect(without.stdout).toContain("canary");
    expect(existsSync(orchestratorLogPath(packageDir))).toBe(false);

    await startOrchestratorLog(root, "r-memory-cli", path.relative(root, packageDir));
    const withPackage = await search();
    expect(withPackage).toEqual(without);

    const lines = readFileSync(orchestratorLogPath(packageDir), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const entries = lines.filter((line) => line.source !== undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe("cli");
    expect(entries[0]?.caller).toBe("unattributed");
    const calls = memoryCalls(readFileSync(orchestratorLogPath(packageDir), "utf8"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.search).toBe(true);
    expect(calls[0]?.accepted).toBe(true);
    expect(calls[0]?.query).toBe("canary deploys");
  });

  test("a call from a review child's command names that child", async () => {
    await startOrchestratorLog(root, "r-memory-cli", path.relative(root, packageDir));
    process.env[ENV_REVIEW_CALLER] = "review-logic";
    await search();
    const calls = memoryCalls(readFileSync(orchestratorLogPath(packageDir), "utf8"));
    expect(calls.map((call) => call.caller)).toEqual(["review-logic"]);
  });

  test("a call a keryx layer already recorded is not recorded again", async () => {
    await startOrchestratorLog(root, "r-memory-cli", path.relative(root, packageDir));
    process.env[ENV_REVIEW_RECORDED] = "1";
    await search();
    expect(memoryCalls(readFileSync(orchestratorLogPath(packageDir), "utf8"))).toHaveLength(0);
  });

  test("without an active package no file appears", async () => {
    const result = await search();
    expect(result.stdout).toContain("canary");
    expect(existsSync(path.join(packageDir, "tool-calls"))).toBe(false);
  });

  test("a pointer cleared by closing stops the recording", async () => {
    await startOrchestratorLog(root, "r-memory-cli", path.relative(root, packageDir));
    await clearActiveReview(root);
    await search();
    expect(memoryCalls(readFileSync(orchestratorLogPath(packageDir), "utf8"))).toHaveLength(0);
  });
});
