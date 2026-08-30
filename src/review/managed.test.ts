import { afterEach, test, expect } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { loadSchema, validateJson } from "../gdskills/contracts";
import { createFlowService } from "../flow/service";
import type { FlowServiceDeps, TrackerAdapter } from "../flow/types";
import {
  completeManagedReview,
  createManagedReviewPackage,
  findingDispositionState,
  findRelatedFlow,
  validateManagedReviewManifest,
  type ManagedReviewIngestInput,
  type ScopeBScreenRecord,
} from "./managed";
import type { BlastRadiusScreenInput } from "./blast-radius";
import {
  FINDING_DISPOSITION_STATES,
  MANAGED_REVIEW_MODES,
  REVIEW_COVERAGE_STATUSES,
  REVIEW_PACKAGE_STATUSES,
  REVIEW_TARGET_KINDS,
} from "./types";
import type { ManagedReviewInput, ManagedReviewManifest, StructuredReviewFinding } from "./types";

let ROOT = "";
const ORIGINAL_CWD = process.cwd();

const REAL_SCHEMA_PATH = path.join(
  ORIGINAL_CWD,
  "docs",
  "requirements",
  "managed-review-feedback-loop",
  "schemas",
  "managed-review-package.schema.json",
);

// Copy the committed JSON Schema (source of truth) into ROOT, replacing the
// trivial `{"type":"object"}` stub `fresh()` writes, so schema-driven validation
// is exercised against the real contract.
async function useRealSchema(): Promise<Record<string, unknown>> {
  const raw = await readFile(REAL_SCHEMA_PATH, "utf8");
  await writeFile(
    path.join(ROOT, "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json"),
    raw,
    "utf8",
  );
  return JSON.parse(raw) as Record<string, unknown>;
}

function validManifest(): ManagedReviewManifest {
  return {
    schemaVersion: 1,
    reviewId: "2026-07-09-pr-1",
    mode: "attach-review",
    status: "draft",
    target: { kind: "pr", ref: "https://github.com/acme/app/pull/1" },
    artifacts: {
      scope: "scope.md",
      coverage: "coverage.md",
      report: "report.md",
      findings: "findings.json",
      learning: "learning.md",
      decisions: "decisions.md",
    },
    coverage: [{ reviewer: "review-logic", status: "run", reason: "selected" }],
    createdAt: "2026-07-09T11:00:00Z",
    updatedAt: "2026-07-09T11:00:00Z",
  };
}

function fakeTracker(): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: (input) => {
      const match = input.match(/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/);
      return match?.[1] && match[2] ? { repo: match[1], number: Number(match[2]) } : null;
    },
    fetchIssue: async () => ({ title: "Issue title", body: "Issue body text" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true }),
    comment: async () => true,
  };
}

function makeDeps(over: Partial<FlowServiceDeps> = {}): FlowServiceDeps {
  return {
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-07-09T10:00:00Z"),
    ...over,
  };
}

async function fresh(): Promise<void> {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
  ROOT = await mkdtemp(path.join(tmpdir(), "gd-review-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  await mkdir(path.join(ROOT, "docs", "requirements", "managed-review-feedback-loop", "schemas"), { recursive: true });
  await writeFile(
    path.join(ROOT, "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json"),
    `{"type":"object"}`,
    "utf8",
  );
}

afterEach(async () => {
  process.chdir(ORIGINAL_CWD);
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

async function writeAc(dir: string): Promise<void> {
  await writeFile(
    path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md"),
    "# Acceptance Criteria\n\n## Criteria\n\n- AC1: Review evidence exists\n",
    "utf8",
  );
}

async function createStartedFlow(title = "Managed Review Flow"): Promise<string> {
  const service = createFlowService(makeDeps());
  const { flow, dir } = await service.init({ cwd: ROOT, title });
  await writeAc(path.basename(dir));
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  return flow.id;
}

test("matches related flow by explicit id, PR URL, issue URL, and branch", async () => {
  await fresh();
  const service = createFlowService(makeDeps());

  const issue = await service.init({ cwd: ROOT, issue: "https://github.com/acme/app/issues/42" });
  expect((await findRelatedFlow({ cwd: ROOT, target: { kind: "issue", ref: "https://github.com/acme/app/issues/42" } }))?.id).toBe(issue.flow.id);
  expect((await findRelatedFlow({ cwd: ROOT, flowId: issue.flow.id, target: { kind: "path", ref: "src" } }))?.reason).toBe("explicit-flow-id");

  await writeAc(path.basename(issue.dir));
  await service.freeze({ cwd: ROOT, id: issue.flow.id });
  await service.start({ cwd: ROOT, id: issue.flow.id });
  await service.implemented({ cwd: ROOT, id: issue.flow.id, prUrl: "https://github.com/acme/app/pull/43" });
  expect((await findRelatedFlow({ cwd: ROOT, target: { kind: "pr", ref: "https://github.com/acme/app/pull/43" } }))?.reason).toBe("pr-url");
  const attachedByPr = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "attach-review",
    reviewId: "2026-07-09-pr-43",
    target: { kind: "pr", ref: "https://github.com/acme/app/pull/43" },
    now: new Date("2026-07-09T11:00:00Z"),
  });
  expect(attachedByPr.manifest.flow?.id).toBe(issue.flow.id);

  const branch = await service.init({ cwd: ROOT, title: "Feature Branch Match" });
  expect((await findRelatedFlow({ cwd: ROOT, target: { kind: "branch", ref: "feature-branch-match" } }))?.id).toBe(branch.flow.id);
});

test("attach-review creates required artifacts and does not mutate flow.json", async () => {
  await fresh();
  const flowId = await createStartedFlow();
  const flowDir = "001-2026-07-09-managed-review-flow";
  const flowJson = path.join(ROOT, ".metaproject", "flows", flowDir, "flow.json");
  const before = await readFile(flowJson, "utf8");

  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "attach-review",
    flowId,
    reviewId: "2026-07-09-pr-1",
    target: { kind: "pr", ref: "https://github.com/acme/app/pull/1" },
    reviewers: ["review-logic", "review-testing-practices"],
    now: new Date("2026-07-09T11:00:00Z"),
  });

  expect(result.path).toBe(".metaproject/flows/001-2026-07-09-managed-review-flow/reviews/2026-07-09-pr-1");
  for (const file of ["manifest.json", "scope.md", "coverage.md", "report.md", "findings.json", "learning.md", "decisions.md"]) {
    expect((await stat(path.join(ROOT, result.path, file))).isFile()).toBe(true);
  }
  expect((await readFile(flowJson, "utf8"))).toBe(before);
  expect((await validateManagedReviewManifest(ROOT, result.manifest)).valid).toBe(true);
});

test("review-flow creates standalone package under .metaproject/reviews", async () => {
  await fresh();
  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "review-flow",
    reviewId: "2026-07-09-branch-managed-review",
    target: { kind: "branch", ref: "feature/managed-review" },
    coverage: [{ reviewer: "review-style", status: "skipped", reason: "not selected for focused runtime test" }],
    now: new Date("2026-07-09T11:00:00Z"),
  });

  expect(result.path).toBe(".metaproject/reviews/2026-07-09-branch-managed-review");
  expect(result.manifest.flow).toBeUndefined();
  const coverage = await readFile(path.join(ROOT, result.path, "coverage.md"), "utf8");
  expect(coverage).toContain("status: skipped");
});

test("ingest writes classified findings and skill learning decision", async () => {
  await fresh();
  const reportPath = path.join(ROOT, "review.md");
  await writeFile(
    reportPath,
    [
      "## Major Issues",
      "",
      "- [F-001] major: Missing managed review coverage.",
      "  - class_scope:",
      "    sites: [\"src/review/managed.ts\", \"src/commands/review.ts\"]",
      "    enumeration_method: \"grep for createManagedReviewPackage; 2 call sites\"",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "ingest",
    reviewId: "2026-07-09-report-review",
    target: { kind: "report", ref: "review.md" },
    reportPath: "review.md",
    now: new Date("2026-07-09T11:00:00Z"),
  });

  const findings = await readFile(path.join(ROOT, result.path, "findings.json"), "utf8");
  expect(findings).toContain('"id": "F-001"');
  // `classification` and `flow_relevance` are the pipeline's triage, not the
  // reviewer's finding, and `review-finding.schema.json` is
  // `additionalProperties: false`. They are recorded in decisions.md; findings.json
  // carries the contract shape and only that.
  expect(findings).not.toContain('"classification"');
  expect(findings).toContain('"class_scope"');
  const decisions = await readFile(path.join(ROOT, result.path, "decisions.md"), "utf8");
  expect(decisions).toContain("F-001: create follow-up task or learning proposal (valid_followup, standalone_review).");
  const learning = await readFile(path.join(ROOT, result.path, "learning.md"), "utf8");
  expect(learning).toContain("## Skill Learning");
});

