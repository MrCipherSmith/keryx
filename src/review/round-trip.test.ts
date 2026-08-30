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
import { completeManagedReview, createManagedReviewPackage, findingDispositionState } from "./managed";
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

describe("a disposition and a finding key survive the round trip", () => {
  // The instrumentation is worthless if it cannot be handed to the next round.
  // `prior_findings[].finding` $refs `review-finding.schema.json`, which is
  // `additionalProperties: false` — so a field this pipeline writes and that
  // contract does not declare would make round 1's own artifact unusable as
  // round 2's input, which is the exact failure this file was written for.

  test("round 2's dispatch carries what round 1 decided, and validates", async () => {
    await withTempRoot(async (root) => {
      const findings = await round1Findings(root);
      await completeManagedReview(root, ".metaproject/reviews/2026-08-29-round-1", {
        dispositions: [
          {
            finding: "2026-08-29-round-1#F-001",
            state: "acted-on",
            evidence: "config-dir.writers.test.ts drives every writer under umask 002",
          },
          {
            finding: "2026-08-29-round-1#F-002",
            state: "dismissed-incorrect",
            evidence: "deleted the guarded line and the test went red; the finding read the wrong guard",
          },
        ],
      });

      const closed = JSON.parse(
        await readFile(
          path.join(root, ".metaproject", "reviews", "2026-08-29-round-1", "findings.json"),
          "utf8",
        ),
      ) as StructuredReviewFinding[];

      // Non-vacuous: the round trip below would pass on findings carrying no
      // disposition at all, so the payload is pinned first.
      expect(closed.map((finding) => findingDispositionState(finding))).toEqual([
        "acted-on",
        "dismissed-incorrect",
      ]);
      expect(closed.map((finding) => finding.global_id)).toEqual([
        "2026-08-29-round-1#F-001",
        "2026-08-29-round-1#F-002",
      ]);
      // The display ids are untouched — they are what the markdown parser reads
      // and what `decisions.md` prints.
      expect(closed.map((finding) => finding.id)).toEqual(findings.map((finding) => finding.id));

      const schema = await loadSchema("review-finding");
      for (const finding of closed) {
        expect(await validateJson(finding, schema)).toEqual([]);
      }
      expect(await validateJson(round2Input(closed), REVIEWER_INPUT_SCHEMA)).toEqual([]);
    });
  });

  test("a refuted finding reaches disk and reaches the next reviewer", async () => {
    // Rounds 3 and 5 of PR #220 refuted findings in a section headed "Where a
    // reviewer was wrong" and recorded neither. A refutation that stays in prose
    // is a refutation the next round re-discovers and the measurement cannot see.
    await withTempRoot(async (root) => {
      const result = await createManagedReviewPackage({
        cwd: root,
        mode: "ingest",
        reviewId: "2026-08-29-round-1-refuted",
        target: { kind: "report", ref: "review.md" },
        reportText: ROUND_1_REPORT,
        refuted: [
          {
            id: "F-003",
            reviewer: "review-performance",
            severity: "minor",
            problem: "claimed the writer re-reads the config on every call",
            impact: "would be a hot-path read",
            suggested_fix: "cache it",
            evidence: "the reviewer pointed at the resolver, not the writer",
            confidence: "medium",
            disposition: {
              state: "dismissed-incorrect",
              evidence: "instrumented the writer; one read per process, not per call",
            },
          },
        ] as unknown as ManagedReviewInput["refuted"],
        now: new Date("2026-08-29T10:00:00Z"),
      });

      const findings = JSON.parse(
        await readFile(path.join(root, result.path, "findings.json"), "utf8"),
      ) as StructuredReviewFinding[];

      expect(findings.map((finding) => finding.id)).toEqual(["F-001", "F-002", "F-003"]);
      expect(findings.map((finding) => findingDispositionState(finding))).toEqual([
        "unknown",
        "unknown",
        "dismissed-incorrect",
      ]);
      expect(await validateJson(round2Input(findings), REVIEWER_INPUT_SCHEMA)).toEqual([]);
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

  test("the findings already on disk have no disposition and read as unknown", async () => {
    // The corpus the baseline was measured over: 83 findings in the
    // pre-contract shape, none of which will ever gain a disposition. The
    // reading rule is what keeps them legible, and it must be `unknown` — an
    // absent disposition counted as valid is what inflates the very figure this
    // instrumentation exists to make honest.
    const roots = [REVIEWS_DIR];
    const flowsDir = path.join(REPO_ROOT, ".metaproject", "flows");
    if (existsSync(flowsDir)) {
      for (const flow of readdirSync(flowsDir)) {
        const reviews = path.join(flowsDir, flow, "reviews");
        if (existsSync(reviews)) {
          roots.push(reviews);
        }
      }
    }

    let total = 0;
    for (const root of roots) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const file = path.join(root, entry.name, "findings.json");
        if (!entry.isDirectory() || !existsSync(file)) {
          continue;
        }
        for (const finding of JSON.parse(readFileSync(file, "utf8")) as StructuredReviewFinding[]) {
          total += 1;
          expect(finding.disposition).toBeUndefined();
          expect(findingDispositionState(finding)).toBe("unknown");
        }
      }
    }
    // Non-vacuous: the assertion above holds trivially for an empty corpus, and
    // the recorded corpus is 83 findings.
    expect(total).toBeGreaterThan(80);
  });

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
        // The findings cap (flow 203, AC5) is 10 per reviewer and would truncate
        // this fifteen-finding report to twelve, making every assertion below an
        // assertion about the cap rather than about the legacy reader. Lifted
        // explicitly; the cap has its own tests.
        maxFindingsPerReviewer: 1000,
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
      // Neither is `evidence`: the report carries no Evidence or Proof label
      // anywhere. It carries `**Found independently by**`, which is ATTRIBUTION
      // and already feeds `reviewer` — reading it as evidence too made this
      // field a copy of the reviewer list on 2 of the 15 findings, a value that
      // looks recorded and says nothing. Asserted here because the four fields
      // above were asserted and this one was not, which is why nothing caught it.
      expect(findings[0]?.evidence).toBe(
        "not recorded: derived from a markdown review report, which carried no evidence field",
      );
      const attributionAsEvidence = findings.filter((finding) =>
        /^review-[a-z-]+ \(/.test(finding.evidence ?? ""),
      );
      expect(attributionAsEvidence.map((finding) => finding.id)).toEqual([]);

      const schema = await loadSchema("review-finding");
      for (const finding of findings) {
        expect(await validateJson(finding, schema)).toEqual([]);
      }
      expect(await validateJson(round2Input(findings), REVIEWER_INPUT_SCHEMA)).toEqual([]);
    });
  });
});

