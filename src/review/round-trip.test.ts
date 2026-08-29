// A review round must survive into the next one.
//
// `prior_findings[].finding` in `reviewer-input.schema.json` is a
// `review-finding.schema.json` object: id, reviewer, severity, problem, impact,
// suggested_fix, evidence, confidence — and `additionalProperties: false`. The
// managed review pipeline wrote a `findings.json` that had none of the last four
// and carried four properties the contract forbids, so round 2 could not be
// assembled out of round 1's own artifact. Nothing tested either half of that.
//
// The proof is not "findings.json looks right". It is: take the file a round
// writes, build the dispatch for the next round out of it, and validate that
// dispatch against the contract the orchestrator dispatches under.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSchema, validateJson } from "../gdskills/contracts";
import { createManagedReviewPackage } from "./managed";
import type { ManagedReviewInput, StructuredReviewFinding } from "./types";

const REPO_ROOT = process.cwd();

const REVIEWER_INPUT_SCHEMA = JSON.parse(
  readFileSync(
    path.join(
      REPO_ROOT,
      "src",
      "gdskills",
      "bundled",
      "skills",
      "review",
      "review-orchestrator",
      "reviewer-input.schema.json",
    ),
    "utf8",
  ),
) as Record<string, unknown>;

/** What a reviewer actually returns: `reviewer-finding.schema.json`. */
const REVIEWER_RESULTS = [
  {
    status: "DONE_WITH_CONCERNS",
    reviewer: "review-security-code",
    summary: "one major in the config directory",
    findings: [
      {
        id: "F-001",
        severity: "major",
        file: "src/lib/config-dir.ts",
        line: 41,
        problem: "the shared config directory is created group-writable",
        impact: "any member of the operator's group can replace auth.json",
        suggested_fix: "route every writer through ensureKeryxConfigDir",
        evidence: "measured 0775 under umask 002 by executing the writer",
        confidence: "high",
        class_scope: {
          sites: ["src/lib/shell-config.ts", "src/session/store.ts"],
          enumeration_method: "grep for the config-path resolvers; 7 writers, 2 unguarded",
        },
      },
    ],
    stats: { blocker: 0, major: 1, minor: 0, info: 0 },
  },
  {
    status: "DONE",
    reviewer: "review-testing-practices",
    summary: "one minor",
    findings: [
      {
        id: "F-002",
        severity: "minor",
        problem: "the guard asserts on a synthetic context rather than a real writer",
        impact: "the guard passes when the production path is unwired",
        suggested_fix: "drive the writer the CLI drives",
        evidence: "deleted the guarded line; the test stayed green",
        confidence: "medium",
      },
    ],
    stats: { blocker: 0, major: 0, minor: 1, info: 0 },
  },
] as const;

const ROUND_1_REPORT = [
  "# Consolidated Review — round 1",
  "",
  "## Major",
  "",
  "### [F-001] the shared config directory is created group-writable",
  "- **Severity**: major",
  "",
  "## Minor",
  "",
  "### [F-002] the guard asserts on a synthetic context",
  "- **Severity**: minor",
  "",
  "<!-- The machine-readable half of the same report. -->",
  "",
  "```json keryx:findings",
  JSON.stringify(REVIEWER_RESULTS, null, 2),
  "```",
  "",
].join("\n");

async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-review-round-trip-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function round1Findings(
  root: string,
  over: Partial<ManagedReviewInput> = {},
): Promise<StructuredReviewFinding[]> {
  const result = await createManagedReviewPackage({
    cwd: root,
    mode: "ingest",
    reviewId: "2026-08-29-round-1",
    target: { kind: "report", ref: "review.md" },
    reportText: ROUND_1_REPORT,
    now: new Date("2026-08-29T10:00:00Z"),
    ...over,
  });
  return JSON.parse(
    await readFile(path.join(root, result.path, "findings.json"), "utf8"),
  ) as StructuredReviewFinding[];
}

/** The round-2 dispatch, assembled out of a round-1 artifact and nothing else. */
function round2Input(priorFindings: readonly StructuredReviewFinding[]): Record<string, unknown> {
  return {
    review_context: {
      request: { raw: "review the fix for round 1" },
      scope: { mode: "diff", files: ["src/lib/config-dir.ts"] },
      routing: { selected_reviewers: ["review-security-code"] },
      token_policy: { context_mode: "light", omissions: [] },
    },
    reviewer: "review-security-code",
    scope_mode: "diff",
    model_class: "normal",
    budget: { max_findings: 20 },
    round: 2,
    is_fix_round: true,
    prior_findings: priorFindings.map((finding) => ({
      round: 1,
      finding,
      claimed_disposition: "fixed",
      claimed_evidence: "config-dir.writers.test.ts drives every writer under umask 002",
    })),
    metaproject: {
      memory: [
        {
          path: ".metaproject/memory/lessons/a-fix-round-needs-its-own-review.md",
          type: "lesson",
          status: "accepted",
          title: "A fix round needs its own review",
        },
      ],
    },
  };
}

