// The line on the record is the line the REAL ingest derived.
//
// `locate.test.ts` covers the matcher in isolation; this drives
// `createManagedReviewPackage` against a real temp tree and reads
// `findings.json` back off disk. A test over the matcher alone would have
// stayed green through a release in which nothing called it — the same shape of
// defect this pipeline keeps recording about itself.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createManagedReviewPackage, type ManagedReviewIngestInput } from "./managed";
import type { StructuredReviewFinding } from "./types";

const ORIGINAL_CWD = process.cwd();
let ROOT = "";

const SOURCE = [
  "export function greet(name: string): string {",
  "  const trimmed = name.trim();",
  "  return `hello ${trimmed}`;",
  "}",
].join("\n");

beforeEach(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "gd-locate-ingest-"));
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
  await mkdir(path.join(ROOT, "src"), { recursive: true });
  await writeFile(path.join(ROOT, "src", "greet.ts"), SOURCE, "utf8");
});

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

function finding(over: Partial<StructuredReviewFinding> = {}): StructuredReviewFinding {
  return {
    id: "F-001",
    reviewer: "review-logic",
    severity: "minor",
    problem: "the greeting drops an empty name",
    impact: "an empty name renders as a trailing space",
    suggested_fix: "return a bare hello when the name is empty",
    evidence: "called it with an empty string",
    confidence: "high",
    file: "src/greet.ts",
    ...over,
  };
}

async function ingest(over: Partial<ManagedReviewIngestInput> = {}): Promise<StructuredReviewFinding[]> {
  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "ingest",
    reviewId: "2026-09-15-locate",
    target: { kind: "report", ref: "review.md" },
    reportText: "# Round\n\nno machine-readable block here\n",
    findings: [finding()],
    now: new Date("2026-09-15T12:00:00Z"),
    ...over,
  });
  return JSON.parse(await readFile(path.join(ROOT, result.path, "findings.json"), "utf8")) as StructuredReviewFinding[];
}

test("AC1: the recorded line is derived from the quote, not taken from the reviewer", async () => {
  // The reviewer says 99. The code is on line 3. 3 wins, and the record keeps
  // 99 so the drift is measurable rather than merely corrected.
  const [recorded] = await ingest({
    findings: [finding({ line: 99, quote: "  return `hello ${trimmed}`;" })],
  });
  expect(recorded?.line).toBe(3);
  expect(recorded?.locator).toEqual({ state: "derived", method: "exact", reported_line: 99 });
  expect(recorded?.quote).toBe("  return `hello ${trimmed}`;");
});

test("AC2: a quote that is not in the tree yields unlocatable and NO line", async () => {
  const [recorded] = await ingest({
    findings: [finding({ line: 2, quote: "  return `howdy ${trimmed}`;" })],
  });
  expect(recorded?.line).toBeNull();
  expect(recorded?.locator?.state).toBe("unlocatable");
  expect(recorded?.locator).toMatchObject({ reason: "the quote does not appear in the file", reported_line: 2 });
});

test("AC2: a file that is not in the tree says THAT, not that the quote is missing", async () => {
  const [recorded] = await ingest({
    findings: [finding({ file: "src/gone.ts", line: 4, quote: "anything at all" })],
  });
  expect(recorded?.line).toBeNull();
  expect(recorded?.locator?.state === "unlocatable" && recorded.locator.reason).toContain("no such file");
});

test("AC2: an ambiguous quote is unlocatable rather than anchored to the first hit", async () => {
  await writeFile(path.join(ROOT, "src", "twice.ts"), ["const a = 1;", "const b = 2;", "const a = 1;"].join("\n"), "utf8");
  const [recorded] = await ingest({
    findings: [finding({ file: "src/twice.ts", line: 1, quote: "const a = 1;" })],
  });
  expect(recorded?.line).toBeNull();
  expect(recorded?.locator?.state === "unlocatable" && recorded.locator.reason).toContain("2 places");
});

test("BOUNDARY: a finding with no quote keeps its reported line and carries no locator", async () => {
  // Not every finding is about a site. Inventing a locator for one that never
  // quoted anything would report a check that did not happen.
  const [recorded] = await ingest({ findings: [finding({ line: 2 })] });
  expect(recorded?.line).toBe(2);
  expect(recorded?.locator).toBeUndefined();
});

test("a quote naming a file outside the round's tree is refused, not read", async () => {
  const [recorded] = await ingest({
    findings: [finding({ file: "../../../etc/hosts", line: 1, quote: "localhost" })],
  });
  expect(recorded?.line).toBeNull();
  expect(recorded?.locator?.state).toBe("unlocatable");
});

test("the tree reader is injectable, and what it returns is what gets located", async () => {
  const [recorded] = await ingest({
    readTreeFile: async (relative: string) => (relative === "src/injected.ts" ? "alpha\nbeta\ngamma\n" : null),
    findings: [finding({ file: "src/injected.ts", line: 1, quote: "gamma" })],
  });
  expect(recorded?.line).toBe(3);
  expect(recorded?.locator).toMatchObject({ state: "derived", method: "exact" });
});