test("ingest refuses a blocker or major that does not enumerate its class", async () => {
  // The rule exists because eleven rounds across flows 127 and 128 produced
  // fixes that repaired the one site a finding named. Enforced HERE, not only in
  // review-finding.schema.json, because until this the schema was the only place
  // it lived and no real path validated against it — a rule matched against
  // nothing, which is the `allowlist-not-a-boundary` lesson.
  for (const severity of ["blocker", "major"]) {
    await fresh();
    const reportPath = path.join(ROOT, "review.md");
    await writeFile(reportPath, `- [F-001] ${severity}: one site, no class.\n`, "utf8");

    await expect(
      createManagedReviewPackage({
        cwd: ROOT,
        mode: "ingest",
        reviewId: `2026-07-09-${severity}-review`,
        target: { kind: "report", ref: "review.md" },
        reportPath: "review.md",
        now: new Date("2026-07-09T11:00:00Z"),
      }),
    ).rejects.toThrow(/does not enumerate|do not enumerate/);

    // Nothing is left behind: a refused ingest must not leave a package a later
    // round could mistake for a recorded review.
    expect(existsSync(path.join(ROOT, ".metaproject", "reviews", `2026-07-09-${severity}-review`))).toBe(
      false,
    );
  }
});

test("ingest accepts a minor or info without class_scope — enumerating every low-severity note is theatre", async () => {
  for (const severity of ["minor", "info"]) {
    await fresh();
    const reportPath = path.join(ROOT, "review.md");
    await writeFile(reportPath, `- [F-002] ${severity}: a small observation.\n`, "utf8");

    const result = await createManagedReviewPackage({
      cwd: ROOT,
      mode: "ingest",
      reviewId: `2026-07-09-${severity}-review`,
      target: { kind: "report", ref: "review.md" },
      reportPath: "review.md",
      now: new Date("2026-07-09T11:00:00Z"),
    });
    const findings = await readFile(path.join(ROOT, result.path, "findings.json"), "utf8");
    expect(findings).toContain(`"severity": "${severity}"`);
  }
});

test("a finding that cross-references another id keeps its own body", async () => {
  // Found by ingesting a real round-4 report: F-010's text said "this is the
  // root cause of F-001", which was counted as a new finding AND truncated
  // F-010's block at that line — so its class_scope, written below, was invisible
  // and the guard refused a finding that did have one.
  await fresh();
  const reportPath = path.join(ROOT, "review.md");
  await writeFile(
    reportPath,
    [
      "### [F-010] Nothing structurally guards readers",
      "- **Severity**: major",
      "- **Problem**: this is the root cause of F-001, not a separate issue.",
      "- **class_scope**:",
      "  - sites: [\"config-dir.readers.test.ts\", \"config-dir.writers.test.ts\"]",
      "  - enumeration_method: \"added a probe reader and ran both guards; neither fired\"",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "ingest",
    reviewId: "2026-07-09-cross-reference",
    target: { kind: "report", ref: "review.md" },
    reportPath: "review.md",
    now: new Date("2026-07-09T11:00:00Z"),
  });

  const findings = JSON.parse(
    await readFile(path.join(ROOT, result.path, "findings.json"), "utf8"),
  ) as Array<{ id: string; class_scope?: { sites: string[] } }>;
  // One finding, not two: the prose mention of F-001 is not a heading.
  expect(findings.map((f) => f.id)).toEqual(["F-010"]);
  // The class_scope written BELOW the cross-reference survived, and is now
  // extracted rather than recorded as a bare boolean.
  expect(findings[0]?.class_scope?.sites).toEqual([
    "config-dir.readers.test.ts",
    "config-dir.writers.test.ts",
  ]);
});

// The report this pipeline was run against, byte-identical to the package
// recorded at `.metaproject/reviews/2026-08-01-ingest-feat-r4c-turn-submission/`.
// A copy rather than a reference: that package lives on the branch this fix
// unblocks, and a guard that reads a file only present on another branch is a
// guard that does not run.
const CONSOLIDATED_REVIEW = path.join(ORIGINAL_CWD, "src", "review", "fixtures", "consolidated-review-2026-08-01.md");

/**
 * The ids the PARSER produced, with the findings cap lifted.
 *
 * The cap (flow 203, AC5) is 10 per reviewer by default and would truncate the
 * fifteen-finding consolidated review to twelve, which would turn every parser
 * assertion below into an assertion about the cap. The cap is exercised on its
 * own in `caps.test.ts` and end-to-end in the ingest test that names it; here it
 * is explicitly out of the way, and explicitly rather than by accident.
 */
async function ingestIds(reportText: string, reviewId: string): Promise<string[]> {
  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "ingest",
    reviewId,
    target: { kind: "report", ref: "review.md" },
    reportText,
    maxFindingsPerReviewer: 1000,
    now: new Date("2026-08-01T22:00:00Z"),
  });
  const findings = JSON.parse(
    await readFile(path.join(ROOT, result.path, "findings.json"), "utf8"),
  ) as Array<{ id: string }>;
  return findings.map((f) => f.id);
}

test("a wrapped reference at line start is not a heading", async () => {
  // F-015 of the consolidated review, found by running the pipeline rather than
  // reading it. `9d4d3b84` required the identifier to OPEN the line, which
  // stopped mid-sentence cross-references and nothing else: ordinary text
  // wrapping puts a reference at line start routinely, and the first ingest of
  // that report produced EIGHT phantom findings out of one prose section.
  // Rewriting the section reproduced them a second time, from the paragraph
  // describing the defect.
  //
  // Every line below is a shape that section actually produced.
  await fresh();
  const prose = [
    "## Recommended order",
    "",
    "1. Fix and land PR #219 first. Its own findings are the AC8 subset,",
    "F-013, the session resume regression, and the journal claim.",
    "2. Rebase PR #220 onto it. Add the per-call exemption for",
    "F-012) in the same pass.",
    "3. Then fix #220 in this order: the wiring blocker first, because",
    "F-001. Nine of twelve confirmed criteria depend on it.",
    "4. The event-log bound comes next; see",
    "F-002; it is the one the specification names.",
    "5. Both of",
    "F-003 and F-004 are policy-surface defects and travel together.",
    "",
  ].join("\n");

  // Not one finding. Not eight. None: this section describes findings, it does
  // not declare them.
  expect(await ingestIds(prose, "2026-08-01-prose-only")).toEqual([]);
});

test("every heading shape the reviewer skills emit is still a heading", async () => {
  // The other direction, and the more dangerous one. A phantom makes the
  // class-scope guard refuse a report over a finding that does not exist; a
  // MISSED heading makes it pass over a real blocker. Both are pinned, in the
  // same fixture, so tightening the predicate cannot quietly drop a shape.
  await fresh();
  const report = [
    "### F-001 — a marker and an em dash",
    "- **Severity**: minor",
    "",
    "### [F-002] a marker and a bracketed id",
    "- **Severity**: minor",
    "",
    "- [F-003] minor: a list marker and a bracketed id",
    "",
    "[F-004] a bracketed id and no marker",
    "- **Severity**: minor",
    "",
    "F-005: no marker, a colon separator",
    "- **Severity**: minor",
    "",
    "#### F-006 - a hyphen separator",
    "- **Severity**: minor",
    "",
  ].join("\n");

  expect(await ingestIds(report, "2026-08-01-heading-shapes")).toEqual([
    "F-001",
    "F-002",
    "F-003",
    "F-004",
    "F-005",
    "F-006",
  ]);
});

test("the consolidated review ingests as its fifteen findings and nothing else", async () => {
  // The whole report, end to end, rather than a hand-built fixture: the eight
  // phantoms were only visible at this scale, and a section rewritten to dodge
  // the defect is exactly how this stopped being visible the first time.
  await fresh();
  const report = await readFile(CONSOLIDATED_REVIEW, "utf8");
  const ids = await ingestIds(report, "2026-08-01-consolidated");

  expect(ids).toEqual([
    "F-001", "F-002", "F-003", "F-004", "F-005",
    "F-006", "F-007", "F-008", "F-009", "F-010",
    "F-011", "F-012", "F-013", "F-014", "F-015",
  ]);
  // Non-vacuous: if the fixture ever stopped being the real report — truncated,
  // replaced, or emptied — the assertion above would still hold for a file with
  // fifteen headings and no bodies. Every one of these findings enumerates its
  // class, and that is read from the body.
  expect(report.length).toBeGreaterThan(20_000);
});

