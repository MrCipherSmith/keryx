// `filter_stats` (flow 207, AC1-AC3).
//
// Every test in the first half drives the REAL ingest — `createManagedReviewPackage`
// or `reviewCommand`, writing a real package to a real temp directory — and reads
// the record back off disk. A test over a hand-built `ReviewFilterStats` cannot
// see a missing producer: it would have stayed green through the entire release
// in which `filter_stats` did not exist, which is exactly the shape of the
// `attempts.count` defect this flow exists to stop repeating.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { createManagedReviewPackage, upsertPreFilterScopeBlock, type ManagedReviewIngestInput } from "./managed";
import { buildFilterStats, checkFilterStats, renderFilterStatsLine, type ReviewFilterStats } from "./filter-stats";
import type { ManagedReviewManifest, StructuredReviewFinding } from "./types";

const ORIGINAL_CWD = process.cwd();
let ROOT = "";
let logs: string[] = [];
let errors: string[] = [];
const realLog = console.log;
const realError = console.error;

beforeEach(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "gd-filter-stats-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  // The committed schema, so `filter_stats` is validated by the real contract
  // rather than by a permissive stub — a manifest property the schema rejects
  // would make every ingest throw, and this is where that is noticed.
  await mkdir(path.join(ROOT, "docs", "requirements", "managed-review-feedback-loop", "schemas"), { recursive: true });
  await writeFile(
    path.join(ROOT, "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json"),
    await readFile(
      path.join(
        ORIGINAL_CWD,
        "docs",
        "requirements",
        "managed-review-feedback-loop",
        "schemas",
        "managed-review-package.schema.json",
      ),
      "utf8",
    ),
    "utf8",
  );
  logs = [];
  errors = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  process.exitCode = 0;
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

const FINDING: StructuredReviewFinding = {
  id: "F-001",
  reviewer: "review-security-code",
  severity: "minor",
  problem: "the guard asserts on a synthetic context",
  impact: "the guard passes when the production path is unwired",
  suggested_fix: "drive the writer the CLI drives",
  evidence: "deleted the guarded line; the test stayed green",
  confidence: "high",
};

async function ingest(reviewId: string, over: Partial<ManagedReviewIngestInput> = {}): Promise<{
  path: string;
  manifest: ManagedReviewManifest;
  stats: ReviewFilterStats;
  scope: string;
}> {
  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "ingest",
    reviewId,
    target: { kind: "report", ref: "review.md" },
    reportText: "# Round\n\nno machine-readable block here\n",
    findings: [FINDING],
    now: new Date("2026-08-30T11:00:00Z"),
    ...over,
  });
  return {
    path: result.path,
    manifest: JSON.parse(await readFile(path.join(ROOT, result.path, "manifest.json"), "utf8")) as ManagedReviewManifest,
    stats: result.filterStats,
    scope: await readFile(path.join(ROOT, result.path, "scope.md"), "utf8"),
  };
}

// ---------------------------------------------------------------------------
// AC1: the producer writes it, into the round's structured output
// ---------------------------------------------------------------------------

test("AC1: an ordinary ingest writes filter_stats into the manifest on disk", async () => {
  const { manifest } = await ingest("2026-08-30-stats-written");

  // Off disk, not off the return value: the point is that the RECORD carries it.
  const stats = manifest.filter_stats;
  expect(stats).toBeDefined();
  expect(stats?.schema_version).toBe(1);
  // The five names the roadmap specifies, verbatim, plus the pipeline's own two
  // extra finding stages.
  expect(Object.keys(stats ?? {}).sort()).toEqual([
    "by_reason",
    "dismissed_by_round",
    "dropped_findings_cap",
    "dropped_low_confidence",
    "dropped_prefilter",
    "dropped_refuted",
    "dropped_scope_b",
    "not_measured",
    "retained",
    "schema_version",
    "total",
  ]);
  expect(stats?.total).toBe(1);
  expect(stats?.retained).toBe(1);
});

