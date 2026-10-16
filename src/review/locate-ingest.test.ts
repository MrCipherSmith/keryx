// The line on the record is the line the REAL ingest derived.
//
// `locate.test.ts` covers the matcher in isolation; this drives
// `createManagedReviewPackage` against a real temp tree and reads
// `findings.json` back off disk. A test over the matcher alone would have
// stayed green through a release in which nothing called it — the same shape of
// defect this pipeline keeps recording about itself.

import { $ } from "bun";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("REGRESSION — a symlink inside the tree does not read what it points at", async () => {
  // The containment check compared resolved path STRINGS, so `src/link` naming
  // `/etc/passwd` passed it and `readFile` followed the link. Worse than a
  // read: `derived` versus `unlocatable` then answers "is this line in that
  // file", one line at a time.
  const outside = path.join(ROOT, "..", `outside-${path.basename(ROOT)}.txt`);
  await writeFile(outside, "secret-line-one\nsecret-line-two\n", "utf8");
  try {
    await symlink(outside, path.join(ROOT, "src", "link.ts"));
  } catch {
    return; // A platform without symlinks has nothing to defend against here.
  }
  const [recorded] = await ingest({
    findings: [finding({ file: "src/link.ts", line: 1, quote: "secret-line-one" })],
  });
  expect(recorded?.line).toBeNull();
  expect(recorded?.locator?.state).toBe("unlocatable");
  await rm(outside, { force: true });
});

test("REGRESSION — a locator carried in from a previous round is cleared, not echoed", async () => {
  // A fix round re-reports a finding out of `prior_findings`, which carries the
  // previous round's locator. With no fresh quote nothing was checked this
  // time, so keeping it would write an unverified line under a record that
  // claims every line is derived.
  const [recorded] = await ingest({
    findings: [
      finding({
        line: 42,
        locator: { state: "unlocatable", reason: "stale reason from a previous round", reported_line: 7 },
      }),
    ],
  });
  expect(recorded?.locator).toBeUndefined();
  expect(recorded?.line).toBe(42); // reported-only, and saying so by carrying no locator
});

test("a file past the read bound is not located against", async () => {
  await writeFile(path.join(ROOT, "src", "huge.ts"), "x\n".repeat(2_100_000), "utf8");
  const [recorded] = await ingest({
    findings: [finding({ file: "src/huge.ts", line: 1, quote: "x" })],
  });
  expect(recorded?.line).toBeNull();
  expect(recorded?.locator?.state).toBe("unlocatable");
});

test("REGRESSION — a round is located at the commit it records, not at the current tree", async () => {
  // The mechanism's own first use found this. A round ingested after its fix
  // commit had rewritten the quoted lines reported five of six findings
  // `unlocatable` — true of the working tree, useless about the round. Six of
  // six located once the recorded head was used.
  await $`git init -q`.cwd(ROOT).quiet();
  await $`git -c user.email=t@t -c user.name=t add -A`.cwd(ROOT).quiet();
  await $`git -c user.email=t@t -c user.name=t commit -q -m first`.cwd(ROOT).quiet();
  const head = (await $`git rev-parse HEAD`.cwd(ROOT).quiet().text()).trim();

  // The tree moves on, exactly as a fix commit moves it.
  await writeFile(path.join(ROOT, "src", "greet.ts"), "export function greet() {\n  return 'rewritten';\n}\n", "utf8");

  const [recorded] = await ingest({
    target: { kind: "report", ref: "review.md", head },
    findings: [finding({ line: 1, quote: "  return `hello ${trimmed}`;" })],
  });
  expect(recorded?.locator?.state).toBe("derived");
  expect(recorded?.line).toBe(3); // where it was at `head`, not where the tree is now
});

test("the tree reader is injectable, and what it returns is what gets located", async () => {
  const [recorded] = await ingest({
    readTreeFile: async (relative: string) => (relative === "src/injected.ts" ? "alpha\nbeta\ngamma\n" : null),
    findings: [finding({ file: "src/injected.ts", line: 1, quote: "gamma" })],
  });
  expect(recorded?.line).toBe(3);
  expect(recorded?.locator).toMatchObject({ state: "derived", method: "exact" });
});

async function commitTree(): Promise<string> {
  await $`git init -q`.cwd(ROOT).quiet();
  await $`git -c user.email=t@t -c user.name=t add -A`.cwd(ROOT).quiet();
  await $`git -c user.email=t@t -c user.name=t commit -q -m first`.cwd(ROOT).quiet();
  return (await $`git rev-parse HEAD`.cwd(ROOT).quiet().text()).trim();
}

test("flow 458 AC12 — a finding whose file is absent at the reviewed head is kept, flagged path_missing and listed in scope.md", async () => {
  const head = await commitTree();
  // Present in the working tree after the round's head, absent AT the head: the finding cited a file the reviewer never read there.
  await writeFile(path.join(ROOT, "src", "later.ts"), "export const later = 1;\n", "utf8");

  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "ingest",
    reviewId: "2026-09-15-path-missing",
    target: { kind: "report", ref: "review.md", head },
    reportText: "# Round\n\nno machine-readable block here\n",
    findings: [
      finding({ id: "F-001" }),
      finding({ id: "F-002", file: "src/never-existed.ts", line: 3 }),
      finding({ id: "F-003", file: "src/later.ts" }),
      finding({ id: "F-004", file: "../outside.ts" }),
    ],
    now: new Date("2026-09-15T12:00:00Z"),
  });
  const recorded = JSON.parse(await readFile(path.join(ROOT, result.path, "findings.json"), "utf8")) as StructuredReviewFinding[];
  const byId = new Map(recorded.map((entry) => [entry.id, entry]));
  expect(byId.get("F-001")?.path_missing).toBeUndefined();
  expect(byId.get("F-002")?.path_missing).toBe(true);
  expect(byId.get("F-003")?.path_missing).toBe(true);
  expect(byId.get("F-004")?.path_missing).toBe(true);
  const scope = await readFile(path.join(ROOT, result.path, "scope.md"), "utf8");
  expect(scope).toContain("## Paths missing at the reviewed head");
  expect(scope).toContain("src/never-existed.ts");
  expect(scope).not.toMatch(/F-001 \(review-logic\): src\/greet\.ts/);
});

test("flow 458 AC12 — a quoted finding on a missing path is flagged, not refused as an unresolved quote", async () => {
  const head = await commitTree();
  const [recorded] = await ingest({
    target: { kind: "report", ref: "review.md", head },
    findings: [finding({ file: "src/gone.ts", line: 4, quote: "anything at all" })],
  });
  expect(recorded?.path_missing).toBe(true);
  expect(recorded?.line).toBeNull();
});

test("flow 458 AC12 — with no recorded head nothing is flagged: the tree reader decides alone", async () => {
  const [recorded] = await ingest({ findings: [finding({ file: "src/gone.ts" })] });
  expect(recorded?.path_missing).toBeUndefined();
});
