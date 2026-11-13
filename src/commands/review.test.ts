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
import { reviewCommand, runReviewers } from "./review";
import type { StructuredReviewFinding } from "../review/types";
import { readyResearchFixture } from "../review/research.test-helpers";
import { replaceRoutingLayer } from "../harness/routing/settings";
import type { RoutingConfigLayer } from "../harness/routing/config";
import { setModelProfileField } from "../harness/routing/model-profile";

const ORIGINAL_CWD = process.cwd();
let ROOT = "";
let errors: string[] = [];
let logs: string[] = [];
const realError = console.error;
const realLog = console.log;
const REAL_XDG = process.env.XDG_DATA_HOME;

beforeEach(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "gd-review-cli-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  process.chdir(ROOT);
  // `review tier` reads the provider/model `keryx shell` persisted, which lives
  // under the per-user config directory rather than under the cwd. Without this
  // the developer's own `auth.json` would decide what these tests assert.
  process.env.XDG_DATA_HOME = path.join(ROOT, "xdg");
  // Same reason: a host that exports its session model would otherwise decide
  // what the tier tests below assert.
  delete process.env.KERYX_SESSION_PROVIDER;
  delete process.env.KERYX_SESSION_MODEL;
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
  if (REAL_XDG === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = REAL_XDG;
  }
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
  return `# Round\n\nEvidence level: static only — did not run: tests\n\n\`\`\`json keryx:findings\n${JSON.stringify(findings, null, 2)}\n\`\`\`\n`;
}

async function ingest(reviewId: string, extra: string[] = []): Promise<string> {
  await writeFile(path.join(ROOT, "research.json"), JSON.stringify(readyResearchFixture([FINDING.reviewer], [FINDING.id])), "utf8");
  await writeFile(path.join(ROOT, "report.md"), reportWith([FINDING]), "utf8");
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    reviewId,
    "--research",
    "research.json",
    ...extra,
  ], { prBase: async () => undefined });
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

test("`review scope --help` prints usage and does not scan a diff", async () => {
  await reviewCommand(["scope", "--help"]);
  expect(process.exitCode).toBe(0);
  const out = logs.join("\n");
  expect(out).toContain("keryx review scope");
  expect(out).toContain("--scoped-diff");
  expect(out).not.toContain("files_seen");
});