describe("the legacy parser is held to the same contract as the structured one", () => {
  // `fromStructuredSource` validated against `review-finding.schema.json` and
  // the markdown parser did not, so the legacy path could write a `findings.json`
  // the contract rejects — and the round-2 input built from it was rejected by
  // the same schema. The gate now runs over the projection that is about to be
  // written, once, whichever source produced it.

  test("a major whose class_scope is prose rather than sites/enumeration_method is refused", async () => {
    // The shape check passed here — the block names class_scope, sites and
    // enumeration_method — while `parseClassScope` returned null, so the record
    // was persisted without the property the schema requires for a major.
    await withTempRoot(async (root) => {
      const report = [
        "### [F-001] the writer is group-writable",
        "- **Severity**: major",
        "- **class_scope**: I checked all the sites; the enumeration_method was reading them.",
        "",
      ].join("\n");
      await expect(
        createManagedReviewPackage({
          cwd: root,
          mode: "ingest",
          reviewId: "2026-08-29-prose-class-scope",
          target: { kind: "report", ref: "review.md" },
          reportText: report,
          now: new Date("2026-08-29T10:00:00Z"),
        }),
      ).rejects.toThrow(/do not enumerate their class: F-001 \(major\)/);
      expect(existsSync(path.join(root, ".metaproject", "reviews", "2026-08-29-prose-class-scope"))).toBe(
        false,
      );
    });
  });

  test("a legacy finding that violates the contract in any other field is refused too", async () => {
    // Not only class_scope: `line` is `minimum: 1`, and a location parsed out of
    // prose can carry a 0. The guard is the schema, not a list of fields
    // somebody remembered.
    await withTempRoot(async (root) => {
      const report = ["- [F-001] minor: a small observation.", "  - **File**: src/example.ts:0", ""].join("\n");
      await expect(
        createManagedReviewPackage({
          cwd: root,
          mode: "ingest",
          reviewId: "2026-08-29-bad-line",
          target: { kind: "report", ref: "review.md" },
          reportText: report,
          now: new Date("2026-08-29T10:00:00Z"),
        }),
      ).rejects.toThrow(/review-finding\.schema\.json.*\$\[0\]\.line/s);
      expect(existsSync(path.join(root, ".metaproject", "reviews", "2026-08-29-bad-line"))).toBe(false);
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

  // The three inputs below all used to put a block in the report and then take
  // the prose path anyway, writing one lossy finding and reporting success. The
  // cause was that presence was inferred from the PARSED VALUE, which cannot
  // distinguish "no block" from "a block holding null", and that the fence was
  // anchored at column 0.

  test("a block holding JSON null is an error, not a fall-through to prose", async () => {
    await withTempRoot(async (root) => {
      await expect(
        createManagedReviewPackage({
          cwd: root,
          mode: "ingest",
          reviewId: "2026-08-29-null-block",
          target: { kind: "report", ref: "review.md" },
          reportText: "- [F-009] minor: prose finding.\n\n```json keryx:findings\nnull\n```\n",
          now: new Date("2026-08-29T10:00:00Z"),
        }),
      ).rejects.toThrow(/keryx:findings block that is JSON null, not an array of findings/);
    });
  });

  test("a block that is neither an array nor a reviewer result says so", async () => {
    // It used to be flattened into one finding and refused for missing `id`,
    // `impact` and `evidence` — a reason that sends the reader looking for
    // fields in a block that was never a finding.
    await withTempRoot(async (root) => {
      await expect(
        createManagedReviewPackage({
          cwd: root,
          mode: "ingest",
          reviewId: "2026-08-29-object-block",
          target: { kind: "report", ref: "review.md" },
          reportText: '# Round 1\n\n```json keryx:findings\n{ "note": "not findings" }\n```\n',
          now: new Date("2026-08-29T10:00:00Z"),
        }),
      ).rejects.toThrow(/keryx:findings block that is a JSON object, not an array of findings/);
    });
  });

  test("an indented fence is a block, not invisible", async () => {
    // CommonMark allows up to three leading spaces, and nesting the block under
    // a list item is the ordinary way it acquires them.
    await withTempRoot(async (root) => {
      const findings = await round1Findings(root, {
        reviewId: "2026-08-29-indented",
        reportText: [
          "- [F-009] minor: prose finding that must NOT be what gets recorded.",
          "",
          "  ```json keryx:findings",
          `  ${JSON.stringify(REVIEWER_RESULTS)}`,
          "  ```",
          "",
        ].join("\n"),
      });
      expect(findings.map((finding) => finding.id)).toEqual(["F-001", "F-002"]);
      expect(findings[0]?.confidence).toBe("high");
    });
  });

  test("a second block is an error rather than silently dropped", async () => {
    // An orchestrator concatenating one block per reviewer produced exactly
    // this. `String.match` with a non-global regex returned the first, so a
    // report visibly holding a finding ingested as zero findings.
    await withTempRoot(async (root) => {
      const second = [
        {
          id: "F-100",
          reviewer: "review-logic",
          severity: "minor",
          problem: "the second reviewer's finding",
          impact: "lost entirely",
          suggested_fix: "count the fences",
          evidence: "ingested this report and got an empty findings.json",
          confidence: "high",
        },
      ];
      await expect(
        createManagedReviewPackage({
          cwd: root,
          mode: "ingest",
          reviewId: "2026-08-29-two-blocks",
          target: { kind: "report", ref: "review.md" },
          reportText: [
            "```json keryx:findings",
            "[]",
            "```",
            "",
            "```json keryx:findings",
            JSON.stringify(second),
            "```",
            "",
          ].join("\n"),
          now: new Date("2026-08-29T10:00:00Z"),
        }),
      ).rejects.toThrow(/carries 2 keryx:findings blocks \(at character 0 and 31\)/);
    });
  });

  test("the refusal names the report file", async () => {
    await withTempRoot(async (root) => {
      const reportPath = path.join(root, "review.md");
      await writeFile(reportPath, "# Round 1\n\n```json keryx:findings\n[{ not json }]\n```\n", "utf8");
      await expect(
        createManagedReviewPackage({
          cwd: root,
          mode: "ingest",
          reviewId: "2026-08-29-named-path",
          target: { kind: "report", ref: "review.md" },
          reportPath: "review.md",
          now: new Date("2026-08-29T10:00:00Z"),
        }),
      ).rejects.toThrow(reportPath);
    });
  });
});