test("AC1: the counts come from the stages, not from re-parsing scope.md", async () => {
  // Two reviewers, eleven findings from one of them with a cap of 2, so three
  // separate stages have something to say and only a producer wired to the real
  // results can get all three right.
  const many: StructuredReviewFinding[] = Array.from({ length: 5 }, (_, index) => ({
    ...FINDING,
    id: `F-${String(index + 1).padStart(3, "0")}`,
  }));

  const { manifest } = await ingest("2026-08-30-stats-from-stages", {
    findings: many,
    maxFindingsPerReviewer: 2,
    scope: {
      drops: [
        { path: "bun.lock", reason: "lockfile", detail: "lockfile", granularity: "file", changedLines: 4 },
        { path: "src/g.ts", reason: "generated", detail: "generated header", granularity: "file", changedLines: 9 },
      ],
      counts: {
        filesSeen: 5,
        filesRetained: 3,
        filesDropped: 2,
        blocksSeen: 7,
        blocksRetained: 7,
        blocksDropped: 0,
        changedLinesRetained: 40,
        changedLinesDropped: 13,
      },
    },
  });

  const stats = manifest.filter_stats;
  expect(stats?.total).toBe(5);
  expect(stats?.dropped_findings_cap).toBe(3);
  expect(stats?.retained).toBe(2);
  expect(stats?.dropped_prefilter).toBe(2);
  expect(stats?.by_reason).toEqual({
    "prefilter:lockfile": 1,
    "prefilter:generated": 1,
    "findings_cap:review-security-code": 3,
  });
  // And it holds together, checked by the same function `review status` runs.
  expect(checkFilterStats(stats)).toEqual([]);
});

test("AC1: the verifier's removals land in filter_stats through the real merge", async () => {
  const { manifest } = await ingest("2026-08-30-stats-refuted", {
    findings: [FINDING, { ...FINDING, id: "F-002" }],
    verificationMode: "filter",
    verifications: [
      {
        finding: "F-002",
        verdict: "refuted",
        method: "execution",
        evidence: "ran the guard under the production path; it fails as claimed",
        verifier: "review-verifier",
      },
    ],
  });

  const stats = manifest.filter_stats;
  expect(stats?.total).toBe(2);
  expect(stats?.dropped_refuted).toBe(1);
  expect(stats?.retained).toBe(1);
  expect(stats?.by_reason["refuted:verifier-refuted"]).toBe(1);
  expect(checkFilterStats(stats)).toEqual([]);
});

// ---------------------------------------------------------------------------
// AC2: measured zero is not the same as not measured — BOTH directions
// ---------------------------------------------------------------------------

test("AC2: a stage that did not run records null with a reason, in the artifact", async () => {
  const { manifest, scope } = await ingest("2026-08-30-stats-unmeasured");
  const stats = manifest.filter_stats;

  // No `--scope` was supplied, so the pre-filter did not run. `null`, never `0`.
  expect(stats?.dropped_prefilter).toBeNull();
  expect(stats?.not_measured.find((row) => row.stage === "prefilter")?.reason).toContain("NOT `dropped 0`");
  // No blast-radius record reached the ingest, so the scope-B screen did not run.
  expect(stats?.dropped_scope_b).toBeNull();
  expect(stats?.not_measured.map((row) => row.stage).sort()).toEqual([
    "low_confidence",
    "prefilter",
    "round_dismissed",
    "scope_b",
  ]);
  // And the human copy in scope.md says the same, in the same words.
  expect(scope).toContain("dropped_prefilter: null —");
  expect(scope).toContain("`null` means the stage did not run. It never means `0`.");
});

test("AC2: a stage that ran and dropped nothing records 0, not null", async () => {
  const { manifest } = await ingest("2026-08-30-stats-measured-zero", {
    // A pre-filter that ran over a clean diff: drop rows are an empty ARRAY,
    // which is a different input from no scope at all.
    scope: {
      drops: [],
      counts: {
        filesSeen: 3,
        filesRetained: 3,
        filesDropped: 0,
        blocksSeen: 4,
        blocksRetained: 4,
        blocksDropped: 0,
        changedLinesRetained: 22,
        changedLinesDropped: 0,
      },
    },
    // A `--refuted` channel that carried nothing: the round DID record its
    // dismissals, and there were none.
    refuted: [],
    // A blast-radius record with no scope-B findings: the screen ran over an
    // empty set, which is not the same fact as the screen not running.
    blastRadius: {
      files: [
        { file: "src/a.ts", hop: 1, fanIn: 0, via: "src/b.ts", path: ["src/a.ts", "src/b.ts"], source: "graph", isTest: false },
      ],
      changedFiles: ["src/a.ts"],
    },
  });

  const stats = manifest.filter_stats;
  expect(stats?.dropped_prefilter).toBe(0);
  expect(stats?.dismissed_by_round).toBe(0);
  expect(stats?.dropped_scope_b).toBe(0);
  // The whole point: none of the three is null, and none of them appears in
  // `not_measured`.
  expect(stats?.not_measured.map((row) => row.stage)).toEqual(["low_confidence"]);
  // The two directions, side by side, in one assertion: the SAME field reads 0
  // here and null in the test above, from the same producer.
  expect(stats?.dropped_prefilter).not.toBeNull();
});