test("`review tier -h` prints usage and does not compute a tier", async () => {
  await reviewCommand(["tier", "-h"]);
  expect(process.exitCode).toBe(0);
  const out = logs.join("\n");
  expect(out).toContain("keryx review tier");
  expect(out).toContain("inherit: true");
  expect(out).not.toContain("tier_reasons:");
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
  await writeFile(path.join(ROOT, "research.json"), JSON.stringify(readyResearchFixture([FINDING.reviewer], ["F-001", "F-002"])), "utf8");
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    "2026-08-29-cli-two-dispositions",
    "--research",
    "research.json",
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

test("`review complete --head` reaches the gate: it is not read as a disposition flag, and a head that is not the PR's still fails", async () => {
  const PR_URL = "https://github.com/acme/app/pull/7";
  const RECORDED = "a".repeat(40);
  const OTHER = "b".repeat(40);
  const prLookup = async () => ({ exists: true, state: "OPEN", headSha: RECORDED });
  const pkg = await ingest("2026-10-14-cli-complete-head", ["--target", "pr", "--ref", PR_URL, "--head", OTHER]);
  const REASON = "the operator confirms the round ran against the PR head";
  // Flow 488: a --head that differs from the recorded head is the operator's act: it needs the quote, and a terminal to carry it.
  await reviewCommand(["complete", pkg, "--head", RECORDED], { prLookup, isTerminal: () => true });
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--head-reason");
  process.exitCode = 0;
  await reviewCommand(["complete", pkg, "--head", RECORDED, "--head-reason", REASON], { prLookup, isTerminal: () => true });
  expect(process.exitCode).toBe(0);
  const closed = JSON.parse(await readFile(path.join(pkg, "manifest.json"), "utf8"));
  expect(closed.target.head).toBe(RECORDED);
  expect(closed.head_override).toMatchObject({ from: OTHER, to: RECORDED, operator_quote: REASON });
  expect(errors.join("\n")).toContain("replaces the head recorded");

  const strict = await ingest("2026-10-14-cli-complete-head-strict", ["--target", "pr", "--ref", PR_URL, "--head", RECORDED]);
  process.exitCode = 0;
  await reviewCommand(["complete", strict, "--head", OTHER, "--head-reason", REASON], { prLookup, isTerminal: () => true });
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--waive head");
});

test("`review complete --head` with no value, or a value that is not a SHA, is refused", async () => {
  const pkg = await ingest("2026-10-14-cli-complete-head-bad", ["--target", "pr", "--ref", "https://github.com/acme/app/pull/7", "--head", "a".repeat(40)]);
  await reviewCommand(["complete", pkg, "--head"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--head");
  process.exitCode = 0;
  errors = [];
  await reviewCommand(["complete", pkg, "--head", "zzz"], { prLookup: async () => null });
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("not a commit SHA");
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

test("CLI completion refuses a newly ingested package without research and dispatch evidence", async () => {
  await writeFile(path.join(ROOT, "report.md"), reportWith([FINDING]), "utf8");
  await reviewCommand(["ingest", "--report", "report.md", "--ref", "report.md", "--review-id", "cli-pending-research"]);
  expect(process.exitCode).toBe(0);
  const pkg = path.join(ROOT, ".metaproject", "reviews", "cli-pending-research");
  await reviewCommand(["complete", pkg]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("research scope census");
  expect(JSON.parse(await readFile(path.join(pkg, "manifest.json"), "utf8")).status).not.toBe("closed");
  const { dispatch: _dispatch, ...researchOnly } = readyResearchFixture([FINDING.reviewer], [FINDING.id]);
  await writeFile(path.join(pkg, "research.json"), JSON.stringify(researchOnly), "utf8");
  errors = [];
  process.exitCode = 0;
  await reviewCommand(["complete", pkg]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("reviewer dispatch evidence is missing");
  expect(JSON.parse(await readFile(path.join(pkg, "manifest.json"), "utf8")).status).not.toBe("closed");
});

test("closing with no disposition flags still works, and writes nothing", async () => {
  const pkg = await ingest("2026-08-29-cli-plain-complete");
  const before = await readFile(path.join(pkg, "findings.json"), "utf8");
  await reviewCommand(["complete", pkg]);
  expect(process.exitCode).toBe(0);
  expect(await readFile(path.join(pkg, "findings.json"), "utf8")).toBe(before);
});

// The head and merge gate is switched on only by the command's default lookup, so
// these two drive the real default against a stand-in `gh` on PATH.
const GATE_PR = "https://github.com/acme/app/pull/7";
const GATE_HEAD = "a".repeat(40);

async function prBoundPackage(reviewId: string): Promise<string> {
  return ingest(reviewId, ["--target", "pr", "--ref", GATE_PR, "--head", GATE_HEAD]);
}

/** Runs `review complete` in a child whose PATH starts with a stand-in `gh`: Bun resolves `gh` from the PATH it started with. */
async function completeWithStandInGh(pkg: string, script: string): Promise<{ code: number; stderr: string }> {
  const bin = path.join(ROOT, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "gh"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const entry = path.join(ROOT, "complete-child.ts");
  await writeFile(entry, `import { reviewCommand } from ${JSON.stringify(path.resolve(import.meta.dir, "review"))};\nawait reviewCommand(["complete", ${JSON.stringify(pkg)}]);\n`);
  const child = Bun.spawn([process.execPath, "run", entry], {
    cwd: ROOT,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { code, stderr };
}

test("`review complete` on a PR-bound package asks the tracker by default and refuses a merged PR", async () => {
  const pkg = await prBoundPackage("2026-10-14-cli-gate-merged");
  const merged = `{"isDraft":false,"state":"MERGED","headRefOid":"${"b".repeat(40)}","baseRefName":"main"}`;
  const { code, stderr } = await completeWithStandInGh(pkg, `case "$1 $2" in "auth status") exit 0;; "pr view") echo '${merged}';; "pr checks") exit 0;; esac`);
  expect(code).toBe(1);
  expect(stderr).toMatch(/merged/i);
  expect(JSON.parse(await readFile(path.join(pkg, "manifest.json"), "utf8")).status).not.toBe("closed");
});

test("`review complete` prints a warning, and still closes, when the tracker cannot be reached", async () => {
  const pkg = await prBoundPackage("2026-10-14-cli-gate-offline");
  const { code, stderr } = await completeWithStandInGh(pkg, "exit 1");
  expect(code).toBe(0);
  expect(stderr).toContain("warning: could not read the PR state");
  expect(JSON.parse(await readFile(path.join(pkg, "manifest.json"), "utf8")).status).toBe("closed");
});

// ---------------------------------------------------------------------------
// What `complete` says about the package's disposition state
// ---------------------------------------------------------------------------

test("a bare `complete` on a fully dispositioned package does not claim nobody recorded an outcome", async () => {
  // The defect: the "every finding still reads `unknown`" line was printed
  // whenever no --disposition flag was passed, without reading the package. A
  // round is dispositioned across as many closes as it takes, so the second
  // close of a package whose every finding was already recorded was told its
  // outcomes did not exist — a false report of the exact condition this field
  // exists to make visible.
  await writeFile(
    path.join(ROOT, "report.md"),
    reportWith([FINDING, { ...FINDING, id: "F-002", problem: "a second observation" }]),
    "utf8",
  );
  await writeFile(path.join(ROOT, "research.json"), JSON.stringify(readyResearchFixture([FINDING.reviewer], ["F-001", "F-002"])), "utf8");
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    "2026-09-12-cli-all-dispositioned",
    "--research",
    "research.json",
  ]);
  const pkg = path.join(ROOT, ".metaproject", "reviews", "2026-09-12-cli-all-dispositioned");

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
    "acted-on",
    "--evidence",
    "closed by 380bf3b0",
  ]);
  expect(process.exitCode).toBe(0);
  expect((await findingsOf(pkg)).every((f) => f.disposition?.state === "acted-on")).toBe(true);

  logs = [];
  await reviewCommand(["complete", pkg]);
  expect(process.exitCode).toBe(0);

  const output = logs.join("\n");
  expect(output).not.toContain("nobody recorded an outcome");
  expect(output).not.toContain("every finding in this package still reads");
  expect(output).toContain("findings: 2 — 2 with a recorded disposition, 0 still `unknown`");
});

test("a bare `complete` on a package nobody dispositioned still says so", async () => {
  // Non-vacuity. Removing the false claim must not remove the true one.
  const pkg = await ingest("2026-09-12-cli-none-dispositioned");
  logs = [];
  await reviewCommand(["complete", pkg]);
  expect(process.exitCode).toBe(0);

  const output = logs.join("\n");
  expect(output).toContain("findings: 1 — 0 with a recorded disposition, 1 still `unknown`");
  expect(output).toContain("1 of 1 findings read `unknown` — nobody recorded an outcome for them.");
});

test("a partly dispositioned package is reported as partly dispositioned", async () => {
  await writeFile(
    path.join(ROOT, "report.md"),
    reportWith([FINDING, { ...FINDING, id: "F-002", problem: "a second observation" }]),
    "utf8",
  );
  await writeFile(path.join(ROOT, "research.json"), JSON.stringify(readyResearchFixture([FINDING.reviewer], ["F-001", "F-002"])), "utf8");
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    "2026-09-12-cli-partly-dispositioned",
    "--research",
    "research.json",
  ]);
  const pkg = path.join(ROOT, ".metaproject", "reviews", "2026-09-12-cli-partly-dispositioned");

  logs = [];
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

  const output = logs.join("\n");
  expect(output).toContain("findings: 2 — 1 with a recorded disposition, 1 still `unknown`");
  expect(output).toContain("1 of 2 findings read `unknown` — nobody recorded an outcome for them.");
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
  await reviewCommand(["budget", "--reviewers", "a,b,c,d,e,f", "--parallel", "4"]);
  const output = logs.join("\n");

  expect(output).toContain("concurrency_cap: 4");
  expect(output).toContain("reviewers_queued: 2");
  expect(output).toContain("holds_across_nesting: no");
  expect(output).toContain("outstanding_declared: not recorded");
});

test("AC7: a declared outstanding count is the only thing that reaches the nesting", async () => {
  await reviewCommand(["budget", "--reviewers", "a,b,c,d", "--parallel", "4", "--outstanding", "2"]);
  const output = logs.join("\n");

  expect(output).toContain("effective_wave_size: 2");
  expect(output).toContain("holds_across_nesting: yes");
});

test("AC5/AC10: an ingest over the cap truncates and says so on the terminal", async () => {
  const many = Array.from({ length: 14 }, (_, index) => ({
    ...FINDING,
    // Only info notes are capped (owner decision 2026-10-16: minor findings are never dropped).
    severity: "info",
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

// ---------------------------------------------------------------------------
// `keryx review blast-radius`, through the CLI
// ---------------------------------------------------------------------------
//
// The computation is proven in `review/blast-radius.test.ts` and the ingest wire
// in the two tests above. NEITHER touches `runBlastRadius`, and that was
// measured: `throw new Error("MUTATION")` as the first statement of the handler
// left `bun test src/commands src/review src/flow` at 1320 pass / 0 fail across
// 86 files. A hard throw at the top of a shipped command that the entire suite
// cannot see is the same defect shape as a cap that truncates in silence.

/** Run git in the temp repository, with no dependency on the developer's config. */
async function git(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "review-cli-test",
      GIT_AUTHOR_EMAIL: "review-cli-test@example.invalid",
      GIT_COMMITTER_NAME: "review-cli-test",
      GIT_COMMITTER_EMAIL: "review-cli-test@example.invalid",
    },
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`);
  }
}

/** A file node as `keryx gdgraph build` writes it into `storage/nodes.jsonl`. */
function node(file: string): string {
  return JSON.stringify({ id: file, kind: "file", path: file, language: "typescript" });
}

/** An import edge: `from` depends on `to`, so `to`'s dependents are the `from`s. */
function edge(from: string, to: string): string {
  return JSON.stringify({ id: `${from}->${to}`, from, to, kind: "imports", specifier: "./core" });
}

/**
 * A real git repository with a real graph on disk: three files importing one, a
 * co-named test, one commit. `loadGraph` reads exactly these two files, so
 * nothing about the graph is stubbed.
 */
async function repoWithGraph(): Promise<void> {
  const storage = path.join(ROOT, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(storage, { recursive: true });
  await mkdir(path.join(ROOT, "src"), { recursive: true });
  const files = ["src/core.ts", "src/a.ts", "src/b.ts", "src/c.ts", "src/core.test.ts"];
  for (const file of files) {
    await writeFile(path.join(ROOT, file), `export const x = "${file}";\n`, "utf8");
  }
  await writeFile(
    path.join(storage, "nodes.jsonl"),
    `${["src/core.ts", "src/a.ts", "src/b.ts", "src/c.ts"].map(node).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    path.join(storage, "edges.jsonl"),
    `${["src/a.ts", "src/b.ts", "src/c.ts"].map((from) => edge(from, "src/core.ts")).join("\n")}\n`,
    "utf8",
  );
  await git("init", "-q");
  await git("add", "-A");
  await git("commit", "-qm", "seed");
}

test("`review blast-radius` prints the set AND every file the cap removed", async () => {
  await repoWithGraph();

  await reviewCommand(["blast-radius", "--changed", "src/core.ts", "--max-files", "2"]);

  expect(process.exitCode).toBe(0);
  const out = logs.join("\n");
  // Three graph dependents plus the co-named test the repository really has. Flow 457: the test is run, not read, so
  // it is a test-consumer omission on the run list and only the third dependent is cut by the cap.
  expect(out).toContain("candidates: 4");
  expect(out).toContain("retained: 2");
  expect(out).toContain("dropped_by_cap: 1");
  expect(out).toContain("omitted_test_consumer: 1");
  expect(out).toContain("### Dropped — NOT reviewed");
  expect(out).toContain("src/c.ts");
  expect(out).toContain("1 tests exercise the changed code — run them:");
  // AC: the truncation is on the terminal too. A silent one reads afterwards as
  // "we checked everything".
  expect(errors.join("\n")).toContain("recompute: yes");
  expect(errors.join("\n")).toContain("1 of 4 candidate files were NOT reviewed");
});

test("`review blast-radius` takes the changed files from git and writes the record to --out", async () => {
  await repoWithGraph();
  // A real uncommitted edit, read by the command's own `git diff --name-only`.
  await writeFile(path.join(ROOT, "src", "core.ts"), 'export const x = "changed";\n', "utf8");

  await reviewCommand(["blast-radius", "--json", "--out", "radius.json"]);

  expect(process.exitCode).toBe(0);
  const record = JSON.parse(await readFile(path.join(ROOT, "radius.json"), "utf8")) as {
    changedFiles: string[];
    files: { file: string }[];
    counts: { droppedByCap: number };
  };
  expect(record.changedFiles).toEqual(["src/core.ts"]);
  expect(record.files.map((entry) => entry.file).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  expect(record.counts.droppedByCap).toBe(0);
  // Flow 457: the co-named test is on the run list, not in the reviewed set.
  expect((record as { testsToRun?: Array<{ file: string }> }).testsToRun?.map((test) => test.file)).toEqual(["src/core.test.ts"]);
});

test("`review blast-radius` refuses an absent graph rather than reporting an empty radius", async () => {
  // An empty radius reads as "nothing depends on this change", which is a
  // different fact from "the prerequisite never ran".
  await reviewCommand(["blast-radius", "--changed", "src/core.ts", "--no-related-tests"]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("keryx gdgraph build");
});

test("`review blast-radius --previous … --degradation` recomputes from the graph and prints the degradation payload (flow 479 ARCH-001)", async () => {
  await repoWithGraph();
  await reviewCommand(["blast-radius", "--changed", "src/core.ts", "--json", "--out", "prev.json"]);
  expect(process.exitCode).toBe(0);
  logs = [];
  errors = [];

  await reviewCommand(["blast-radius", "--changed", "src/core.ts", "--previous", "prev.json", "--degradation"]);

  expect(process.exitCode).toBe(0);
  expect(errors.join("\n")).toContain("recompute: yes — the degradation payload needs the graph");
  expect(logs.join("\n").startsWith("SCOPE: degradation")).toBe(true);
  expect(logs.join("\n")).not.toContain("scope: blast-radius");
});

test("`review blast-radius --degradation` is refused with --json, --brief or --out, and --degradation-cap needs --degradation; nothing is written", async () => {
  await repoWithGraph();
  for (const clash of [["--json"], ["--brief"], ["--out", "radius.json"]]) {
    process.exitCode = 0;
    errors = [];
    logs = [];
    await reviewCommand(["blast-radius", "--changed", "src/core.ts", "--degradation", ...clash]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain(`cannot be combined with ${clash[0]}`);
    expect(logs).toEqual([]);
  }
  expect(await readFile(path.join(ROOT, "radius.json"), "utf8").catch(() => "absent")).toBe("absent");

  process.exitCode = 0;
  errors = [];
  logs = [];
  await reviewCommand(["blast-radius", "--changed", "src/core.ts", "--degradation-cap", "5"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--degradation-cap only applies together with --degradation");
  expect(logs).toEqual([]);
});

// ---------------------------------------------------------------------------
// `keryx review tier` — the model block, computed rather than reasoned about
// ---------------------------------------------------------------------------
//
// `assignTier`/`decideDispatchModel` had no production caller: the rule said the
// caller was "an orchestrator authoring a dispatch document", i.e. an LLM agent
// following prose, and an agent cannot call a TypeScript function. These tests
// drive `reviewCommand(["tier", …])` with real argv for that reason — a test
// that calls `assignTier` directly is exactly what could not see the gap.
//
// The catalogue is synthetic and vendor-neutral on purpose: the size-word hints
// are the only knowledge in the resolver, so `demo-large`/`demo-medium`/
// `demo-mini` exercise them without this file naming a model that exists.

const CATALOG = JSON.stringify([{ name: "demo", models: ["demo-large", "demo-medium", "demo-mini"] }]);

async function tier(...extra: string[]): Promise<void> {
  await writeFile(path.join(ROOT, "catalog.json"), CATALOG, "utf8");
  await reviewCommand([
    "tier",
    "--session-provider",
    "demo",
    "--session-model",
    "demo-medium",
    "--catalog",
    "catalog.json",
    ...extra,
  ]);
}

/** The `{"model": …}` document `--json` prints. */
function modelBlock(): Record<string, unknown> {
  return (JSON.parse(logs.join("\n")) as { model: Record<string, unknown> }).model;
}

async function configureUserRouting(user: RoutingConfigLayer): Promise<void> {
  await replaceRoutingLayer("user", { cwd: ROOT }, user);
}

async function tierRouted(...extra: string[]): Promise<void> {
  await setModelProfileField("ollama", "llama3.1:latest", { field: "contextLength", value: 100_000 });
  await setModelProfileField("ollama", "llama3.2", { field: "contextLength", value: 100_000 });
  await writeFile(path.join(ROOT, "catalog.json"), JSON.stringify([
    { name: "ollama", models: ["llama3.1:latest", "llama3.2"] },
  ]), "utf8");
  await reviewCommand([
    "tier",
    "--session-provider", "ollama",
    "--session-model", "llama3.1:latest",
    "--catalog", "catalog.json",
    ...extra,
  ]);
}

test("`review tier` floors a blast-radius round at deep and names the rule that did it", async () => {
  // A blast-radius round over a twelve-line diff is still a blast-radius round:
  // the floor is applied AFTER the small-scope downgrade.
  await tier("--scope", "blast-radius", "--findings", "1", "--diff-lines", "12");

  expect(process.exitCode).toBe(0);
  const out = logs.join("\n");
  expect(out).toContain("tier: deep");
  expect(out).toContain("light:small-scope");
  expect(out).toContain("floor:blast-radius");
  // The tier is a report: without a routable credential routing authorizes no target.
  expect(out).toContain("model: none — routing did not authorize a dispatch target");
});

test("`review tier --premise` gives the review-premise judge the deep tier, even over a light verifier method", async () => {
  await tier("--premise", "--verifier", "execution", "--findings", "1", "--diff-lines", "5", "--json");

  expect(process.exitCode).toBe(0);
  const model = modelBlock();
  expect(model.tier).toBe("deep");
  expect(model.tier_reasons).toContain("floor:premise-judge");
});

test("`review tier --json` prints the model block a dispatch document carries", async () => {
  await tier("--findings", "2", "--diff-lines", "20", "--json");

  expect(process.exitCode).toBe(0);
  const model = modelBlock();
  expect(model.tier).toBe("light");
  expect(model.tier_reasons).toEqual(expect.arrayContaining(["base:standard", "light:small-scope"]));
  // The relative tier never ranks candidates; only a routing receipt selects a target.
  expect(model.dispatchable).toBe(false);
  expect(model.provider).toBeUndefined();
  expect(JSON.parse(logs.join("\n")).routing.decision.status).toBe("blocked");
});

test("the routing review category is the canonical selection, not the relative tier", async () => {
  await configureUserRouting({
    schemaVersion: 2,
    categories: { review: { mode: "model", target: { providerId: "ollama", modelId: "llama3.2" } } },
  });
  await tierRouted("--findings", "2", "--diff-lines", "20", "--json");

  expect(process.exitCode).toBe(0);
  const parsed = JSON.parse(logs.join("\n")) as {
    model: Record<string, unknown>;
    routing: { decision: { status: string; assignmentSource: string; selection: { providerId: string; modelId: string } } };
  };
  expect(parsed.model).toMatchObject({
    provider: "ollama",
    model: "llama3.2",
    routed: true,
    model_discovery: { candidates: [] },
  });
  expect(parsed.routing.decision).toMatchObject({
    status: "selected",
    assignmentSource: "user",
    selection: { providerId: "ollama", modelId: "llama3.2" },
  });
});

test("routing review reports an unauthorized target without dispatching or failing the total tier query", async () => {
  await configureUserRouting({
    schemaVersion: 2,
    categories: { review: { mode: "model", target: { providerId: "other", modelId: "unlisted" } } },
  });
  await tierRouted("--findings", "2", "--diff-lines", "20", "--json");

  expect(process.exitCode).toBe(0);
  expect(errors).toEqual([]);
  const parsed = JSON.parse(logs.join("\n")) as {
    model: Record<string, unknown>;
    routing: { decision: { status: string; reason: string } };
    notices: string[];
  };
  expect(parsed.routing.decision).toMatchObject({ status: "blocked", reason: "candidate-unverified" });
  expect(parsed.model).toMatchObject({ routed: false, dispatchable: false });
  expect(parsed.model).not.toHaveProperty("provider");
  expect(parsed.model).not.toHaveProperty("model");
  expect(parsed.model).not.toHaveProperty("inherit");
  expect(parsed.notices.join("\n")).toContain("no dispatch target was selected");
});

test("`review tier` never runs a security finding below standard, even when verified by execution", async () => {
  await tier("--verifier", "execution", "--security", "--json");

  const model = modelBlock();
  expect(model.tier).toBe("standard");
  expect(model.tier_reasons).toEqual(expect.arrayContaining(["base:standard", "light:verifier-execution", "floor:security"]));
});

test("`review tier` refuses an unrecognised --verifier rather than silently defaulting", async () => {
  await tier("--verifier", "exection");

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--verifier");
  expect(errors.join("\n")).toContain("site-check");
});

test("`review tier` refuses a hand-written tier", async () => {
  // There is no `--tier`: the tier is COMPUTED from the signals. Accepting one
  // would put the arithmetic back in the caller's head, which is the defect.
  await reviewCommand(["tier", "--tier", "deep"]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--tier");
});

test("`review tier` names --catalog when the file is not JSON", async () => {
  // The two guards below this one — "not an array" and "an entry with no name" —
  // were written; the read and the parse were not. So the two likeliest operator
  // mistakes came out as a bare `JSON Parse error: Unexpected identifier "not"`,
  // which names neither the flag nor the file that carries it.
  await writeFile(path.join(ROOT, "bad.json"), "not json", "utf8");
  await reviewCommand(["tier", "--session-provider", "demo", "--session-model", "demo-medium", "--catalog", "bad.json"]);

  expect(process.exitCode).toBe(1);
  const out = errors.join("\n");
  expect(out).toContain("--catalog");
  expect(out).toContain("bad.json");
  expect(out).toContain("not valid JSON");
  expect(out).toContain('[{"name": "<provider>", "models": ["<id>", …]}]');
});

test("`review tier` names --catalog when the file is not there", async () => {
  await reviewCommand([
    "tier",
    "--session-provider",
    "demo",
    "--session-model",
    "demo-medium",
    "--catalog",
    "nope.json",
  ]);

  expect(process.exitCode).toBe(1);
  const out = errors.join("\n");
  expect(out).toContain("--catalog");
  expect(out).toContain("nope.json");
  expect(out).toContain("could not be read");
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

// R1-F3 (review round 1, PR #691, major): `review learn --reviewer <id>
// --dry-run=1` used to read as `args.includes("--dry-run")` — false for the
// `=value` spelling — so a request for a DRY RUN silently wrote the real
// `.mdc` file. `parseLearnArgs` (shared with `keryx learn`'s own flag
// parsing) refuses the malformed spelling instead of misreading it; nothing
// is written either way, dry run or not.
test("`review learn --reviewer <id> --dry-run=1` is refused, not silently treated as a real (non-dry-run) write", async () => {
  await reviewCommand(["learn", "--reviewer", "rv-0123456789abcdef", "--dry-run=1"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--dry-run=1");
  // Never reached `applyReviewerProfile` — no `.mdc` file exists anywhere
  // under `.metaproject/rules/reviewers/` (the directory itself is never
  // created either, since the write path is never entered).
  await expect(readFile(path.join(ROOT, ".metaproject", "rules", "reviewers", "rv-0123456789abcdef.mdc"), "utf8")).rejects.toBeTruthy();
});

// R3-F4 (review round 3, PR #691, minor): the finding lists these among the
// missing regression tests — `keryx review learn`'s OWN `--pr` path parsing
// (not just `--reviewer`'s) had no test for `--dry-run=1`, and neither
// `--reviewer` mode had a test for a repeated or empty `--reviewer`.
test("`review learn --pr <n> --dry-run=1` is refused on the --pr path too, not just --reviewer", async () => {
  await reviewCommand(["learn", "--pr", "3", "--dry-run=1"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--dry-run=1");
});

test("`review learn --reviewer` given twice is refused, never applying either value", async () => {
  await reviewCommand(["learn", "--reviewer", "rv-aaaaaaaaaaaaaaaa", "--reviewer", "rv-bbbbbbbbbbbbbbbb", "--dry-run"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("more than once");
  await expect(readFile(path.join(ROOT, ".metaproject", "rules", "reviewers", "rv-aaaaaaaaaaaaaaaa.mdc"), "utf8")).rejects.toBeTruthy();
  await expect(readFile(path.join(ROOT, ".metaproject", "rules", "reviewers", "rv-bbbbbbbbbbbbbbbb.mdc"), "utf8")).rejects.toBeTruthy();
});

test("`review learn --reviewer=` (empty value) is refused, not silently falling through to the --pr path", async () => {
  await reviewCommand(["learn", "--reviewer=", "--dry-run"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("needs a value");
});

// Flow 347 T9, AC7: `.metaproject` in ROOT here has no `skills/gdskills/review`
// (only the bare directory `beforeEach` creates), the exact shape a review
// worktree that never ran a full `skills install` has — `data/`/`reviews/`
// only. Before this fix `reviewers`/`reviewers --json` silently reported
// `bundled: []`, which an agent read as "no reviewers exist" and skipped
// required review passes.
test("`review reviewers` falls back to the keryx package's bundled review skills when the project never installed any, and says so", async () => {
  await reviewCommand(["reviewers"]);
  expect(process.exitCode).toBe(0);
  const output = logs.join("\n");
  expect(output).toContain("source: package");
  expect(output).toContain("review-orchestrator");
  expect(output).not.toBe("");
});

test("`review reviewers --json` reports bundledSource and a non-empty bundled list from the package fallback", async () => {
  await reviewCommand(["reviewers", "--json"]);
  expect(process.exitCode).toBe(0);
  const parsed = JSON.parse(logs.join("\n"));
  expect(parsed.bundledSource).toBe("package");
  expect(Array.isArray(parsed.bundled)).toBe(true);
  expect(parsed.bundled.length).toBeGreaterThan(0);
  expect(parsed.bundled.map((reviewer: { name: string }) => reviewer.name)).toContain("review-orchestrator");
});

test("`review reviewers` reports `project` as the source once the project's own review directory is installed, even if empty", async () => {
  await mkdir(path.join(ROOT, ".metaproject", "skills", "gdskills", "review"), { recursive: true });

  await reviewCommand(["reviewers", "--json"]);
  expect(process.exitCode).toBe(0);
  const parsed = JSON.parse(logs.join("\n"));
  expect(parsed.bundledSource).toBe("project");
  expect(parsed.bundled).toEqual([]);
});

// Flow 347 T15 / F-004: the only prior `not-found` coverage exercised the pure
// renderer (`reviewers.test.ts`), so neither the fail-closed `process.exitCode
// = 1` nor the `--json` shape of a `not-found` inventory was ever driven
// through the command itself — the exact exit the incident needs to hold so
// an agent reading "no reviewers" cannot mistake it for success. `runReviewers`
// takes the package lookup as an injectable dependency (flow 347 T15) purely
// so this can force the real fallback-to-nothing path without deleting files
// out of the keryx package the rest of the suite depends on.
test("`review reviewers` exits 1 on a `not-found` bundled source, in text mode", async () => {
  await runReviewers([], { bundledSkillMarkdownPath: () => undefined });
  expect(process.exitCode).toBe(1);
  const output = logs.join("\n");
  expect(output).toContain("source: not-found");
  expect(output).toContain("not found");
});

test("`review reviewers --json` exits 1 and reports `bundledSource: \"not-found\"`", async () => {
  await runReviewers(["--json"], { bundledSkillMarkdownPath: () => undefined });
  expect(process.exitCode).toBe(1);
  const parsed = JSON.parse(logs.join("\n"));
  expect(parsed.bundledSource).toBe("not-found");
  expect(parsed.bundled).toEqual([]);
});

// ---------------------------------------------------------------------------
// Slice, dispatch-check, retry-plan (flow 418, AC7/AC8/AC9)
// ---------------------------------------------------------------------------

function sliceGitFile(filePath: string, count: number): string {
  const lines = Array.from({ length: count }, (_, n) => `+export const v${n} = ${n};`);
  return `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1,0 +1,${count} @@\n${lines.join("\n")}\n`;
}

test("`review slice --help` prints usage and writes nothing", async () => {
  await reviewCommand(["slice", "--help"]);
  expect(process.exitCode).toBe(0);
  const out = logs.join("\n");
  expect(out).toContain("keryx review slice");
  expect(out).toContain("--max-bytes");
});

test("`review slice` writes bounded slices and a manifest, and omits a csv ledger by name", async () => {
  const csv = Array.from({ length: 6000 }, () => "+2026-10-01,acct-000123,debit,19.99,EUR,settled").join("\n");
  const diff =
    sliceGitFile("src/alpha/a.ts", 400) +
    sliceGitFile("src/beta/b.ts", 400) +
    `diff --git a/data/ledger.csv b/data/ledger.csv\n--- a/data/ledger.csv\n+++ b/data/ledger.csv\n@@ -1,0 +1,6000 @@\n${csv}\n`;
  await writeFile(path.join(ROOT, "change.diff"), diff, "utf8");

  await reviewCommand(["slice", "--diff", "change.diff", "--max-bytes", "9000", "--out", "out", "--json"]);
  expect(process.exitCode).toBe(0);
  const printed = JSON.parse(logs.join("\n"));
  expect(printed.omissions.map((o: { path: string }) => o.path)).toEqual(["data/ledger.csv"]);
  expect(printed.omissions[0].reason).toBe("data-ledger");
  expect(printed.slices.length).toBeGreaterThan(2);

  const manifest = JSON.parse(await readFile(path.join(ROOT, "out", "manifest.json"), "utf8"));
  for (const slice of manifest.slices) {
    const text = await readFile(path.join(ROOT, "out", slice.path), "utf8");
    expect(Buffer.byteLength(text)).toBe(slice.bytes);
    expect(slice.bytes).toBeLessThanOrEqual(9000);
  }
});

test("`review slice` refuses an unknown flag and a ceiling below the minimum", async () => {
  await reviewCommand(["slice", "--nope"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--nope");

  errors = [];
  process.exitCode = 0;
  await writeFile(path.join(ROOT, "empty.diff"), "", "utf8");
  await reviewCommand(["slice", "--diff", "empty.diff", "--max-bytes", "5"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--max-bytes");
});

test("`review dispatch-check` refuses a diff payload with no slice and exits 1", async () => {
  const payload = {
    review_context: {
      request: { raw: "review" },
      scope: { mode: "diff", files: ["src/a.ts"] },
      routing: { selected_reviewers: ["review-logic"] },
      token_policy: { context_mode: "light", omissions: [] },
    },
    reviewer: "review-logic",
    scope_mode: "diff",
    model: { tier: "standard", tier_reasons: ["base"], tier_resolution: "session-fallback", model_discovery: {}, inherit: true },
    budget: { max_findings: 10 },
  };
  await writeFile(path.join(ROOT, "payload.json"), JSON.stringify(payload), "utf8");
  await reviewCommand(["dispatch-check", "--payload", "payload.json", "--json"]);
  expect(process.exitCode).toBe(1);
  expect(JSON.parse(logs.join("\n")).errors[0].code).toBe("REVIEWER_INPUT_NO_SLICE");

  logs = [];
  process.exitCode = 0;
  await reviewCommand(["dispatch-check", "--payload", "missing.json"]);
  expect(process.exitCode).toBe(2);
});

test("`review retry-plan` retries once on smaller slices, then reports Not run", async () => {
  await writeFile(path.join(ROOT, "change.diff"), Array.from({ length: 4 }, (_, i) => sliceGitFile(`src/m/f${i}.ts`, 80)).join(""), "utf8");
  await reviewCommand(["slice", "--diff", "change.diff", "--max-bytes", "30000", "--out", "out"]);
  await writeFile(path.join(ROOT, "result.json"), JSON.stringify({ reviewer: "review-logic", status: "INCOMPLETE" }), "utf8");
  logs = [];

  await reviewCommand(["retry-plan", "--manifest", "out/manifest.json", "--result", "result.json", "--json"]);
  expect(process.exitCode).toBe(0);
  const first = JSON.parse(logs.join("\n"));
  expect(first.decision).toBe("retry");
  expect(first.dispatch.length).toBeGreaterThan(1);
  const retried = JSON.parse(await readFile(path.join(ROOT, "out", "manifest.json"), "utf8"));
  expect(retried.slices.some((s: { id: string }) => s.id.startsWith("r1-review-logic-"))).toBe(true);

  logs = [];
  await reviewCommand(["retry-plan", "--manifest", "out/manifest.json", "--result", "result.json", "--json"]);
  const second = JSON.parse(logs.join("\n"));
  expect(second.decision).toBe("not-run");
  expect(second.reportLine).toContain("- **Not run:** review-logic");
  expect(second.dispatch).toEqual([]);
});

test("`review slice --wave-bytes` records the wave budget and refuses one below the slice ceiling", async () => {
  await writeFile(path.join(ROOT, "change.diff"), Array.from({ length: 6 }, (_, i) => sliceGitFile(`src/w${i}/f.ts`, 120)).join(""), "utf8");
  await reviewCommand(["slice", "--diff", "change.diff", "--max-bytes", "4000", "--wave-bytes", "9000", "--out", "out", "--json"]);
  expect(process.exitCode).toBe(0);
  expect(JSON.parse(logs.join("\n")).waveBytes).toBe(9000);

  errors = [];
  process.exitCode = 0;
  await reviewCommand(["slice", "--diff", "change.diff", "--max-bytes", "4000", "--wave-bytes", "3000", "--out", "out2"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--wave-bytes");
});

test("`review retry-plan --next-wave` hands out bounded waves without a result, and progress costs no attempt", async () => {
  await writeFile(path.join(ROOT, "change.diff"), Array.from({ length: 6 }, (_, i) => sliceGitFile(`src/w${i}/f.ts`, 120)).join(""), "utf8");
  await reviewCommand(["slice", "--diff", "change.diff", "--max-bytes", "4000", "--wave-bytes", "9000", "--out", "out"]);
  const manifest = JSON.parse(await readFile(path.join(ROOT, "out", "manifest.json"), "utf8"));
  const ids: string[] = manifest.slices.map((s: { id: string }) => s.id);

  logs = [];
  await reviewCommand(["retry-plan", "--manifest", "out/manifest.json", "--reviewer", "review-logic", "--next-wave", "--json"]);
  expect(process.exitCode).toBe(0);
  const first = JSON.parse(logs.join("\n"));
  expect(first.decision).toBe("wave");
  expect(first.dispatch.length).toBeGreaterThan(0);
  expect(first.dispatch.reduce((sum: number, d: { bytes: number }) => sum + d.bytes, 0)).toBeLessThanOrEqual(9000);
  expect(first.remaining.slices).toBe(ids.length);

  for (let round = 1; round <= 2; round += 1) {
    const state = JSON.parse(await readFile(path.join(ROOT, "out", "retry-state.json"), "utf8"));
    const done: string[] = state.reviewers["review-logic"].covered ?? [];
    const next = ids.filter((id) => !done.includes(id)).slice(0, 2);
    await writeFile(path.join(ROOT, "result.json"), JSON.stringify({ reviewer: "review-logic", status: "INCOMPLETE", slices: next }), "utf8");
    logs = [];
    await reviewCommand(["retry-plan", "--manifest", "out/manifest.json", "--result", "result.json", "--json"]);
    const plan = JSON.parse(logs.join("\n"));
    expect(plan.progress).toBe(true);
    expect(plan.stalls).toBe(0);
    expect(plan.decision).toBe("retry");
  }
});

test("`review retry-plan` reads a saved raw reply carrying a REVIEW_RESULT block", async () => {
  await writeFile(path.join(ROOT, "change.diff"), Array.from({ length: 4 }, (_, i) => sliceGitFile(`src/m/f${i}.ts`, 80)).join(""), "utf8");
  await reviewCommand(["slice", "--diff", "change.diff", "--max-bytes", "30000", "--out", "out"]);
  await writeFile(path.join(ROOT, "raw.txt"), 'findings below\n\n```json\n{"reviewer":"review-logic","status":"DONE","slices":["slice-01"]}\n```\n', "utf8");
  logs = [];
  await reviewCommand(["retry-plan", "--manifest", "out/manifest.json", "--result", "raw.txt", "--json"]);
  expect(process.exitCode).toBe(0);
  expect(JSON.parse(logs.join("\n")).reviewer).toBe("review-logic");
});

test("flow 429: --automatic is recorded on the manifest, printed on create and shown by status; absent otherwise", async () => {
  const plain = await ingest("plain-round");
  expect(JSON.parse(await readFile(path.join(plain, "manifest.json"), "utf8")).automatic).toBeUndefined();
  expect(logs.join("\n")).not.toContain("run mode: automatic review");

  logs = [];
  const marked = await ingest("auto-round", ["--automatic"]);
  expect(JSON.parse(await readFile(path.join(marked, "manifest.json"), "utf8")).automatic).toBe(true);
  expect(logs.join("\n")).toContain("run mode: automatic review");

  logs = [];
  await reviewCommand(["status", "auto-round"]);
  expect(logs.join("\n")).toContain("run mode: automatic review");
  logs = [];
  await reviewCommand(["status", "plain-round"]);
  expect(logs.join("\n")).not.toContain("run mode: automatic review");
});

test("review tier preserves project trust notices in JSON and text", async () => {
  await replaceRoutingLayer("project", { cwd: ROOT }, {
    schemaVersion: 2,
    categories: { review: { mode: "model", target: { providerId: "other", modelId: "unapproved" } } },
  });
  await tierRouted("--json");
  const parsed = JSON.parse(logs.join("\n"));
  expect(parsed.notices.join("\n")).toContain("keryx routing trust");
  expect(parsed.routing.decision.selection).not.toEqual({ providerId: "other", modelId: "unapproved" });
  logs.length = 0;
  errors.length = 0;
  await tierRouted();
  expect(errors.join("\n")).toContain("keryx routing trust");
});
