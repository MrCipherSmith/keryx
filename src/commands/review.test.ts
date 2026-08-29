// The CLI surface of the review pipeline (flow 202, AC5/AC14).
//
// Every mechanism this flow added is reachable from TypeScript. That is not the
// same as being reachable, and the difference was measured: `completeManagedReview
// ({dispositions})` and `createManagedReviewPackage({refuted})` had no flag, so
// the shipped pipeline could write ZERO dispositions — and because unknown flags
// were accepted silently with exit 0, an operator who guessed the right spelling
// got `status: closed` and a findings.json with nothing in it. A mechanism that
// nothing can reach measures nothing, which is the state that pinned the
// precision figure at 100% in the first place.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";
import type { StructuredReviewFinding } from "../review/types";

const ORIGINAL_CWD = process.cwd();
let ROOT = "";
let errors: string[] = [];
let logs: string[] = [];
const realError = console.error;
const realLog = console.log;

beforeEach(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "gd-review-cli-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  process.chdir(ROOT);
  errors = [];
  logs = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  process.exitCode = 0;
});

afterEach(async () => {
  console.error = realError;
  console.log = realLog;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

const FINDING = {
  id: "F-001",
  reviewer: "review-security-code",
  severity: "minor",
  problem: "the guard asserts on a synthetic context",
  impact: "the guard passes when the production path is unwired",
  suggested_fix: "drive the writer the CLI drives",
  evidence: "deleted the guarded line; the test stayed green",
  confidence: "high",
};

/** A report carrying the structured block, which is how ingest gets findings. */
function reportWith(findings: readonly unknown[]): string {
  return `# Round\n\n\`\`\`json keryx:findings\n${JSON.stringify(findings, null, 2)}\n\`\`\`\n`;
}

async function ingest(reviewId: string, extra: string[] = []): Promise<string> {
  await writeFile(path.join(ROOT, "report.md"), reportWith([FINDING]), "utf8");
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    reviewId,
    ...extra,
  ]);
  return path.join(ROOT, ".metaproject", "reviews", reviewId);
}

async function findingsOf(packageDir: string): Promise<StructuredReviewFinding[]> {
  return JSON.parse(await readFile(path.join(packageDir, "findings.json"), "utf8")) as StructuredReviewFinding[];
}

// ---------------------------------------------------------------------------
// Unknown flags
// ---------------------------------------------------------------------------