test("a declared severity beats a severity word appearing in the prose", async () => {
  // Found by running this on a real review report: a `minor` finding whose text
  // discussed blockers was recorded as a blocker and tripped the class-scope
  // guard. Keyword scanning the body is a fallback, never an override.
  await fresh();
  const reportPath = path.join(ROOT, "review.md");
  await writeFile(
    reportPath,
    [
      "### [F-004] The detector is a substring match",
      "- **Severity**: minor",
      "- **Problem**: any SKILL.md containing \"blocker\" is treated as a reviewer.",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "ingest",
    reviewId: "2026-07-09-declared-severity",
    target: { kind: "report", ref: "review.md" },
    reportPath: "review.md",
    now: new Date("2026-07-09T11:00:00Z"),
  });
  const findings = await readFile(path.join(ROOT, result.path, "findings.json"), "utf8");
  expect(findings).toContain('"severity": "minor"');
  // And therefore it is NOT refused for missing class_scope.
  expect(findings).not.toContain('"severity": "blocker"');
});

test("severity is read from the whole finding block, not only its heading line", async () => {
  // The parser read the heading line alone, so a report that puts severity on
  // the line below — which every reviewer skill's format does — was recorded as
  // `minor` whatever it said. That also made the class-scope rule unreachable
  // for exactly the findings it governs.
  await fresh();
  const reportPath = path.join(ROOT, "review.md");
  await writeFile(
    reportPath,
    [
      "### [F-003] Title carrying no severity word",
      "- **Severity**: blocker",
      "- class_scope: sites: [\"a.ts\"] enumeration_method: \"grep\"",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "ingest",
    reviewId: "2026-07-09-block-severity",
    target: { kind: "report", ref: "review.md" },
    reportPath: "review.md",
    now: new Date("2026-07-09T11:00:00Z"),
  });
  const findings = await readFile(path.join(ROOT, result.path, "findings.json"), "utf8");
  expect(findings).toContain('"severity": "blocker"');
});

test("manifest validation rejects invalid modes and missing artifact paths", async () => {
  await fresh();
  const manifest = {
    schemaVersion: 1,
    reviewId: "bad",
    mode: "lightweight",
    status: "draft",
    target: { kind: "pr", ref: "x" },
    artifacts: {
      scope: "",
      coverage: "coverage.md",
      report: "report.md",
      findings: "findings.json",
      learning: "learning.md",
      decisions: "decisions.md",
    },
    coverage: [{ reviewer: "review-logic", status: "run", reason: "selected" }],
  } as unknown as ManagedReviewManifest;

  const result = await validateManagedReviewManifest(ROOT, manifest);
  expect(result.valid).toBe(false);
  expect(result.errors.some((error) => error.path === "$.mode")).toBe(true);
  expect(result.errors.some((error) => error.path === "$.artifacts.scope")).toBe(true);
});

test("complete requires every managed review artifact", async () => {
  await fresh();
  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "review-flow",
    reviewId: "2026-07-09-complete-review",
    target: { kind: "path", ref: "src/review" },
    now: new Date("2026-07-09T11:00:00Z"),
  });

  const completed = await completeManagedReview(ROOT, result.path);
  expect(completed.manifest.status).toBe("closed");
});

test("lightweight CLI mode creates no managed review artifacts", async () => {
  await fresh();
  process.chdir(ROOT);
  await reviewCommand(["lightweight"]);

  await expect(stat(path.join(ROOT, ".metaproject", "reviews"))).rejects.toThrow();
});

test("validation is driven by the committed JSON Schema (accepts valid, rejects schema violations)", async () => {
  await fresh();
  await useRealSchema();

  // A manifest that satisfies the real schema must pass.
  expect((await validateManagedReviewManifest(ROOT, validManifest())).valid).toBe(true);

  // The real schema sets `additionalProperties: false`; the hand-rolled checks
  // never inspected unknown keys, so this case can ONLY be caught by wiring the
  // loaded schema through the validator. Proves the schema file is enforced.
  const withExtra = { ...validManifest(), unexpectedKey: "nope" } as unknown as ManagedReviewManifest;
  const extraResult = await validateManagedReviewManifest(ROOT, withExtra);
  expect(extraResult.valid).toBe(false);
  expect(extraResult.errors.some((error) => error.path === "$.unexpectedKey")).toBe(true);

  // A schema enum the code also knows about: an out-of-enum coverage status is
  // rejected via the schema's `coverage.items.status` enum.
  const badCoverage = validManifest();
  badCoverage.coverage = [{ reviewer: "review-logic", status: "bogus" as never, reason: "x" }];
  expect((await validateManagedReviewManifest(ROOT, badCoverage)).valid).toBe(false);
});

// ---------------------------------------------------------------------------
// AC14: the instrumentation that makes precision measurable later
//
// The baseline measurement of this pipeline returned 53 / (53 + 0) = 100%. Not
// because the reviewers were right — because nothing in a review package could
// record a finding as WRONG. Three defects produced that, and each has a test
// below:
//
//   1. no disposition field           -> `disposition`, defaulting to unknown
//   2. ids collide across packages    -> `global_id`, `<reviewId>#<id>`
//   3. refutations were never written -> the `refuted` channel
// ---------------------------------------------------------------------------

const FULL_FINDING: StructuredReviewFinding = {
  id: "F-001",
  reviewer: "review-security-code",
  severity: "minor",
  problem: "the guard asserts on a synthetic context",
  impact: "the guard passes when the production path is unwired",
  suggested_fix: "drive the writer the CLI drives",
  evidence: "deleted the guarded line; the test stayed green",
  confidence: "high",
};

async function ingestFindings(
  reviewId: string,
  over: Partial<ManagedReviewIngestInput> = {},
): Promise<{ path: string; findings: StructuredReviewFinding[]; scopeBScreen: ScopeBScreenRecord }> {
  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "ingest",
    reviewId,
    target: { kind: "report", ref: "review.md" },
    reportText: "# Round\n\nno machine-readable block here\n",
    findings: [FULL_FINDING],
    now: new Date("2026-08-29T11:00:00Z"),
    ...over,
  });
  return {
    path: result.path,
    scopeBScreen: result.scopeBScreen,
    findings: JSON.parse(
      await readFile(path.join(ROOT, result.path, "findings.json"), "utf8"),
    ) as StructuredReviewFinding[],
  };
}

test("a finding with no disposition reads as unknown — the 83 records on disk are not stranded", async () => {
  await fresh();
  const { findings } = await ingestFindings("2026-08-29-no-disposition");

  // Nothing is written. `{state: "unknown"}` on every finding would imply a
  // decision nobody made, which is precisely what `classification:
  // valid_followup` on 82 of 83 records already does.
  expect(findings[0]).not.toHaveProperty("disposition");
  expect(findingDispositionState(findings[0] as StructuredReviewFinding)).toBe("unknown");
  // And the pre-contract shape, read straight off disk, reads the same way.
  expect(findingDispositionState({} as StructuredReviewFinding)).toBe("unknown");
});

test("closing a round records what became of each finding, with its evidence", async () => {
  await fresh();
  const { path: pkg } = await ingestFindings("2026-08-29-disposition-write");

  const { manifest } = await completeManagedReview(ROOT, pkg, {
    dispositions: [
      { finding: "F-001", state: "acted-on", evidence: "closed by 380bf3b0; config-dir.writers.test.ts" },
    ],
  });
  expect(manifest.status).toBe("closed");

  const findings = JSON.parse(
    await readFile(path.join(ROOT, pkg, "findings.json"), "utf8"),
  ) as StructuredReviewFinding[];
  expect(findings[0]?.disposition).toEqual({
    state: "acted-on",
    evidence: "closed by 380bf3b0; config-dir.writers.test.ts",
  });
  expect(findingDispositionState(findings[0] as StructuredReviewFinding)).toBe("acted-on");
});

test("closing with no dispositions leaves findings.json byte-identical", async () => {
  // Backward compatibility is the constraint, not a nicety: `keryx review
  // complete <ref>` is called with two arguments everywhere today.
  await fresh();
  const { path: pkg } = await ingestFindings("2026-08-29-disposition-absent");
  const before = await readFile(path.join(ROOT, pkg, "findings.json"), "utf8");
  await completeManagedReview(ROOT, pkg);
  expect(await readFile(path.join(ROOT, pkg, "findings.json"), "utf8")).toBe(before);
});