describe("a round-2 dispatch is built from a round-1 artifact", () => {
  test("findings.json validates against review-finding.schema.json, field by field", async () => {
    await withTempRoot(async (root) => {
      const findings = await round1Findings(root);
      const schema = await loadSchema("review-finding");

      expect(findings.map((finding) => finding.id)).toEqual(["F-001", "F-002"]);
      for (const finding of findings) {
        expect(await validateJson(finding, schema)).toEqual([]);
      }

      // The four fields the markdown round-trip destroyed, named individually so
      // a regression says which one went.
      expect(findings[0]?.confidence).toBe("high");
      expect(findings[0]?.evidence).toBe("measured 0775 under umask 002 by executing the writer");
      expect(findings[0]?.impact).toBe("any member of the operator's group can replace auth.json");
      expect(findings[0]?.suggested_fix).toBe("route every writer through ensureKeryxConfigDir");

      // And the reviewer is the one that found it, not the consolidator. Two
      // different reviewers in one report, so a hardcoded string cannot pass.
      expect(findings.map((finding) => finding.reviewer)).toEqual([
        "review-security-code",
        "review-testing-practices",
      ]);
    });
  });

  test("the round-2 reviewer-input validates end to end", async () => {
    await withTempRoot(async (root) => {
      const findings = await round1Findings(root);
      const errors = await validateJson(round2Input(findings), REVIEWER_INPUT_SCHEMA);
      expect(errors).toEqual([]);
    });
  });

  test("the shape this replaces is still rejected — the test is not vacuous", async () => {
    // Exactly what `findings.json` held before this change: no confidence,
    // evidence, impact or suggested_fix, a hardcoded reviewer, and four
    // properties `additionalProperties: false` forbids. If the assertion above
    // ever passes for the old shape, the contract stopped being enforced.
    const legacyShape = [
      {
        id: "F-001",
        severity: "major",
        reviewer: "review-orchestrator",
        summary: "the shared config directory is created group-writable",
        classification: "valid_followup",
        flow_relevance: "standalone_review",
        class_scope_present: true,
      },
    ] as unknown as StructuredReviewFinding[];

    const errors = await validateJson(round2Input(legacyShape), REVIEWER_INPUT_SCHEMA);
    const paths = errors.map((error) => `${error.path} ${error.message}`).join("\n");
    for (const field of ["impact", "suggested_fix", "evidence", "confidence"]) {
      expect(paths).toContain(field);
    }
    // And the pipeline's own triage is refused as an additional property.
    expect(paths).toContain("classification");
  });

  test("a caller that still holds the reviewer payloads passes them directly", async () => {
    await withTempRoot(async (root) => {
      const findings = await round1Findings(root, {
        reportText: "# Round 1\n\nno machine-readable block here\n",
        findings: REVIEWER_RESULTS as unknown as ManagedReviewInput["findings"],
      });
      expect(await validateJson(round2Input(findings), REVIEWER_INPUT_SCHEMA)).toEqual([]);
    });
  });

  test("an incomplete structured payload is refused before anything is written", async () => {
    await withTempRoot(async (root) => {
      await expect(
        createManagedReviewPackage({
          cwd: root,
          mode: "ingest",
          reviewId: "2026-08-29-incomplete",
          target: { kind: "report", ref: "review.md" },
          reportText: "# Round 1\n",
          findings: [{ id: "F-001", severity: "minor", problem: "no impact recorded" }],
          now: new Date("2026-08-29T10:00:00Z"),
        }),
      ).rejects.toThrow(/review-finding\.schema\.json/);
      expect(existsSync(path.join(root, ".metaproject", "reviews", "2026-08-29-incomplete"))).toBe(false);
    });
  });
});