test("an unknown flag is refused rather than ignored with exit 0", async () => {
  // The compounding failure. Guessing `--disposition` on a command that had no
  // such option printed `status: closed` and wrote nothing, so the operator had
  // no signal at all that the mechanism had not run.
  const pkg = await ingest("2026-08-29-cli-unknown-flag");
  expect(process.exitCode).toBe(0);

  await reviewCommand(["complete", pkg, "--not-a-flag", "x"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--not-a-flag");
});

test("a misspelled ingest flag is refused before a package is written", async () => {
  await writeFile(path.join(ROOT, "report.md"), reportWith([FINDING]), "utf8");
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    "2026-08-29-cli-bad-ingest-flag",
    "--verification_mode",
    "filter",
  ]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--verification_mode");
});

test("every documented flag is still accepted", async () => {
  // Non-vacuity: an allowlist that rejects the real surface is worse than none.
  await writeFile(path.join(ROOT, "diff.patch"), "", "utf8");
  await reviewCommand(["scope", "--diff", "diff.patch", "--context", "10", "--json"]);
  expect(process.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// AC14: the disposition, from the command line
// ---------------------------------------------------------------------------

test("`review complete` writes a disposition with its evidence", async () => {
  const pkg = await ingest("2026-08-29-cli-disposition");
  await reviewCommand([
    "complete",
    pkg,
    "--finding",
    "F-001",
    "--disposition",
    "acted-on",
    "--evidence",
    "closed by 380bf3b0",
  ]);
  expect(process.exitCode).toBe(0);

  const findings = await findingsOf(pkg);
  expect(findings[0]?.disposition).toEqual({ state: "acted-on", evidence: "closed by 380bf3b0" });
  expect(logs.join("\n")).toContain("dispositions recorded: 1");
});

test("several findings can be dispositioned in one close", async () => {
  await writeFile(
    path.join(ROOT, "report.md"),
    reportWith([FINDING, { ...FINDING, id: "F-002", problem: "a second observation" }]),
    "utf8",
  );
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    "2026-08-29-cli-two-dispositions",
  ]);
  const pkg = path.join(ROOT, ".metaproject", "reviews", "2026-08-29-cli-two-dispositions");

  await reviewCommand([
    "complete",
    pkg,
    "--finding",
    "F-001",
    "--disposition",
    "acted-on",
    "--evidence",
    "closed by 380bf3b0",
    "--finding",
    "F-002",
    "--disposition",
    "dismissed-incorrect",
    "--evidence",
    "ran the writer under umask 002; the mode is 0700",
  ]);
  expect(process.exitCode).toBe(0);

  const findings = await findingsOf(pkg);
  expect(findings.map((f) => f.disposition?.state)).toEqual(["acted-on", "dismissed-incorrect"]);
});

test("an unknown disposition state is refused by name", async () => {
  const pkg = await ingest("2026-08-29-cli-bad-state");
  await reviewCommand(["complete", pkg, "--finding", "F-001", "--disposition", "dismissed", "--evidence", "x"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("dismissed-incorrect");
});

test("`--disposition` without `--finding` is refused rather than applied to everything", async () => {
  const pkg = await ingest("2026-08-29-cli-orphan-disposition");
  await reviewCommand(["complete", pkg, "--disposition", "acted-on", "--evidence", "closed by 380bf3b0"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--finding");
});

test("closing with no disposition flags still works, and writes nothing", async () => {
  const pkg = await ingest("2026-08-29-cli-plain-complete");
  const before = await readFile(path.join(pkg, "findings.json"), "utf8");
  await reviewCommand(["complete", pkg]);
  expect(process.exitCode).toBe(0);
  expect(await readFile(path.join(pkg, "findings.json"), "utf8")).toBe(before);
});

// ---------------------------------------------------------------------------
// AC14: what a round REFUTED, from the command line
// ---------------------------------------------------------------------------

test("`review ingest --refuted` records what the round raised and dismissed", async () => {
  await writeFile(
    path.join(ROOT, "refuted.json"),
    JSON.stringify([
      {
        ...FINDING,
        id: "F-009",
        problem: "claimed the writer is group-writable",
        disposition: {
          state: "dismissed-incorrect",
          evidence: "ran the writer under umask 002; the mode is 0700",
        },
      },
    ]),
    "utf8",
  );
  const pkg = await ingest("2026-08-29-cli-refuted", ["--refuted", "refuted.json"]);

  const findings = await findingsOf(pkg);
  expect(findings.map((f) => f.id)).toEqual(["F-001", "F-009"]);
  expect(findings[1]?.disposition?.state).toBe("dismissed-incorrect");
});

// ---------------------------------------------------------------------------
// AC5: --append, and the record surviving ingest
// ---------------------------------------------------------------------------

const DIFF = `diff --git a/bun.lock b/bun.lock
--- a/bun.lock
+++ b/bun.lock
@@ -1,2 +1,2 @@
-"old"
+"new"
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
`;

test("`--append` run three times leaves ONE pre-filter block", async () => {
  // It appended, so a re-run — an ordinary thing to do after amending a commit —
  // left three contradictory blocks in one record and no rule for which to read.
  await writeFile(path.join(ROOT, "diff.patch"), DIFF, "utf8");
  await mkdir(path.join(ROOT, "pkg"), { recursive: true });
  for (let i = 0; i < 3; i += 1) {
    await reviewCommand(["scope", "--diff", "diff.patch", "--append", path.join(ROOT, "pkg", "scope.md")]);
  }
  const scope = await readFile(path.join(ROOT, "pkg", "scope.md"), "utf8");
  expect(scope.match(/^## Pre-filter scope$/gm)).toHaveLength(1);
  expect(scope).toContain("bun.lock");
});

test("`--append` replaces the block and leaves the rest of scope.md alone", async () => {
  await writeFile(path.join(ROOT, "diff.patch"), DIFF, "utf8");
  await mkdir(path.join(ROOT, "pkg"), { recursive: true });
  await writeFile(
    path.join(ROOT, "pkg", "scope.md"),
    "# Review Scope\n\ntarget: branch\n\n## Pre-filter scope\n\nstale, from an earlier run\n\n## Stage counts\n\nkeep me\n",
    "utf8",
  );
  await reviewCommand(["scope", "--diff", "diff.patch", "--append", path.join(ROOT, "pkg", "scope.md")]);

  const scope = await readFile(path.join(ROOT, "pkg", "scope.md"), "utf8");
  expect(scope).toContain("target: branch");
  expect(scope).toContain("## Stage counts");
  expect(scope).toContain("keep me");
  expect(scope).not.toContain("stale, from an earlier run");
  expect(scope.match(/^## Pre-filter scope$/gm)).toHaveLength(1);
});

test("`--scope` carries the drop REASONS into the package, not only the counts", async () => {
  await writeFile(path.join(ROOT, "diff.patch"), DIFF, "utf8");
  const scopeJson = path.join(ROOT, "scope.json");
  const captured: string[] = [];
  const previous = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  await reviewCommand(["scope", "--diff", "diff.patch", "--json"]);
  console.log = previous;
  await writeFile(scopeJson, captured.join("\n"), "utf8");

  const pkg = await ingest("2026-08-29-cli-scope-json", ["--scope", scopeJson]);
  const scope = await readFile(path.join(pkg, "scope.md"), "utf8");
  expect(scope).toContain("bun.lock");
  expect(scope).toContain("lockfile");
  expect(scope).not.toContain("no pre-filter scope was supplied");
});