test("AC2: a carried-forward pre-filter block is `null`, not the counts it does not carry", async () => {
  // The block written by `keryx review scope --append` is prose. Counting it
  // would mean re-deriving the record from a renderer's output, which is what
  // AC1 forbids — so the count stays null and the reason says where the numbers
  // are.
  const first = await ingest("2026-08-30-stats-carried", {
    scope: {
      drops: [{ path: "bun.lock", reason: "lockfile", detail: "lockfile", granularity: "file", changedLines: 4 }],
      counts: {
        filesSeen: 2,
        filesRetained: 1,
        filesDropped: 1,
        blocksSeen: 1,
        blocksRetained: 1,
        blocksDropped: 0,
        changedLinesRetained: 4,
        changedLinesDropped: 4,
      },
    },
  });
  expect(first.manifest.filter_stats?.dropped_prefilter).toBe(1);

  // What `keryx review scope --append <package>/scope.md` leaves behind at Step
  // 3 of the orchestrator's script, written the way that command writes it.
  const scopePath = path.join(ROOT, first.path, "scope.md");
  await writeFile(
    scopePath,
    upsertPreFilterScopeBlock(
      await readFile(scopePath, "utf8"),
      "## Pre-filter scope\n\n### Dropped by the pre-filter\n\n| path | reason |\n|---|---|\n| bun.lock | lockfile |\n",
    ),
    "utf8",
  );

  // Re-ingest the same package id with no `--scope`: the block is carried.
  const again = await ingest("2026-08-30-stats-carried");
  expect(again.scope).toContain("## Pre-filter scope");
  expect(again.manifest.filter_stats?.dropped_prefilter).toBeNull();
  expect(again.manifest.filter_stats?.not_measured.find((row) => row.stage === "prefilter")?.reason).toContain(
    "not assembled from prose",
  );
});

test("AC2: `dropped_low_confidence` is null because this pipeline has no such stage", async () => {
  const { manifest } = await ingest("2026-08-30-stats-low-confidence");
  const stats = manifest.filter_stats;
  expect(stats?.dropped_low_confidence).toBeNull();
  expect(stats?.not_measured.find((row) => row.stage === "low_confidence")?.reason).toContain(
    "no confidence threshold",
  );
});

// ---------------------------------------------------------------------------
// AC3: it has a consumer — one that reports it, checks it, and refuses on it
// ---------------------------------------------------------------------------

test("AC3: `keryx review status` reads filter_stats back off disk and reports it", async () => {
  process.chdir(ROOT);
  await ingest("2026-08-30-stats-status");
  logs = [];

  await reviewCommand(["status", "2026-08-30-stats-status"]);

  const printed = logs.join("\n");
  expect(printed).toContain("filter_stats: total=1");
  // `not-measured` on the terminal too. `0` here would be the failure AC2 names.
  expect(printed).toContain("prefilter=not-measured");
  expect(printed).toContain("prefilter: not measured —");
  expect(process.exitCode).toBe(0);
});

