// Flow 308, AC3/AC4/AC5: deterministic state gathering for each clause kind.
// Invented content throughout (AC10) — no real PR body, report, or diff.

import { describe, expect, test } from "bun:test";
import { extractReferenceClauses, applyClauseTags } from "./conform-clauses";
import {
  classifyFindingAnchor,
  computePrConformFacts,
  computeReportConformFacts,
  hunkClauseFacts,
  hunkRegionsFromDiff,
  parsePrBodySections,
  parseReportSections,
  prClauseFacts,
  prRedactedStateText,
  reportClauseFacts,
} from "./conform-state";

function taggedClause(text: string): ReturnType<typeof applyClauseTags>[number] {
  const raw = extractReferenceClauses(`# H\n\n- ${text}`);
  return applyClauseTags(raw, new Map())[0]!;
}

describe("AC3: pr-kind state", () => {
  test("parsePrBodySections splits named sections and reports emptiness", () => {
    const body = ["## Summary", "Does a thing.", "", "## Out of Scope", "", "## Testing", "Unit tests added."].join("\n");
    const sections = parsePrBodySections(body);
    expect(sections.map((s) => s.heading)).toEqual(["Summary", "Out of Scope", "Testing"]);
    expect(sections.find((s) => s.heading === "Out of Scope")?.nonEmpty).toBe(false);
    expect(sections.find((s) => s.heading === "Testing")?.nonEmpty).toBe(true);
  });

  test("computePrConformFacts excludes mechanical bulk via buildReviewScope", () => {
    const diff = [
      "diff --git a/src/real.ts b/src/real.ts",
      "index 111..222 100644",
      "--- a/src/real.ts",
      "+++ b/src/real.ts",
      "@@ -1,2 +1,3 @@",
      " context line",
      "+a genuinely new hand-written line",
      " context line",
      "diff --git a/bun.lock b/bun.lock",
      "index 333..444 100644",
      "--- a/bun.lock",
      "+++ b/bun.lock",
      "@@ -1,1 +1,2 @@",
      " x",
      "+lockfile churn",
      "",
    ].join("\n");
    const facts = computePrConformFacts({ title: "t", body: "## Testing\nyes", diff });
    expect(facts.scope.counts.filesRetained).toBe(1);
    expect(facts.scope.counts.filesDropped).toBe(1);
    expect(facts.scope.counts.droppedByReason.lockfile).toBe(1);
    expect(facts.scope.counts.changedLinesRetained).toBe(1);
  });

  test("a clause naming a size budget produces a decisive fact", () => {
    const diff = ["diff --git a/src/x.ts b/src/x.ts", "--- a/src/x.ts", "+++ b/src/x.ts", "@@ -1 +1,2 @@", " a", "+b", ""].join("\n");
    const facts = computePrConformFacts({ title: "t", body: "", diff });
    const clause = taggedClause("A contribution changes no more than 900 lines in total.");
    const result = prClauseFacts(clause, facts);
    expect(result.decisive).toEqual({ satisfied: true, reason: expect.stringContaining("within") as unknown as string });
  });

  test("a clause with no numeric budget produces no decisive fact", () => {
    const diff = ["diff --git a/src/x.ts b/src/x.ts", "--- a/src/x.ts", "+++ b/src/x.ts", "@@ -1 +1,2 @@", " a", "+b", ""].join("\n");
    const facts = computePrConformFacts({ title: "t", body: "", diff });
    const clause = taggedClause("The PR body names an explicit Out of Scope section.");
    const result = prClauseFacts(clause, facts);
    expect(result.decisive).toBeUndefined();
  });

  test("prRedactedStateText redacts and bounds the body", () => {
    const text = prRedactedStateText({ title: "My title", body: "sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(text).toContain("My title");
    expect(text).not.toContain("sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
});

describe("AC4: report-kind state", () => {
  test("parseReportSections reads the report's own section order", () => {
    const md = ["# Report", "## Findings", "text", "## Decisions", "text"].join("\n");
    expect(parseReportSections(md).map((s) => s.heading)).toEqual(["Report", "Findings", "Decisions"]);
  });

  test("classifyFindingAnchor distinguishes file+line, file-only, and none", () => {
    expect(classifyFindingAnchor({ file: "src/x.ts", line: 10 })).toBe("file-and-line");
    expect(classifyFindingAnchor({ file: "src/x.ts" })).toBe("file-only");
    expect(classifyFindingAnchor({})).toBe("none");
  });

  test("computeReportConformFacts counts missing severity/evidence and anchor kindes", () => {
    const findings = [
      { id: "F-1", severity: "major", evidence: "e", file: "a.ts", line: 5 },
      { id: "F-2", severity: "", evidence: "e", file: "a.ts" },
      { id: "F-3", severity: "minor", evidence: "", file: undefined },
    ];
    const facts = computeReportConformFacts("# Report\n## Findings\n", findings);
    expect(facts.findingsCount).toBe(3);
    expect(facts.findingsMissingSeverity).toBe(1);
    expect(facts.findingsMissingEvidence).toBe(1);
    expect(facts.anchorCounts).toEqual({ "file-and-line": 1, "file-only": 1, none: 1 });
  });

  test("missing severity/evidence produces a decisive (unsatisfied) fact", () => {
    const facts = computeReportConformFacts("# R", [{ id: "F-1", evidence: "" }]);
    const clause = taggedClause("Every finding names a severity, evidence and a anchor kind.");
    const result = reportClauseFacts(clause, facts);
    expect(result.decisive?.satisfied).toBe(false);
  });
});

describe("AC5: hunk-kind state reuses buildReviewScope's blocks unchanged", () => {
  test("hunkRegionsFromDiff returns the same regions buildReviewScope would", () => {
    const diff = [
      "diff --git a/src/x.ts b/src/x.ts",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1,2 +1,3 @@",
      " context",
      "+new hand-written line",
      " context",
      "",
    ].join("\n");
    const regions = hunkRegionsFromDiff(diff);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.path).toBe("src/x.ts");
    const facts = hunkClauseFacts(regions[0]!);
    expect(facts.factLines[0]).toContain("src/x.ts");
  });
});