test("a disposition with no evidence is REFUSED, not silently downgraded to unknown", async () => {
  // The choice, stated as a test: reject. Recording it as `unknown` would turn a
  // reviewer verdict somebody actually reached into "nobody decided" — a silent
  // loss of exactly the signal this field exists to capture, and the same
  // silent-degradation shape as the keryx:findings block falling through to the
  // prose parser.
  await fresh();
  const { path: pkg } = await ingestFindings("2026-08-29-disposition-unevidenced");
  const before = await readFile(path.join(ROOT, pkg, "findings.json"), "utf8");

  await expect(
    completeManagedReview(ROOT, pkg, {
      dispositions: [{ finding: "F-001", state: "dismissed-incorrect" }],
    }),
  ).rejects.toThrow(/must cite where the outcome is written down/);
  // And nothing was written: not the disposition, not the closed status.
  expect(await readFile(path.join(ROOT, pkg, "findings.json"), "utf8")).toBe(before);
  const manifest = JSON.parse(
    await readFile(path.join(ROOT, pkg, "manifest.json"), "utf8"),
  ) as ManagedReviewManifest;
  expect(manifest.status).toBe("draft");
});

test("a disposition naming a finding this package does not hold is refused", async () => {
  await fresh();
  const { path: pkg } = await ingestFindings("2026-08-29-disposition-unknown-id");
  await expect(
    completeManagedReview(ROOT, pkg, {
      dispositions: [{ finding: "F-404", state: "acted-on", evidence: "a commit" }],
    }),
  ).rejects.toThrow(/this package holds no such finding. It holds 2026-08-29-disposition-unknown-id#F-001/);
});

test("a recorded verdict cannot be silently reversed", async () => {
  await fresh();
  const { path: pkg } = await ingestFindings("2026-08-29-disposition-reversal");
  await completeManagedReview(ROOT, pkg, {
    dispositions: [{ finding: "F-001", state: "acted-on", evidence: "closed by 380bf3b0" }],
  });
  await expect(
    completeManagedReview(ROOT, pkg, {
      dispositions: [{ finding: "F-001", state: "dismissed-incorrect", evidence: "on reflection, wrong" }],
    }),
  ).rejects.toThrow(/already recorded as "acted-on".*refusing to overwrite/s);
});

test("every disposition state the baseline script counts is accepted by the writer", () => {
  // The categories in `scripts/review-precision-baseline.ts` and the states here
  // must be the same set, or the measurement counts a bucket nothing can be
  // written into — which is how `dismissed-incorrect` came to be structurally
  // unreachable in the first place.
  expect([...FINDING_DISPOSITION_STATES]).toEqual([
    "unknown",
    "acted-on",
    "dismissed-incorrect",
    "dismissed-wont-fix",
    "dismissed-out-of-scope",
    "dismissed-deprioritised",
    // AC10. Not a dismissal and not in the precision ratio — it says our verifier
    // refuted somebody ELSE's comment, which answers nothing about whether our
    // reviewers were right. It is in the script's categories because a state the
    // writer emits and the measurement does not know exits 1 as a stale ledger.
    "answered-disagree",
  ]);
});

test("every state the writer accepts is a category the baseline script counts", () => {
  // The invariant the test above states in prose, checked against the file
  // instead of against a copied list. `dismissed-incorrect` was once
  // structurally unreachable and nothing noticed; a state the script cannot
  // count is the same defect from the other end — the measurement exits 1 on a
  // legitimate record, so it stops being run at all.
  const script = readFileSync(path.join(ORIGINAL_CWD, "scripts", "review-precision-baseline.ts"), "utf8");
  const listed = script.slice(script.indexOf("const CATEGORIES = ["), script.indexOf("] as const;", script.indexOf("const CATEGORIES = [")));
  for (const state of FINDING_DISPOSITION_STATES) {
    expect(listed).toContain(`"${state}"`);
  }
});

test("finding ids are globally unique while F-001 stays F-001", async () => {
  // 15 of 43 distinct ids in the recorded corpus appear in more than one
  // package; `F-001` denotes six different findings. The display form is kept
  // because it is what the markdown parser reads, what decisions.md prints and
  // what humans write in commit messages — so the key is added ALONGSIDE it.
  await fresh();
  const first = await ingestFindings("2026-08-29-package-one");
  const second = await ingestFindings("2026-08-29-package-two");

  expect(first.findings[0]?.id).toBe("F-001");
  expect(second.findings[0]?.id).toBe("F-001");
  expect(first.findings[0]?.global_id).toBe("2026-08-29-package-one#F-001");
  expect(second.findings[0]?.global_id).toBe("2026-08-29-package-two#F-001");
  expect(first.findings[0]?.global_id).not.toBe(second.findings[0]?.global_id);
});

test("a finding carried into a later round keeps the key it was minted under", async () => {
  // Stability. Round N+1 hands round N's finding back through
  // `prior_findings[].finding`; re-minting under the new reviewId would give one
  // finding two keys and break the only join the field exists to provide.
  await fresh();
  const round1 = await ingestFindings("2026-08-29-round-1");
  const round2 = await ingestFindings("2026-08-29-round-2", {
    findings: [round1.findings[0] as StructuredReviewFinding],
  });

  expect(round2.findings[0]?.global_id).toBe("2026-08-29-round-1#F-001");
});

test("the legacy markdown path mints a key too", async () => {
  await fresh();
  const { findings } = await ingestFindings("2026-08-29-legacy-key", {
    reportText: "- [F-007] minor: a small observation.\n",
    findings: undefined,
  });
  expect(findings[0]?.global_id).toBe("2026-08-29-legacy-key#F-007");
});

test("two findings sharing a display id in one package are refused", async () => {
  // They would share a key, and a key that denotes two findings is the defect
  // this field removes. Before, the duplicate was written and every consumer
  // silently kept whichever it saw last.
  await fresh();
  await expect(
    ingestFindings("2026-08-29-duplicate-id", {
      findings: [FULL_FINDING, { ...FULL_FINDING, problem: "a different finding, same id" }],
    }),
  ).rejects.toThrow(/2026-08-29-duplicate-id#F-001 claimed by 2 findings/);
  expect(existsSync(path.join(ROOT, ".metaproject", "reviews", "2026-08-29-duplicate-id"))).toBe(false);
});

test("a round records what it REFUTED, alongside what it reported", async () => {
  // The one that unpins the number. Rounds 3 and 5 of PR #220 each describe
  // findings they judged wrong, in a section headed "Where a reviewer was
  // wrong", and neither became a record. What reached disk was the survivors of
  // an unlogged triage — which is why the numerator equalled the denominator.
  await fresh();
  const { path: pkg, findings } = await ingestFindings("2026-08-29-refuted", {
    refuted: [
      {
        ...FULL_FINDING,
        id: "F-002",
        problem: "claimed the writer is group-writable",
        disposition: {
          state: "dismissed-incorrect",
          evidence: "ran the writer under umask 002; the mode is 0700, the finding read the wrong call site",
        },
      },
    ] as unknown as ManagedReviewInput["refuted"],
  });

  expect(findings.map((finding) => finding.id)).toEqual(["F-001", "F-002"]);
  expect(findingDispositionState(findings[0] as StructuredReviewFinding)).toBe("unknown");
  expect(findings[1]?.disposition?.state).toBe("dismissed-incorrect");
  expect(findings[1]?.disposition?.evidence).toContain("the mode is 0700");
  expect(findings[1]?.global_id).toBe("2026-08-29-refuted#F-002");

  // And decisions.md stops being the same sentence for every finding.
  const decisions = await readFile(path.join(ROOT, pkg, "decisions.md"), "utf8");
  expect(decisions).toContain("F-002: dismissed-incorrect — ran the writer under umask 002");
  expect(decisions).toContain("F-001: create follow-up task or learning proposal");
});

test("a refutation that cites nothing is refused", async () => {
  await fresh();
  await expect(
    ingestFindings("2026-08-29-refuted-unevidenced", {
      refuted: [{ ...FULL_FINDING, id: "F-002" }] as unknown as ManagedReviewInput["refuted"],
    }),
  ).rejects.toThrow(/Refusing to record a disposition with no evidence: 2026-08-29-refuted-unevidenced#F-002 \(dismissed-incorrect\)/);
  expect(existsSync(path.join(ROOT, ".metaproject", "reviews", "2026-08-29-refuted-unevidenced"))).toBe(
    false,
  );
});

test("an out-of-scope dismissal is recordable, and acted-on is not, on the refuted channel", async () => {
  // `dismissed-out-of-scope = 0` in the corpus means "not written down", not
  // "did not happen": flow 133 declared the whole minor/info set out of scope in
  // prose. Giving it nowhere to go is how it got there.
  await fresh();
  const { findings } = await ingestFindings("2026-08-29-refuted-scope", {
    refuted: [
      {
        ...FULL_FINDING,
        id: "F-002",
        disposition: { state: "dismissed-out-of-scope", evidence: "flow 133 description: R4d work of any kind" },
      },
    ] as unknown as ManagedReviewInput["refuted"],
  });
  expect(findings[1]?.disposition?.state).toBe("dismissed-out-of-scope");

  await fresh();
  await expect(
    ingestFindings("2026-08-29-refuted-acted-on", {
      refuted: [
        { ...FULL_FINDING, id: "F-002", disposition: { state: "acted-on", evidence: "a commit" } },
      ] as unknown as ManagedReviewInput["refuted"],
    }),
  ).rejects.toThrow(/as refuted with disposition "acted-on"/);
});

test("committed JSON Schema and code constants stay consistent (drift guard)", async () => {
  const schema = JSON.parse(await readFile(REAL_SCHEMA_PATH, "utf8")) as {
    required: string[];
    properties: {
      mode: { enum: string[] };
      status: { enum: string[] };
      target: { properties: { kind: { enum: string[] } } };
      coverage: { items: { properties: { status: { enum: string[] } } } };
    };
  };

  // The set of required top-level fields the schema enforces.
  expect([...schema.required].sort()).toEqual(
    ["artifacts", "coverage", "mode", "reviewId", "schemaVersion", "status", "target"].sort(),
  );

  // Enums in the schema must match the TypeScript constants the runtime uses, so
  // a future edit to one without the other fails this test rather than silently
  // drifting.
  expect(schema.properties.mode.enum).toEqual([...MANAGED_REVIEW_MODES]);
  expect(schema.properties.status.enum).toEqual([...REVIEW_PACKAGE_STATUSES]);
  expect(schema.properties.target.properties.kind.enum).toEqual([...REVIEW_TARGET_KINDS]);
  expect(schema.properties.coverage.items.properties.status.enum).toEqual([...REVIEW_COVERAGE_STATUSES]);
});

// ---------------------------------------------------------------------------
// The two finding schemas, and the one place they are deliberately NOT twins
// ---------------------------------------------------------------------------

const STRICT_FINDING_SCHEMA = JSON.parse(
  readFileSync(path.join(ORIGINAL_CWD, "src", "gdskills", "contracts", "review-finding.schema.json"), "utf8"),
) as Record<string, any>;

const BUNDLED_FINDING_SCHEMA = JSON.parse(
  readFileSync(
    path.join(
      ORIGINAL_CWD,
      "src",
      "gdskills",
      "bundled",
      "skills",
      "review",
      "review-orchestrator",
      "reviewer-finding.schema.json",
    ),
    "utf8",
  ),
) as Record<string, any>;

function contractFinding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...FULL_FINDING, ...over };
}

test("review-finding.schema.json accepts a disposition and pins its vocabulary", async () => {
  const schema = await loadSchema("review-finding");
  // The half that catches `additionalProperties: false`: a writer emitting a
  // field the contract does not declare makes every conforming finding invalid.
  expect(await validateJson(contractFinding({ global_id: "r#F-001" }), schema)).toEqual([]);
  for (const state of FINDING_DISPOSITION_STATES) {
    const disposition = state === "unknown" ? { state } : { state, evidence: "closed by 380bf3b0" };
    expect(await validateJson(contractFinding({ disposition }), schema)).toEqual([]);
  }

  const badState = await validateJson(contractFinding({ disposition: { state: "dismissed" } }), schema);
  expect(badState.map((error) => error.path)).toContain("$.disposition.state");

  const badExtra = await validateJson(
    contractFinding({ disposition: { state: "unknown", note: "why" } }),
    schema,
  );
  expect(badExtra.map((error) => error.path)).toContain("$.disposition.note");
});

test("the schema itself refuses a disposition that asserts an outcome and cites nothing", async () => {
  // Not only the writer in managed.ts. `prior_findings[].finding` $refs this
  // schema, so a disposition smuggled in from outside the CLI is refused at the
  // same gate — a rule that lives in one code path is matched against nothing
  // the moment a second path appears.
  const schema = await loadSchema("review-finding");
  for (const state of ["acted-on", "dismissed-incorrect", "dismissed-out-of-scope"]) {
    const errors = await validateJson(contractFinding({ disposition: { state } }), schema);
    expect(errors.map((error) => `${error.path} ${error.message}`).join("\n")).toContain(
      "$.disposition.evidence",
    );
  }
  // And `unknown` needs none, which is what makes absence a legal reading.
  expect(await validateJson(contractFinding({ disposition: { state: "unknown" } }), schema)).toEqual([]);
  // An empty string is not evidence.
  const empty = await validateJson(
    contractFinding({ disposition: { state: "acted-on", evidence: "" } }),
    schema,
  );
  expect(empty.map((error) => error.path)).toContain("$.disposition.evidence");
});

test("global_id is declared identically in both finding schemas", () => {
  const bundledFinding = BUNDLED_FINDING_SCHEMA.properties.findings.items as Record<string, any>;
  const shape = (s: Record<string, any>) => ({ type: s.type, minLength: s.minLength, pattern: s.pattern });
  expect(shape(bundledFinding.properties.global_id)).toEqual(
    shape(STRICT_FINDING_SCHEMA.properties.global_id),
  );
});

test("the contract pins global_id's SHAPE, not merely its type", async () => {
  // `<reviewId>#<id>` is the whole content of the key: the measurement joins on
  // it, and `mintGlobalFindingId` is the only writer inside this repository. A
  // producer outside it can supply any string, and a `global_id` that is not the
  // minted shape joins to nothing while looking like a key.
  const schema = await loadSchema("review-finding");
  expect(await validateJson(contractFinding({ global_id: "2026-08-29-round-1#F-001" }), schema)).toEqual([]);
  for (const bad of ["F-001", "", "a#b#c", "#F-001", "round#"]) {
    const errors = await validateJson(contractFinding({ global_id: bad }), schema);
    expect({ bad, paths: [...new Set(errors.map((error) => error.path))] }).toEqual({
      bad,
      paths: ["$.global_id"],
    });
  }
});

// ---------------------------------------------------------------------------
// AC5: the drop record reaches the review package and SURVIVES ingest
// ---------------------------------------------------------------------------

/** The block `keryx review scope --append` writes, as it appears on disk. */
const APPENDED_SCOPE_BLOCK = `## Pre-filter scope

mode: diff
context_lines: 20
files_seen: 3
files_retained: 1
files_dropped: 2
blocks_seen: 4
blocks_retained: 3
blocks_dropped: 1
changed_lines_retained: 40
changed_lines_dropped: 3216

### Dropped by the pre-filter

| path | where | reason | why |
|---|---|---|---|
| bun.lock | whole file | lockfile | lockfile: dependency-manager output "bun.lock" |
| src/a.ts | lines 41-42 (2) | whitespace-only | whitespace-only: identical once whitespace is removed |

Counts by reason: lockfile=1, generated=0, vendored=0, snapshot=0, minified=0, binary=0, whitespace-only=1, comment-only=0
`;

const SCOPE_RECORD: NonNullable<ManagedReviewInput["scope"]> = {
  mode: "diff",
  contextLines: 20,
  files: ["src/a.ts"],
  drops: [
    {
      path: "bun.lock",
      reason: "lockfile",
      detail: 'lockfile: dependency-manager output "bun.lock"',
      granularity: "file",
      changedLines: 3214,
    },
  ],
  counts: {
    filesSeen: 3,
    filesRetained: 1,
    filesDropped: 2,
    blocksSeen: 4,
    blocksRetained: 3,
    blocksDropped: 1,
    changedLinesRetained: 40,
    changedLinesDropped: 3216,
  },
};

test("ingest does not replace a recorded drop table with a claim that nothing ran", async () => {
  // The pipeline's OWN prescribed order: review-orchestrator Step 3 runs
  // `keryx review scope --append <package>/scope.md`, and `review ingest` runs
  // after Step 12 and rewrites scope.md unconditionally. What replaced the drop
  // table was not a blank — it was the sentence "no pre-filter scope was
  // supplied to this package", which is the same class of false positive
  // statement as `dismissed-out-of-scope: 0`.
  await fresh();
  const packageDir = path.join(ROOT, ".metaproject", "reviews", "2026-08-29-scope-clobber");
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(packageDir, "scope.md"), APPENDED_SCOPE_BLOCK, "utf8");

  await ingestFindings("2026-08-29-scope-clobber");

  const scope = await readFile(path.join(packageDir, "scope.md"), "utf8");
  expect(scope).toContain("bun.lock");
  expect(scope).toContain("lockfile: dependency-manager output");
  expect(scope).not.toContain("no pre-filter scope was supplied");
  // And the stage counts are still there: carrying the block forward must not
  // cost the AC11 half of the record.
  expect(scope).toContain("## Stage counts");
  expect(scope).toContain("### Refuted by the verifier");
});