test("AC3: `review status` REFUSES a filter_stats whose arithmetic does not hold", async () => {
  // The refusal is what makes the consumer more than decoration. A stage that
  // starts removing findings without counting them fails here, on the next
  // status call, instead of being discovered a release later.
  process.chdir(ROOT);
  const { path: pkg } = await ingest("2026-08-30-stats-broken");
  const manifestPath = path.join(ROOT, pkg, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManagedReviewManifest;
  (manifest.filter_stats as ReviewFilterStats).retained = 0;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  logs = [];
  errors = [];

  await reviewCommand(["status", "2026-08-30-stats-broken"]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("filter_stats does not add up");
});

test("AC3: `review status` refuses a count that is null with no stated reason", async () => {
  process.chdir(ROOT);
  const { path: pkg } = await ingest("2026-08-30-stats-silent-null");
  const manifestPath = path.join(ROOT, pkg, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManagedReviewManifest;
  const stats = manifest.filter_stats as ReviewFilterStats;
  stats.not_measured = stats.not_measured.filter((row) => row.stage !== "prefilter");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  errors = [];

  await reviewCommand(["status", "2026-08-30-stats-silent-null"]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("no not_measured row names `prefilter`");
});

test("AC3: a package written before filter_stats existed reports the absence and exits 0", async () => {
  // Absence in an old package is a fact about old packages, not a contradiction
  // inside a new one. Failing on it would make the check impossible to adopt.
  process.chdir(ROOT);
  const { path: pkg } = await ingest("2026-08-30-stats-legacy");
  const manifestPath = path.join(ROOT, pkg, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManagedReviewManifest;
  delete manifest.filter_stats;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  logs = [];
  errors = [];

  await reviewCommand(["status", "2026-08-30-stats-legacy"]);

  expect(process.exitCode).toBe(0);
  expect(logs.join("\n")).toContain("filter_stats: not recorded");
});

test("AC3: `review ingest` prints the stats on the terminal it already writes to", async () => {
  process.chdir(ROOT);
  await writeFile(
    path.join(ROOT, "report.md"),
    `# Round\n\n\`\`\`json keryx:findings\n${JSON.stringify([FINDING], null, 2)}\n\`\`\`\n`,
    "utf8",
  );
  logs = [];

  await reviewCommand(["ingest", "--report", "report.md", "--ref", "report.md", "--review-id", "2026-08-30-stats-cli"]);

  expect(process.exitCode).toBe(0);
  expect(logs.join("\n")).toContain("filter_stats: total=1");
});

// ---------------------------------------------------------------------------
// The checker itself, on inputs a real round cannot easily produce
// ---------------------------------------------------------------------------

test("the checker reports a measured count that claims to be unmeasured", () => {
  const stats = buildFilterStats({
    verification: {
      mode: "annotate",
      claims: 0,
      applied: 0,
      rejected: 0,
      capped: 0,
      confirmed: 0,
      refuted: 0,
      unverifiable: 0,
      unverified: 2,
      findingsIn: 2,
      findingsRetained: 2,
      findingsRefuted: 0,
    },
    findingsCap: { counts: { limit: 10, seen: 2, retained: 2, truncated: 0, exempt: 0, reviewersTruncated: 0 }, drops: [] },
    externalRetained: 0,
  });
  const contradictory = { ...stats, not_measured: [...stats.not_measured, { stage: "refuted", reason: "claims it did not run" }] };

  const problems = checkFilterStats(contradictory);
  expect(problems.map((problem) => problem.code)).toContain("contradiction");
  expect(problems.map((problem) => problem.message).join("\n")).toContain("dropped_refuted records 0");
});

test("the checker reports a `not_measured` row with no reason", () => {
  const problems = checkFilterStats({
    schema_version: 1,
    total: 0,
    dropped_prefilter: null,
    dropped_low_confidence: null,
    dropped_refuted: 0,
    dropped_scope_b: 0,
    dropped_findings_cap: 0,
    retained: 0,
    dismissed_by_round: 0,
    by_reason: {},
    not_measured: [
      { stage: "prefilter", reason: "" },
      { stage: "low_confidence", reason: "no such stage" },
    ],
  });
  expect(problems.map((problem) => problem.message).join("\n")).toContain("with no reason");
});

test("the one-line form says `not-measured`, never 0, for an absent count", () => {
  const line = renderFilterStatsLine({
    schema_version: 1,
    total: 3,
    dropped_prefilter: null,
    dropped_low_confidence: null,
    dropped_refuted: 0,
    dropped_scope_b: null,
    dropped_findings_cap: 0,
    retained: 3,
    dismissed_by_round: null,
    by_reason: {},
    not_measured: [
      { stage: "prefilter", reason: "no scope" },
      { stage: "low_confidence", reason: "no such stage" },
      { stage: "round_dismissed", reason: "no channel" },
      { stage: "scope_b", reason: "no radius" },
    ],
  });
  expect(line).toBe(
    "filter_stats: total=3 prefilter=not-measured low_confidence=not-measured refuted=0 scope_b=not-measured findings_cap=0 dismissed_by_round=not-measured retained=3",
  );
});
