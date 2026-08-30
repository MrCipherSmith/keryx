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

// ---------------------------------------------------------------------------
// Flow 203 AC5-AC7, AC9, AC10 — the caps and the loop detector, from the CLI
// ---------------------------------------------------------------------------

test("AC6: `review budget` STOPS when spend has reached the ceiling", async () => {
  // The gate that runs BEFORE dispatch, where stopping is still possible.
  // `ingest` can only record that a round went over; by then the money is spent.
  await reviewCommand(["budget", "--spent", "3.40"]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("STOP");
  expect(errors.join("\n")).toContain("Ask the operator");
});

test("AC6: `review budget` under the ceiling proceeds", async () => {
  await reviewCommand(["budget", "--spent", "0.40"]);

  expect(process.exitCode).toBe(0);
  expect(logs.join("\n")).toContain("spend_status: under");
});

test("AC10: unreported spend reads `not recorded`, not `under`", async () => {
  await reviewCommand(["budget"]);

  expect(process.exitCode).toBe(0);
  expect(logs.join("\n")).toContain("spend_status: not-recorded");
  expect(logs.join("\n")).toContain("`not recorded` is not `under`");
});

test("AC7/AC10: `review budget` plans waves and says whether the cap holds across nesting", async () => {
  await reviewCommand(["budget", "--reviewers", "a,b,c,d,e,f"]);
  const output = logs.join("\n");

  expect(output).toContain("concurrency_cap: 4");
  expect(output).toContain("reviewers_queued: 2");
  expect(output).toContain("holds_across_nesting: no");
  expect(output).toContain("outstanding_declared: not recorded");
});

test("AC7: a declared outstanding count is the only thing that reaches the nesting", async () => {
  await reviewCommand(["budget", "--reviewers", "a,b,c,d", "--outstanding", "2"]);
  const output = logs.join("\n");

  expect(output).toContain("effective_wave_size: 2");
  expect(output).toContain("holds_across_nesting: yes");
});

test("AC5/AC10: an ingest over the cap truncates and says so on the terminal", async () => {
  const many = Array.from({ length: 14 }, (_, index) => ({
    ...FINDING,
    id: `F-${String(index + 1).padStart(3, "0")}`,
  }));
  await writeFile(path.join(ROOT, "report.md"), reportWith(many), "utf8");
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    "2026-08-30-cli-cap",
  ]);

  const pkg = path.join(ROOT, ".metaproject", "reviews", "2026-08-30-cli-cap");
  expect(await findingsOf(pkg)).toHaveLength(10);
  // On the terminal the operator was already looking at, not only in a file
  // they had no reason to open.
  expect(logs.join("\n")).toContain("findings cap: limit=10/reviewer truncated=4");
  expect(logs.join("\n")).toContain("truncated 4 from review-security-code");
});

test("AC6: an ingest over the ceiling still writes the package, then refuses", async () => {
  await writeFile(path.join(ROOT, "report.md"), reportWith([FINDING]), "utf8");
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    "2026-08-30-cli-spend",
    "--spent",
    "5",
  ]);

  // The record of the stop survives; the command still refuses.
  const scope = await readFile(
    path.join(ROOT, ".metaproject", "reviews", "2026-08-30-cli-spend", "scope.md"),
    "utf8",
  );
  expect(scope).toContain("STOPPED at the ceiling");
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("STOP: spend 5 USD");
});

test("AC9: `review loop` escalates on a repeated finding, whatever the budget", async () => {
  const flowDir = path.join(ROOT, ".metaproject", "flows", "203-loop");
  await mkdir(flowDir, { recursive: true });
  await writeFile(
    path.join(flowDir, "flow.json"),
    JSON.stringify({
      schemaVersion: 2,
      id: "203",
      slug: "loop",
      title: "loop",
      status: "in-progress",
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      source: { type: "description", ref: null },
      acChecksum: null,
      acConfirmed: {},
      pr: { url: null },
      tasks: [{ id: "T1", title: "fix", kind: "implement", status: "todo", attempts: { count: 1, log: [] } }],
      history: [],
    }),
    "utf8",
  );
  for (const [name, at] of [
    ["round-1", "2026-08-30T01:00:00.000Z"],
    ["round-2", "2026-08-30T02:00:00.000Z"],
  ] as const) {
    const dir = path.join(flowDir, "reviews", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ reviewId: name, createdAt: at }), "utf8");
    await writeFile(path.join(dir, "findings.json"), JSON.stringify([FINDING]), "utf8");
    await writeFile(path.join(dir, "report.md"), `# ${name}\n`, "utf8");
  }

  await reviewCommand(["loop", "--flow", "203", "--task", "T1"]);

  // One attempt spent out of three: a counter would say "keep going".
  expect(logs.join("\n")).toContain("attempts_recorded: 1");
  expect(logs.join("\n")).toContain("repeated-finding");
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("ESCALATE");
});

// ---------------------------------------------------------------------------
// AC3 from the command line: the scope-B screen's set, and its counts
// ---------------------------------------------------------------------------
//
// The screen itself is proven in `review/managed.test.ts`. What is proven here
// is the pair of wires the library cannot see: that `--blast-radius` reaches
// `ManagedReviewIngestInput.blastRadius`, and that the counts reach the terminal.
// The screen shipped with neither, so an enforcement that ran was indistinguishable
// on the terminal from one that had not — the shape of every defect this round found.

const SCOPE_B_FINDING = {
  id: "B-001",
  reviewer: "review-regression",
  severity: "major",
  problem: "this function is named badly and the module is arranged oddly",
  impact: "future readers will be slower",
  suggested_fix: "rename it",
  evidence: "read the file",
  confidence: "high",
  file: "src/untouched.ts",
  scope: "blast-radius",
};

test("--blast-radius reaches the screen, and the screen says which set it used", async () => {
  await writeFile(
    path.join(ROOT, "radius.json"),
    JSON.stringify({ files: [{ path: "src/untouched.ts", hop: 1 }], changedFiles: ["src/changed.ts"] }),
    "utf8",
  );
  await writeFile(path.join(ROOT, "report.md"), reportWith([SCOPE_B_FINDING]), "utf8");
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    "2026-08-30-cli-blast-radius",
    "--blast-radius",
    "radius.json",
  ]);

  expect(process.exitCode).toBe(0);
  expect(logs.join("\n")).toContain("scope-B screen: source=input");
});

test("a --blast-radius record missing its arrays is refused, not defaulted to an empty set", async () => {
  // An invented empty set rejects every scope-B finding as `outside-set` and
  // reports that as the screen working.
  await writeFile(path.join(ROOT, "radius.json"), JSON.stringify({ depth: 2 }), "utf8");
  await writeFile(path.join(ROOT, "report.md"), reportWith([SCOPE_B_FINDING]), "utf8");
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    "2026-08-30-cli-blast-radius-empty",
    "--blast-radius",
    "radius.json",
  ]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--blast-radius");
});