test("the drop rows reach the record through the supported input, with their reasons", async () => {
  await fresh();
  const { path: pkg } = await ingestFindings("2026-08-29-scope-supplied", { scope: SCOPE_RECORD });
  const scope = await readFile(path.join(ROOT, pkg, "scope.md"), "utf8");
  expect(scope).toContain("files_dropped: 2");
  expect(scope).toContain("| bun.lock | whole file | lockfile |");
  // The PRE-FILTER half specifically. Other stages this ingest was told nothing
  // about — the spend ceiling, the dispatch plan — correctly render `not
  // recorded`, and a whole-file assertion would forbid that.
  expect(scope).not.toContain("not recorded — no pre-filter scope");
});

test("a supplied scope wins over a stale block already in the package", async () => {
  // Precedence, stated: the JSON handed to this ingest describes THIS round. A
  // block left in scope.md by an earlier run is the fallback, not the source of
  // truth, or a re-ingest would resurrect a superseded record.
  await fresh();
  const packageDir = path.join(ROOT, ".metaproject", "reviews", "2026-08-29-scope-precedence");
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(packageDir, "scope.md"), APPENDED_SCOPE_BLOCK, "utf8");

  await ingestFindings("2026-08-29-scope-precedence", {
    scope: {
      ...SCOPE_RECORD,
      drops: [
        {
          path: "vendor/thing.js",
          reason: "vendored",
          detail: 'vendored: path segment "vendor/"',
          granularity: "file",
          changedLines: 12,
        },
      ],
    },
  });

  const scope = await readFile(path.join(packageDir, "scope.md"), "utf8");
  expect(scope).toContain("vendor/thing.js");
  expect(scope).not.toContain("bun.lock");
});