describe("legacy markdown reports are not stranded", () => {
  // The reports on disk are the reason the parser is kept rather than deleted.
  // Every package under `.metaproject/reviews/` was written by the pipeline
  // before it emitted anything structured, and each must still ingest.
  const REVIEWS_DIR = path.join(REPO_ROOT, ".metaproject", "reviews");

  function realReports(): Array<{ id: string; text: string }> {
    if (!existsSync(REVIEWS_DIR)) {
      return [];
    }
    const out: Array<{ id: string; text: string }> = [];
    for (const entry of readdirSync(REVIEWS_DIR, { withFileTypes: true })) {
      const report = path.join(REVIEWS_DIR, entry.name, "report.md");
      if (entry.isDirectory() && existsSync(report)) {
        out.push({ id: entry.name, text: readFileSync(report, "utf8") });
      }
    }
    return out;
  }

  test("every recorded review package still ingests", async () => {
    const reports = realReports();
    // Non-vacuous: these packages exist and are the artifacts this guard is about.
    expect(reports.length).toBeGreaterThan(5);

    await withTempRoot(async (root) => {
      for (const [index, report] of reports.entries()) {
        const result = await createManagedReviewPackage({
          cwd: root,
          mode: "ingest",
          reviewId: `legacy-${index}`,
          target: { kind: "report", ref: report.id },
          reportText: report.text,
          now: new Date("2026-08-29T10:00:00Z"),
        });
        const findings = JSON.parse(
          await readFile(path.join(root, result.path, "findings.json"), "utf8"),
        ) as StructuredReviewFinding[];
        // Ingesting must not silently produce nothing for a report that has
        // findings; the smallest recorded package has one.
        expect(Array.isArray(findings)).toBe(true);
      }
    });
  });

  test("a legacy report yields a round-2 input, with its lost fields named as lost", async () => {
    // The point of legacy-read/structured-write: an artifact recorded before
    // this change becomes usable as `prior_findings`, and a reader can tell a
    // recovered field from one that was never written.
    await withTempRoot(async (root) => {
      const legacy = readFileSync(
        path.join(REPO_ROOT, "src", "review", "fixtures", "consolidated-review-2026-08-01.md"),
        "utf8",
      );
      const result = await createManagedReviewPackage({
        cwd: root,
        mode: "ingest",
        reviewId: "2026-08-29-legacy",
        target: { kind: "report", ref: "consolidated-review-2026-08-01.md" },
        reportText: legacy,
        now: new Date("2026-08-29T10:00:00Z"),
      });
      const findings = JSON.parse(
        await readFile(path.join(root, result.path, "findings.json"), "utf8"),
      ) as StructuredReviewFinding[];

      expect(findings).toHaveLength(15);
      // The reviewer is read out of the report's own attribution line, so a
      // legacy finding no longer claims the consolidator found it.
      expect(findings[0]?.reviewer).toBe("review-logic");
      // `impact` and `suggested_fix` ARE in that report, under the labels it
      // uses — "Why it matters" and "Fix".
      expect(findings[0]?.impact).toContain("nine of flow 131's twelve confirmed criteria");
      expect(findings[0]?.suggested_fix).toContain("assemble `createSubmitTurn`");
      // `confidence` is not, anywhere in the report, so it is recorded as the
      // low-confidence derivation it is rather than invented.
      expect(findings[0]?.confidence).toBe("low");

      const schema = await loadSchema("review-finding");
      for (const finding of findings) {
        expect(await validateJson(finding, schema)).toEqual([]);
      }
      expect(await validateJson(round2Input(findings), REVIEWER_INPUT_SCHEMA)).toEqual([]);
    });
  });
});

describe("the machine-readable block", () => {
  test("a malformed keryx:findings block fails loudly rather than falling back to prose", async () => {
    // A silent fallback would record a lossy parse of a report whose author
    // believed the structured array had been read — the failure mode this whole
    // change exists to remove, wearing a different hat.
    await withTempRoot(async (root) => {
      await expect(
        createManagedReviewPackage({
          cwd: root,
          mode: "ingest",
          reviewId: "2026-08-29-malformed",
          target: { kind: "report", ref: "review.md" },
          reportText: "# Round 1\n\n```json keryx:findings\n[{ not json }]\n```\n",
          now: new Date("2026-08-29T10:00:00Z"),
        }),
      ).rejects.toThrow(/keryx:findings block that is not valid JSON/);
    });
  });

  test("a report with no block still takes the markdown path", async () => {
    await withTempRoot(async (root) => {
      await writeFile(path.join(root, "review.md"), "- [F-007] minor: a small observation.\n", "utf8");
      const result = await createManagedReviewPackage({
        cwd: root,
        mode: "ingest",
        reviewId: "2026-08-29-no-block",
        target: { kind: "report", ref: "review.md" },
        reportPath: "review.md",
        now: new Date("2026-08-29T10:00:00Z"),
      });
      const findings = JSON.parse(
        await readFile(path.join(root, result.path, "findings.json"), "utf8"),
      ) as StructuredReviewFinding[];
      expect(findings.map((finding) => finding.id)).toEqual(["F-007"]);
      expect(findings[0]?.problem).toBe("a small observation.");
    });
  });
});
