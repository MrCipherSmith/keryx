// The three points a round's price is visible at, driven through the real CLI.
//
// A test over `cost.ts` alone would stay green through a release in which
// nothing called it — which is the state `review budget` was already in, with a
// ceiling it printed and a spend nothing ever fed.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import type { ManagedReviewManifest } from "./types";

const ORIGINAL_CWD = process.cwd();
let ROOT = "";
let logs: string[] = [];
const realLog = console.log;

beforeEach(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "gd-cost-cli-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  await mkdir(path.join(ROOT, "docs", "requirements", "managed-review-feedback-loop", "schemas"), { recursive: true });
  await writeFile(
    path.join(ROOT, "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json"),
    await readFile(
      path.join(ORIGINAL_CWD, "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json"),
      "utf8",
    ),
    "utf8",
  );
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  process.exitCode = 0;
});

afterEach(async () => {
  console.log = realLog;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

const REPORT = [
  "# Round",
  "",
  "```json keryx:findings",
  JSON.stringify([
    {
      id: "F-001",
      reviewer: "review-logic",
      severity: "minor",
      problem: "stated",
      impact: "stated",
      suggested_fix: "stated",
      evidence: "stated",
      confidence: "high",
    },
  ]),
  "```",
  "",
].join("\n");

test("point 1 — `review scope` prints an estimate before anything is dispatched", async () => {
  const diff = path.join(ROOT, "change.diff");
  await writeFile(
    diff,
    [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      " const a = 1;",
      "+const b = 2;",
      " const c = 3;",
      "",
    ].join("\n"),
    "utf8",
  );
  process.chdir(ROOT);
  await reviewCommand(["scope", "--diff", diff, "--reviewers", "review-logic,review-style,review-security-code"]);
  const out = logs.join("\n");
  expect(out).toContain("### Estimated cost");
  expect(out).toContain("per reviewer");
  expect(out).toContain("across 3 reviewers");
  expect(out).toContain("an estimate, not a measurement");
});

test("point 1 — the machine-readable forms carry no prose about money", async () => {
  const diff = path.join(ROOT, "change.diff");
  await writeFile(diff, "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n a\n+b\n", "utf8");
  process.chdir(ROOT);
  await reviewCommand(["scope", "--diff", diff, "--json"]);
  expect(logs.join("\n")).not.toContain("Estimated cost");
  logs = [];
  await reviewCommand(["scope", "--diff", diff, "--scoped-diff"]);
  expect(logs.join("\n")).not.toContain("Estimated cost");
});

test("point 2 — `review ingest` records what the round used, on the package", async () => {
  await writeFile(path.join(ROOT, "report.md"), REPORT, "utf8");
  process.chdir(ROOT);
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    "2026-09-15-cost",
    "--tokens-in",
    "440000",
    "--tokens-out",
    "10000",
    "--spent",
    "1.25",
  ]);
  const manifest = JSON.parse(
    await readFile(path.join(ROOT, ".metaproject", "reviews", "2026-09-15-cost", "manifest.json"), "utf8"),
  ) as ManagedReviewManifest;
  expect(manifest.cost).toEqual({ input_tokens: 440_000, output_tokens: 10_000, spent_usd: 1.25 });
});

test("point 2 — a round that reported nothing records NO cost, rather than zero", async () => {
  await writeFile(path.join(ROOT, "report.md"), REPORT, "utf8");
  process.chdir(ROOT);
  await reviewCommand(["ingest", "--report", "report.md", "--ref", "report.md", "--review-id", "2026-09-15-silent"]);
  const manifest = JSON.parse(
    await readFile(path.join(ROOT, ".metaproject", "reviews", "2026-09-15-silent", "manifest.json"), "utf8"),
  ) as ManagedReviewManifest;
  expect(manifest.cost).toBeUndefined();
});

test("point 3 — `review complete` prints the cost per retained finding", async () => {
  await writeFile(path.join(ROOT, "report.md"), REPORT, "utf8");
  process.chdir(ROOT);
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    "2026-09-15-priced",
    "--tokens-in",
    "440000",
    "--tokens-out",
    "10000",
  ]);
  logs = [];
  await reviewCommand(["complete", "2026-09-15-priced"]);
  const out = logs.join("\n");
  expect(out).toContain("tokens: 450,000");
  expect(out).toContain("retained findings: 1");
  expect(out).toContain("per retained finding: 450,000 tokens");
});

test("point 3 — an unpriced round says `not recorded`, and says that is not zero", async () => {
  await writeFile(path.join(ROOT, "report.md"), REPORT, "utf8");
  process.chdir(ROOT);
  await reviewCommand(["ingest", "--report", "report.md", "--ref", "report.md", "--review-id", "2026-09-15-unpriced"]);
  logs = [];
  await reviewCommand(["complete", "2026-09-15-unpriced"]);
  const out = logs.join("\n");
  expect(out).toContain("cost: not recorded");
  expect(out).toContain("NOT zero");
});