test("no scope anywhere still reads `not recorded`, never `dropped 0`", async () => {
  await fresh();
  const { path: pkg } = await ingestFindings("2026-08-29-scope-absent");
  const scope = await readFile(path.join(ROOT, pkg, "scope.md"), "utf8");
  expect(scope).toContain("no pre-filter scope was supplied");
  expect(scope).toContain("This is NOT `dropped 0`");
});

test("re-recording the same state may not silently replace the citation", async () => {
  // The refusal to reverse a verdict is defensible. Guarding the state and not
  // the evidence is not: the original citation is gone with no trace, and the
  // evidence is the whole reason a disposition is more than an assertion.
  await fresh();
  const { path: pkg } = await ingestFindings("2026-08-29-disposition-evidence");
  await completeManagedReview(ROOT, pkg, {
    dispositions: [{ finding: "F-001", state: "acted-on", evidence: "closed by 380bf3b0" }],
  });

  await expect(
    completeManagedReview(ROOT, pkg, {
      dispositions: [{ finding: "F-001", state: "acted-on", evidence: "closed by deadbeef" }],
    }),
  ).rejects.toThrow(/already cites "closed by 380bf3b0"/);

  const findings = JSON.parse(
    await readFile(path.join(ROOT, pkg, "findings.json"), "utf8"),
  ) as StructuredReviewFinding[];
  expect(findings[0]?.disposition?.evidence).toBe("closed by 380bf3b0");
});

test("re-recording the identical disposition is a no-op, not a refusal", async () => {
  // Idempotence is what makes a retried `review complete` safe. Only a CHANGED
  // citation is refused.
  await fresh();
  const { path: pkg } = await ingestFindings("2026-08-29-disposition-idempotent");
  const record = { finding: "F-001", state: "acted-on" as const, evidence: "closed by 380bf3b0" };
  await completeManagedReview(ROOT, pkg, { dispositions: [record] });
  const before = await readFile(path.join(ROOT, pkg, "findings.json"), "utf8");
  await completeManagedReview(ROOT, pkg, { dispositions: [record] });
  expect(await readFile(path.join(ROOT, pkg, "findings.json"), "utf8")).toBe(before);
});

test("disposition is declared in the strict contract and DELIBERATELY not in the reviewer's", () => {
  // Said loudly, and pinned, so the asymmetry reads as a decision rather than as
  // drift. A reviewer states what is WRONG; it never states what BECAME of a
  // finding. `classification` blurred exactly that line — it looked like a
  // validity verdict and was assigned from the ingest mode — and the blur is why
  // 82 of 83 records claim `valid_followup` while saying nothing.
  expect(STRICT_FINDING_SCHEMA.properties.disposition).toBeDefined();
  expect(BUNDLED_FINDING_SCHEMA.properties.findings.items.properties.disposition).toBeUndefined();
  // The bundled schema is `additionalProperties: true`, so this is a statement
  // of intent rather than a wall — which is why the intent is written down.
  expect(BUNDLED_FINDING_SCHEMA.properties.findings.items.additionalProperties).toBe(true);
  expect(JSON.stringify(BUNDLED_FINDING_SCHEMA.properties.findings.items.properties.global_id)).toContain(
    "asymmetry",
  );
});

// ---------------------------------------------------------------------------
// Flow 203 AC5-AC7, AC10 — the caps, end to end through a real package
// ---------------------------------------------------------------------------

function findingsFrom(
  reviewer: string,
  count: number,
  severity: StructuredReviewFinding["severity"] = "minor",
): StructuredReviewFinding[] {
  return Array.from({ length: count }, (_, index) => ({
    ...FULL_FINDING,
    id: `${reviewer}-${index + 1}`,
    reviewer,
    severity,
  }));
}

test("AC5: an ingest caps each reviewer at ten findings with no caller saying so", async () => {
  await fresh();
  // The default has to bind a caller that never heard of it — that is the whole
  // content of "the default is in code". Fails without the cap: all 14 land.
  const { findings } = await ingestFindings("2026-08-30-cap-default", {
    findings: findingsFrom("review-logic", 14),
  });

  expect(findings).toHaveLength(10);
});

test("AC10: the ingest names every truncated finding in scope.md, with a count", async () => {
  await fresh();
  const { path: pkg, findings } = await ingestFindings("2026-08-30-cap-record", {
    findings: findingsFrom("review-logic", 13),
  });
  const scope = await readFile(path.join(ROOT, pkg, "scope.md"), "utf8");

  expect(scope).toContain("## Caps");
  expect(scope).toContain("findings_truncated: 3");
  expect(scope).toContain("reviewers_truncated: 1");
  // Named, not merely counted: the three ids missing from findings.json are the
  // three ids the record lists.
  const recorded = new Set(findings.map((finding) => finding.id));
  for (const id of ["review-logic-11", "review-logic-12", "review-logic-13"]) {
    expect(recorded.has(id)).toBe(false);
    expect(scope).toContain(id);
  }
});

test("AC5: blockers survive an ingest that truncates the same reviewer's minors", async () => {
  await fresh();
  const { findings } = await ingestFindings("2026-08-30-cap-blockers", {
    findings: [
      ...findingsFrom("review-logic", 12),
      ...findingsFrom("review-logic", 2, "blocker").map((finding, index) => ({
        ...finding,
        id: `review-logic-blocker-${index + 1}`,
        class_scope: { sites: ["src/a.ts:1"], enumeration_method: "grep over src/**" },
      })),
    ],
  });

  expect(findings.filter((finding) => finding.severity === "blocker")).toHaveLength(2);
  // Ten ordinary findings survive ALONGSIDE the blockers, not instead of two of them.
  expect(findings.filter((finding) => finding.severity === "minor")).toHaveLength(10);
});

test("AC5: the cap never touches the dismissal records", async () => {
  await fresh();
  // `--refuted` is the channel that ends the unlogged triage. Capping it would
  // rebuild by hand the state flow 202 measured: a corpus of survivors that
  // reports 100% precision whatever the reviewers got right.
  const { findings } = await ingestFindings("2026-08-30-cap-refuted", {
    findings: findingsFrom("review-logic", 2),
    refuted: findingsFrom("review-style", 14).map((finding) => ({
      ...finding,
      disposition: { state: "dismissed-out-of-scope" as const, evidence: "declared out of scope by flow 203" },
    })),
  });

  expect(findings.filter((finding) => finding.reviewer === "review-style")).toHaveLength(14);
});

test("AC6/AC10: a spend over the ceiling is recorded as a stop, and the package is still written", async () => {
  await fresh();
  const { path: pkg } = await ingestFindings("2026-08-30-cap-spend", { spend: 4.2 });
  const scope = await readFile(path.join(ROOT, pkg, "scope.md"), "utf8");

  expect(scope).toContain("### Spend ceiling");
  expect(scope).toContain("status: over");
  expect(scope).toContain("STOPPED at the ceiling");
  // The record of the stop is the point. A cap that refused the write would
  // delete the evidence that it fired.
  expect(existsSync(path.join(ROOT, pkg, "findings.json"))).toBe(true);
});

test("AC7/AC10: a dispatch plan records its waves, its queue and whether it holds across nesting", async () => {
  await fresh();
  const { path: pkg } = await ingestFindings("2026-08-30-cap-concurrency", {
    concurrency: { reviewers: ["a", "b", "c", "d", "e", "f"] },
  });
  const scope = await readFile(path.join(ROOT, pkg, "scope.md"), "utf8");

  expect(scope).toContain("### Concurrency cap");
  expect(scope).toContain("cap: 4");
  expect(scope).toContain("reviewers_queued: 2");
  expect(scope).toContain("holds_across_nesting: no");
  expect(scope).toContain("were QUEUED, not dropped");
});

test("AC10: caps nobody supplied read `not recorded`, never zero", async () => {
  await fresh();
  const { path: pkg } = await ingestFindings("2026-08-30-cap-absent");
  const scope = await readFile(path.join(ROOT, pkg, "scope.md"), "utf8");

  expect(scope).toContain("not recorded — no spend ceiling was evaluated");
  expect(scope).toContain("not recorded — no dispatch plan was supplied");
  // The findings cap DID run — it always runs — so it says so rather than
  // claiming ignorance about itself.
  expect(scope).toContain("_the findings cap ran and truncated nothing_");
});

// ---------------------------------------------------------------------------
// Flow 204 AC3 — the scope-B screen, wired into the ingest
//
// `review-regression/SKILL.md` has told the scope-B reviewer "this is enforced,
// not requested" since the screen was written, and nothing called it: the
// pipeline ran `applyExternalVerdictRule`, `partitionExternalFindings` and
// `applyFindingsCap` and never screened. The consequence was the opposite of the
// promise — a `major` about the style of an untouched file in the blast radius
// was written into findings.json unscreened, and the review gate then blocked
// completion on it.
//
// Every test below drives `createManagedReviewPackage`, because that is the
// function that was missing the call.
// ---------------------------------------------------------------------------

/** The set a round was dispatched over: one changed file, one hop-1 dependent. */
const RADIUS: BlastRadiusScreenInput = {
  changedFiles: ["src/core/util.ts"],
  files: [
    {
      file: "src/a.ts",
      hop: 1,
      fanIn: 3,
      via: "src/core/util.ts",
      path: ["src/a.ts", "src/core/util.ts"],
      source: "graph",
      isTest: false,
    },
  ],
};

function scopeBFinding(over: Partial<StructuredReviewFinding> = {}): StructuredReviewFinding {
  return {
    ...FULL_FINDING,
    id: "F-100",
    reviewer: "review-regression",
    severity: "major",
    problem: "the changed util.ts contract now returns undefined, so this call site throws",
    impact: "the render throws at runtime",
    suggested_fix: "restore the guard",
    evidence: "src/a.ts:12",
    file: "src/a.ts",
    class_scope: {
      sites: ["src/a.ts:12"],
      enumeration_method: "every entry in the blast radius importing the changed helper",
    },
    ...over,
  };
}

test("AC3: a scope-B major that is not a regression never reaches findings.json", async () => {
  await fresh();
  // The reviewer's own scenario: a `major` about an untouched file that IS in
  // the computed set and names nothing the change did. Unscreened, it is
  // ingested and the review gate then blocks completion on it.
  const { findings, scopeBScreen } = await ingestFindings("2026-08-30-scope-b-reject", {
    findings: [
      scopeBFinding({
        problem: "this function is long and hard to follow",
        impact: "future maintenance",
        suggested_fix: "extract a helper",
      }),
    ],
    blastRadius: RADIUS,
  });

  expect(findings.map((finding) => finding.id)).not.toContain("F-100");
  expect(scopeBScreen.screen?.rejected).toHaveLength(1);
  expect(scopeBScreen.screen?.rejected[0]?.rule).toBe("no-link-to-change");
});

test("AC3: a real regression claim inside the set survives the screen", async () => {
  await fresh();
  // The other direction, and the one that matters most: a screen that rejected
  // this would be a false negative in the direction that hides defects.
  const { findings, scopeBScreen } = await ingestFindings("2026-08-30-scope-b-accept", {
    findings: [scopeBFinding()],
    blastRadius: RADIUS,
  });

  expect(findings.map((finding) => finding.id)).toContain("F-100");
  expect(scopeBScreen.screen?.rejected).toHaveLength(0);
  expect(scopeBScreen.scopeBFindings).toBe(1);
});

test("AC3: the screen judges scope B only — a scope-A minor on a changed file is untouched", async () => {
  await fresh();
  // Scope A asks whether the change is correct, and a `minor` is a legitimate
  // answer to that question. Screening every finding by scope B's floor would
  // delete it.
  const { findings } = await ingestFindings("2026-08-30-scope-b-leaves-a", {
    findings: [{ ...FULL_FINDING, id: "F-200", reviewer: "review-style", severity: "minor", file: "src/core/util.ts" }],
    blastRadius: RADIUS,
  });

  expect(findings.map((finding) => finding.id)).toContain("F-200");
});

test("AC3: every rejection is named in scope.md with the rule that refused it", async () => {
  await fresh();
  const { path: pkg } = await ingestFindings("2026-08-30-scope-b-record", {
    findings: [
      scopeBFinding({
        id: "F-101",
        file: "src/somewhere/else.ts",
        class_scope: { sites: ["src/somewhere/else.ts:9"], enumeration_method: "read the file" },
      }),
      scopeBFinding({ id: "F-102", severity: "minor", class_scope: undefined }),
    ],
    blastRadius: RADIUS,
  });
  const scope = await readFile(path.join(ROOT, pkg, "scope.md"), "utf8");

  // The cap's shape: a count, and then every single id with its reason. A screen
  // that dropped findings silently is the failure this programme exists to end.
  expect(scope).toContain("## Scope B rejections");
  expect(scope).toContain("rejected: 2");
  expect(scope).toContain("scope_b_findings: 2");
  expect(scope).toContain("F-101");
  expect(scope).toContain("outside-set");
  expect(scope).toContain("F-102");
  expect(scope).toContain("non-regression-severity");
});

test("AC3: a blocker admitted by the exemption is named in scope.md, not silently accepted", async () => {
  await fresh();
  // The exemption's own failure mode. This finding is a style observation on an
  // in-set file naming nothing the change did — the `major` form of it is
  // rejected two tests above — and it reaches `findings.json`, where the review
  // gate blocks completion until it is dispositioned. That is defensible only
  // while the record SAYS the screen did not judge it. `accepted: 1` alone, plus
  // "every scope-B finding was a regression claim inside the computed set", is a
  // record asserting something the screen never established.
  const { findings, path: pkg, scopeBScreen } = await ingestFindings("2026-08-30-scope-b-exempt", {
    findings: [
      scopeBFinding({
        id: "F-103",
        severity: "blocker",
        problem: "this file's naming is inconsistent and the helper is hard to read",
        impact: "future maintenance",
        suggested_fix: "rename the helper",
        evidence: "src/a.ts:12",
        // A blocker must enumerate its class, and this one does — at a site in
        // the computed set, naming nothing the change did. That is precisely the
        // finding rule 3 is not allowed to judge.
        class_scope: { sites: ["src/a.ts:12"], enumeration_method: "read the file" },
      }),
    ],
    blastRadius: RADIUS,
  });
  const scope = await readFile(path.join(ROOT, pkg, "scope.md"), "utf8");

  expect(findings.map((finding) => finding.id)).toContain("F-103");
  expect(scopeBScreen.screen?.exempted).toHaveLength(1);
  expect(scopeBScreen.screen?.exempted[0]?.rule).toBe("no-link-to-change");
  expect(scope).toContain("accepted: 1 (1 admitted by the blocker exemption without naming the change)");
  expect(scope).toContain("scope_b_exempted: 1");
  expect(scope).toContain("F-103");
  expect(scope).not.toContain("every scope-B finding was a regression claim inside the computed set");
});

test("AC3: a scope-B finding with no blast-radius record is refused, not recorded unscreened", async () => {
  await fresh();
  // The silent no-op is the defect. Without the set the round was dispatched
  // over there is nothing to screen against, and recording the finding anyway is
  // exactly what the skill promised does not happen.
  await expect(
    ingestFindings("2026-08-30-scope-b-unscreened", { findings: [scopeBFinding()] }),
  ).rejects.toThrow(/no blast-radius record/);
  expect(existsSync(path.join(ROOT, ".metaproject", "reviews", "2026-08-30-scope-b-unscreened", "findings.json"))).toBe(
    false,
  );
});

test("AC3: the screen reads the blast-radius record written next to the package", async () => {
  await fresh();
  // The channel that needs no new flag: the orchestrator computes the set at
  // dispatch time with `--out <package>/blast-radius.json` and ingests after the
  // round, the same way the pre-filter's scope block survives between the two.
  const pkg = path.join(ROOT, ".metaproject", "reviews", "2026-08-30-scope-b-artifact");
  await mkdir(pkg, { recursive: true });
  await writeFile(path.join(pkg, "blast-radius.json"), JSON.stringify(RADIUS), "utf8");

  const { findings, scopeBScreen } = await ingestFindings("2026-08-30-scope-b-artifact", {
    findings: [scopeBFinding({ problem: "this function is long and hard to follow", suggested_fix: "extract" })],
  });

  expect(scopeBScreen.source).toBe("package");
  expect(findings.map((finding) => finding.id)).not.toContain("F-100");
});

test("AC3: a screen that did not run says so, rather than reporting `rejected: 0`", async () => {
  await fresh();
  const { path: pkg, scopeBScreen } = await ingestFindings("2026-08-30-scope-b-absent");
  const scope = await readFile(path.join(ROOT, pkg, "scope.md"), "utf8");

  expect(scopeBScreen.source).toBe("none");
  expect(scope).toContain("no blast-radius record reached this ingest");
  // Not `rejected: 0`, which reads as a screen that ran and found nothing.
  expect(scope).not.toContain("\nrejected: 0");
});

// ---------------------------------------------------------------------------
// Round 2 — the two defects the wiring itself introduced
//
// Every test above passes `--review-id`, which is why none of them reached the
// trap: `allocatePackage` only probes for a free directory when the round names
// none, and the documented orchestrator invocation never names one. So the
// tests below deliberately DO NOT pass a reviewId. That is the whole difference
// between the shipping path and the one round 1 tested.
// ---------------------------------------------------------------------------

const REVIEWS = [".metaproject", "reviews"] as const;

/** An ingest the way `review-orchestrator` runs it: no `--review-id`. */
async function ingestUnnamed(
  over: Partial<ManagedReviewIngestInput> = {},
): Promise<{ path: string; findings: StructuredReviewFinding[]; scopeBScreen: ScopeBScreenRecord }> {
  const result = await createManagedReviewPackage({
    cwd: ROOT,
    mode: "ingest",
    target: { kind: "report", ref: "review.md" },
    reportText: "# Round\n\nno machine-readable block here\n",
    findings: [FULL_FINDING],
    now: new Date("2026-08-29T11:00:00Z"),
    ...over,
  });
  return {
    path: result.path,
    scopeBScreen: result.scopeBScreen,
    findings: JSON.parse(
      await readFile(path.join(ROOT, result.path, "findings.json"), "utf8"),
    ) as StructuredReviewFinding[],
  };
}

async function reviewPackageDirs(): Promise<string[]> {
  const entries = await readdir(path.join(ROOT, ...REVIEWS), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

test("AC3: the scope-B refusal is escapable — following the advice does not move the package", async () => {
  await fresh();
  // The trap, reproduced first. An ordinary recommended round names no
  // --review-id, so the package directory does not exist yet; the refusal used
  // to tell the operator to write the record INSIDE it, and doing that made the
  // next ingest allocate `<base>-r02` and refuse identically. Throw, write,
  // throw, up to MAX_SAME_DAY_ROUNDS.
  const refusal = await ingestUnnamed({ findings: [scopeBFinding()] }).then(
    () => undefined,
    (error: unknown) => error as Error,
  );

  expect(refusal?.message).toContain("no blast-radius record");
  // The flag that always works, named as the first remedy.
  expect(refusal?.message).toContain("--blast-radius <file>");
  // The on-disk channel, as a path relative to cwd rather than a bare basename.
  expect(refusal?.message).toContain(path.join(...REVIEWS, "blast-radius.json"));
  // And the trap itself, named so nobody walks back into it.
  expect(refusal?.message).toContain("has not allocated that directory yet");

  // Now DO what the message says, and check the second ingest lands in the base
  // directory rather than being pushed to `-r02` by the write.
  await mkdir(path.join(ROOT, ...REVIEWS), { recursive: true });
  await writeFile(path.join(ROOT, ...REVIEWS, "blast-radius.json"), JSON.stringify(RADIUS), "utf8");

  const { findings, scopeBScreen, path: pkg } = await ingestUnnamed({ findings: [scopeBFinding()] });

  expect(scopeBScreen.source).toBe("handoff");
  expect(findings.map((finding) => finding.id)).toContain("F-100");
  expect(pkg).not.toContain("-r02");
  expect(await reviewPackageDirs()).toHaveLength(1);
});

test("AC3: the handoff record is consumed and copied into the package it screened", async () => {
  await fresh();
  await mkdir(path.join(ROOT, ...REVIEWS), { recursive: true });
  const handoff = path.join(ROOT, ...REVIEWS, "blast-radius.json");
  await writeFile(handoff, JSON.stringify(RADIUS), "utf8");

  const { path: pkg } = await ingestUnnamed({ findings: [scopeBFinding()] });

  // The package holds the exact set it was screened against.
  const copied = JSON.parse(await readFile(path.join(ROOT, pkg, "blast-radius.json"), "utf8")) as BlastRadiusScreenInput;
  expect(copied.changedFiles).toEqual(RADIUS.changedFiles);
  // And the slot is empty, so the NEXT round — a different change, a different
  // radius — cannot be screened against a set nobody recomputed. It refuses
  // loudly instead, which is the direction to be wrong in.
  expect(existsSync(handoff)).toBe(false);
  await expect(ingestUnnamed({ findings: [scopeBFinding()] })).rejects.toThrow(/no blast-radius record/);
});

// The set the second round of flow 204 was reviewed under: one changed file,
// one hop-1 dependent that the change did not touch.
const DEPENDENT_RADIUS: BlastRadiusScreenInput = {
  changedFiles: ["src/gdskills/model-tier.ts"],
  files: [
    {
      file: "src/harness/child/spawn.ts",
      hop: 1,
      fanIn: 2,
      via: "src/gdskills/model-tier.ts",
      path: ["src/harness/child/spawn.ts", "src/gdskills/model-tier.ts"],
      source: "graph",
      isTest: false,
    },
  ],
};

/**
 * A regression claim about a DEPENDENT, written without repeating the changed
 * filename or its stem. This is the shape `no-link-to-change` was deleting.
 */
function dependentRegression(over: Partial<StructuredReviewFinding> = {}): StructuredReviewFinding {
  return {
    ...FULL_FINDING,
    id: "F-300",
    reviewer: "review-regression",
    severity: "blocker",
    problem: "the spawned child no longer inherits the tier argument, so every dispatch runs on the default",
    impact: "reviews run at the wrong tier and the wave cap is computed from a stale number",
    suggested_fix: "pass the resolved tier through to the child",
    evidence: "ran the harness; the child argv carried no tier flag",
    file: "src/harness/child/spawn.ts",
    class_scope: {
      sites: ["src/harness/child/spawn.ts:155"],
      enumeration_method: "every call site of the spawn helper inside the computed set",
    },
    ...over,
  };
}

test("AC3: `no-link-to-change` does not delete a blocker regression about a dependent", async () => {
  await fresh();
  // Rule 1 admits anything anchored in `radius.files` — the hop-1/hop-2
  // dependents, which by construction are NOT changed files — while
  // `changeTokens` is built only from `changedFiles`. So a true regression about
  // a dependent, described without naming the changed file, was rejected and
  // filtered out of findings.json, and the gate never saw it. Before the screen
  // was wired this blocker was persisted and blocked completion.
  const { findings, scopeBScreen } = await ingestUnnamed({
    findings: [dependentRegression()],
    blastRadius: DEPENDENT_RADIUS,
  });

  expect(scopeBScreen.screen?.rejected).toEqual([]);
  expect(scopeBScreen.screen?.accepted).toHaveLength(1);
  expect(findings.map((finding) => finding.id)).toContain("F-300");
});

test("AC3: rule 3 still holds a major to naming the change, and says so out loud", async () => {
  await fresh();
  // The deliberate line. The exemption is placed where the cost of a wrong
  // rejection is unrecoverable — a refused blocker is a shipped break — and
  // nowhere else, because including `radius.files` in the tokens (or skipping
  // rule 3 for anything rule 1 anchored) makes the rule unfireable and lets the
  // untouched-hop-2 style `major` back into findings.json.
  const { findings, path: pkg, scopeBScreen } = await ingestUnnamed({
    findings: [dependentRegression({ id: "F-301", severity: "major" })],
    blastRadius: DEPENDENT_RADIUS,
  });
  const scope = await readFile(path.join(ROOT, pkg, "scope.md"), "utf8");

  expect(scopeBScreen.screen?.rejected.map((rejection) => rejection.rule)).toEqual(["no-link-to-change"]);
  expect(findings.map((finding) => finding.id)).not.toContain("F-301");
  // Removed, never silent: the id and the rule are both in the record, and the
  // block cannot be read as "there was nothing".
  expect(scope).toContain("## Scope B rejections");
  expect(scope).toContain("F-301");
  expect(scope).toContain("no-link-to-change");
  expect(scope).toContain("scope_b_findings: 1");
});
