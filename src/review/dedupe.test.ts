import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { codeTokens, isDuplicate, knownFindingsForWave, mergeDuplicates, problemSimilarity, renderDuplicatesMarkdown } from "./dedupe";
import { createManagedReviewPackage } from "./managed";
import type { StructuredReviewFinding } from "./types";

function finding(over: Partial<StructuredReviewFinding> = {}): StructuredReviewFinding {
  return {
    id: "F-001",
    reviewer: "review-logic",
    severity: "minor",
    problem: "the retry loop never resets the attempt counter after a success",
    impact: "later failures give up immediately",
    suggested_fix: "reset attempts on success",
    evidence: "read the loop",
    confidence: "medium",
    file: "src/retry.ts",
    line: 10,
    ...over,
  };
}

describe("isDuplicate", () => {
  test("same file, nearby line, same mechanism, different reviewers", () => {
    expect(
      isDuplicate(
        finding(),
        finding({ id: "F-002", reviewer: "review-regression", line: 12, problem: "attempt counter is never reset after success in the retry loop" }),
      ),
    ).toBe(true);
  });

  test("never across files, even when everything else matches", () => {
    expect(isDuplicate(finding(), finding({ id: "F-002", reviewer: "review-regression", file: "src/other.ts" }))).toBe(false);
  });

  test("lines further apart than 3 are different sites unless the quote matches", () => {
    const far = finding({ id: "F-002", reviewer: "review-regression", line: 14 });
    expect(isDuplicate(finding(), far)).toBe(false);
    expect(
      isDuplicate(finding({ quote: "attempts += 1;" }), { ...far, quote: "  attempts  +=  1; " }),
    ).toBe(true);
  });

  test("the same reviewer reporting two findings at one site meant two", () => {
    expect(isDuplicate(finding(), finding({ id: "F-002" }))).toBe(false);
  });

  test("a different mechanism at the same site is not a duplicate", () => {
    expect(
      isDuplicate(finding(), finding({ id: "F-002", reviewer: "review-security-code", problem: "user-controlled url is fetched without an allowlist (SSRF)" })),
    ).toBe(false);
  });

  test("differing dedupe_key or symbol vetoes; equal dedupe_key decides", () => {
    const other = finding({ id: "F-002", reviewer: "review-regression" });
    expect(isDuplicate(finding({ dedupe_key: "a" }), { ...other, dedupe_key: "b" })).toBe(false);
    expect(isDuplicate(finding({ symbol: "retry" }), { ...other, symbol: "backoff" })).toBe(false);
    expect(
      isDuplicate(finding({ dedupe_key: "k" }), { ...other, dedupe_key: "k", problem: "something phrased entirely otherwise" }),
    ).toBe(true);
  });

  test("problem similarity is a word overlap, not substring luck", () => {
    expect(problemSimilarity("a b c", "")).toBe(0);
    expect(problemSimilarity("handler throws on empty input", "handlers throw on empty inputs")).toBeGreaterThanOrEqual(0.5);
  });
});

describe("mergeDuplicates", () => {
  test("keeps the highest severity, every reporter and every evidence", () => {
    const { findings, merges } = mergeDuplicates([
      finding({ global_id: "r#F-001", evidence: "logic read" }),
      finding({
        id: "F-002",
        global_id: "r#F-002",
        reviewer: "review-regression",
        severity: "major",
        evidence: "ran the test",
        class_scope: { sites: ["src/retry.ts:10"], enumeration_method: "rg attempts" },
      }),
      finding({ id: "F-003", global_id: "r#F-003", reviewer: "review-style", file: "src/other.ts" }),
    ]);
    expect(findings).toHaveLength(2);
    const merged = findings[0];
    expect(merged?.severity).toBe("major");
    expect(merged?.reviewer).toBe("review-regression");
    expect(merged?.reported_by).toEqual(["review-regression", "review-logic"]);
    expect(merged?.merged_from).toEqual(["r#F-001"]);
    expect(merged?.evidence).toContain("ran the test");
    expect(merged?.evidence).toContain("logic read");
    expect(merges).toEqual([
      {
        kept: "r#F-002",
        absorbed: ["r#F-001"],
        reportedBy: ["review-regression", "review-logic"],
        severity: "major",
        severityRule: "max",
        reportedSeverities: ["major", "minor"],
      },
    ]);
    expect(findings[1]?.id).toBe("F-003");
  });

  test("a verifier-confirmed severity is canonical over a higher unconfirmed one", () => {
    const { findings, merges } = mergeDuplicates([
      finding({ severity: "minor", verification: { verdict: "confirmed", method: "execution", evidence: "test red", verifier: "review-verifier" } }),
      finding({
        id: "F-002",
        reviewer: "review-regression",
        severity: "blocker",
        class_scope: { sites: ["src/retry.ts:10"], enumeration_method: "rg" },
      }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("minor");
    expect(findings[0]?.verification?.verdict).toBe("confirmed");
    expect(merges[0]?.severityRule).toBe("verified");
    // The duplicates block says the lower confirmed severity beat the higher unconfirmed one, and whose it was.
    expect(merges[0]?.outranked).toEqual({ severity: "blocker", reviewer: "review-regression", id: "F-002" });
    expect(renderDuplicatesMarkdown(merges)).toContain("the confirmed minor outranks the unconfirmed blocker of review-regression (F-002)");
  });

  test("a premise judge's downgraded severity is canonical over a higher re-statement (flow 459)", () => {
    const { findings, merges } = mergeDuplicates([
      finding({ severity: "minor", premise: { verdict: "downgraded", judge: "review-premise", severity: "minor", original_severity: "major" } }),
      finding({ id: "F-002", reviewer: "review-regression", severity: "major", class_scope: { sites: ["src/retry.ts:10"], enumeration_method: "rg" } }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("minor");
    expect(findings[0]?.premise?.verdict).toBe("downgraded");
    expect(merges[0]?.severityRule).toBe("premise");
    expect(merges[0]?.outranked).toEqual({ severity: "major", reviewer: "review-regression", id: "F-002" });
    expect(renderDuplicatesMarkdown(merges)).toContain("severity downgraded by the premise judge");
    expect(renderDuplicatesMarkdown(merges)).toContain("the judge's minor outranks the major of review-regression (F-002)");
  });

  test("a premise judge's downgrade outranks a verifier's confirmation of a higher severity (review testing F-005)", () => {
    const { findings, merges } = mergeDuplicates([
      finding({ id: "F-002", reviewer: "review-regression", severity: "major", line: 12, problem: "attempt counter is never reset after success in the retry loop", class_scope: { sites: ["src/retry.ts:10"], enumeration_method: "rg" }, verification: { verdict: "confirmed", method: "execution", evidence: "test red", verifier: "review-verifier" } }),
      finding({ severity: "minor", premise: { verdict: "downgraded", judge: "review-premise", severity: "minor", original_severity: "major", practice_sources: [{ name: "n", says: "s" }] } }),
    ]);
    expect(findings).toHaveLength(1);
    expect(merges[0]?.severityRule).toBe("premise");
    expect(findings[0]?.severity).toBe("minor");
    expect(findings[0]?.premise?.verdict).toBe("downgraded");
  });

  for (const verdict of ["challenged", "owner-decision"] as const) {
    test(`a ${verdict} finding is never merged into a non-held duplicate, in either order, nor with another held one (flow 459)`, () => {
      const premise = { verdict, judge: "review-premise", question: "q", ...(verdict === "owner-decision" ? { options: ["a", "b"] } : {}) };
      const held = finding({ premise });
      const plain = finding({ id: "F-002", reviewer: "review-regression", line: 12, problem: "attempt counter is never reset after success in the retry loop" });
      for (const input of [[held, plain], [plain, held]]) {
        const { findings, merges } = mergeDuplicates(input);
        expect(merges).toEqual([]);
        expect(findings).toHaveLength(2);
        expect(findings.find((entry) => entry.premise !== undefined)?.premise?.verdict).toBe(verdict);
        expect(findings.find((entry) => entry.premise === undefined)?.id).toBe("F-002");
      }
      const both = mergeDuplicates([held, { ...plain, premise }]);
      expect(both.merges).toEqual([]);
      expect(both.findings).toHaveLength(2);
    });
  }

  test("a finding with an upheld premise merges like any other and keeps the canonical record's premise (flow 459)", () => {
    const { findings } = mergeDuplicates([
      finding({ premise: { verdict: "upheld", judge: "review-premise" } }),
      finding({ id: "F-002", reviewer: "review-regression", line: 12, problem: "attempt counter is never reset after success in the retry loop" }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.premise?.verdict).toBe("upheld");
  });

  test("a premise on the ABSORBED member survives a merge into a re-statement at the same severity (flow 459)", () => {
    const { findings, merges } = mergeDuplicates([
      finding({ severity: "major", premise: { verdict: "upheld", judge: "review-premise" } }),
      finding({ id: "F-002", reviewer: "review-regression", severity: "major", confidence: "high", line: 12, problem: "attempt counter is never reset after success in the retry loop", class_scope: { sites: ["src/retry.ts:10"], enumeration_method: "rg" } }),
    ]);
    expect(findings).toHaveLength(1);
    expect(merges[0]?.kept).toBe("F-002");
    expect(findings[0]?.premise).toEqual({ verdict: "upheld", judge: "review-premise" });
  });

  test("a judgement of a major does not move onto a blocker re-statement: the blocker stays unjudged (review RG2-002)", () => {
    const { findings, merges } = mergeDuplicates([
      finding({ severity: "major", premise: { verdict: "upheld", judge: "review-premise" } }),
      finding({ id: "F-002", reviewer: "review-regression", severity: "blocker", line: 12, problem: "attempt counter is never reset after success in the retry loop" }),
    ]);
    expect(findings).toHaveLength(1);
    expect(merges[0]?.kept).toBe("F-002");
    expect(findings[0]?.severity).toBe("blocker");
    expect(findings[0]?.premise).toBeUndefined();
  });

  test("the absorbed finding's problem statement is kept in merged_problems", () => {
    const { findings } = mergeDuplicates([
      finding({ global_id: "r#F-001" }),
      finding({ id: "F-002", global_id: "r#F-002", reviewer: "review-regression", line: 12, problem: "attempt counter is never reset after success in the retry loop" }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.problem).toBe("the retry loop never resets the attempt counter after a success");
    expect(findings[0]?.merged_problems).toEqual(["attempt counter is never reset after success in the retry loop"]);
  });

  test("statements that name different identifiers are never merged, however alike the rest of the words", () => {
    const a = finding({ problem: "the retry loop in `loadUser` never resets the attempt counter after a success" });
    const b = finding({ id: "F-002", reviewer: "review-regression", line: 11, problem: "the retry loop in `loadOrder` never resets the attempt counter after a success" });
    expect(isDuplicate(a, b)).toBe(false);
    expect(isDuplicate(a, { ...b, dedupe_key: "k" })).toBe(false);
    // One naming a subset of the other's identifiers (or none) still merges on the rest of the rule.
    expect(isDuplicate(a, { ...b, problem: "the retry loop in `loadUser()` never resets the attempt counter after success" })).toBe(true);
    expect(isDuplicate(a, { ...b, problem: "the retry loop never resets the attempt counter after a success" })).toBe(true);
    expect([...codeTokens("`user.id` vs session_token and parseInput() in fooBar")].sort()).toEqual(["fooBar", "parseInput", "session_token", "user.id"]);
  });

  test("never merges external, dispositioned or refuted findings", () => {
    const input = [
      finding(),
      finding({ id: "F-002", reviewer: "review-regression", verification: { verdict: "refuted", method: "execution", evidence: "passes", verifier: "v" } }),
      finding({ id: "F-003", reviewer: "review-style", disposition: { state: "acted-on", evidence: "abc123" } }),
      finding({
        id: "F-004",
        reviewer: "octocat",
        source: "external",
        external_ref: { id: "review-comment:1", author: "octocat", url: "u", submitted_at: "t" },
      }),
    ];
    const { findings, merges } = mergeDuplicates(input);
    expect(findings).toHaveLength(4);
    expect(merges).toEqual([]);
  });

  test("complete linkage: a chain does not merge its ends", () => {
    const { findings } = mergeDuplicates([
      finding({ line: 10 }),
      finding({ id: "F-002", reviewer: "review-regression", line: 13 }),
      finding({ id: "F-003", reviewer: "review-style", line: 16 }),
    ]);
    // F-001 and F-002 merge; F-003 is near F-002 but not F-001, so it stays.
    expect(findings).toHaveLength(2);
  });
});

describe("ingest", () => {
  const ORIGINAL_CWD = process.cwd();
  let ROOT = "";

  beforeEach(async () => {
    ROOT = await mkdtemp(path.join(tmpdir(), "gd-dedupe-"));
    await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
    const schemaDir = path.join(ROOT, "docs", "requirements", "managed-review-feedback-loop", "schemas");
    await mkdir(schemaDir, { recursive: true });
    await writeFile(
      path.join(schemaDir, "managed-review-package.schema.json"),
      await readFile(
        path.join(ORIGINAL_CWD, "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json"),
        "utf8",
      ),
    );
    await mkdir(path.join(ROOT, "src"), { recursive: true });
    await writeFile(path.join(ROOT, "src", "retry.ts"), Array.from({ length: 20 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n"));
  });

  afterEach(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });

  test("duplicates merge into one schema-valid record and later waves see the anchors", async () => {
    const result = await createManagedReviewPackage({
      cwd: ROOT,
      mode: "ingest",
      reviewId: "2026-10-16-dedupe",
      target: { kind: "report", ref: "review.md" },
      reportText: "# Round\n",
      findings: [
        finding({ quote: "const line10 = 10;" }),
        finding({ id: "F-002", reviewer: "review-architecture", severity: "major", quote: "const line11 = 11;", class_scope: { sites: ["src/retry.ts:11"], enumeration_method: "rg" } }),
      ],
      now: new Date("2026-10-16T12:00:00Z"),
    });
    const recorded = JSON.parse(await readFile(path.join(ROOT, result.path, "findings.json"), "utf8")) as StructuredReviewFinding[];
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.severity).toBe("major");
    expect(recorded[0]?.reported_by).toEqual(["review-architecture", "review-logic"]);
    expect(recorded[0]?.merged_from).toEqual(["2026-10-16-dedupe#F-001"]);
    expect(result.duplicates).toHaveLength(1);

    // Ingest gates every record on review-finding.schema.json before the write,
    // so a record on disk carrying reported_by/merged_from is a schema-valid one.

    const scope = await readFile(path.join(ROOT, result.path, "scope.md"), "utf8");
    expect(scope).toContain("## Duplicates merged");

    const known = await knownFindingsForWave(path.join(ROOT, result.path));
    expect(known).toEqual([
      {
        id: "F-002",
        global_id: "2026-10-16-dedupe#F-002",
        reviewer: "review-architecture",
        severity: "major",
        problem: recorded[0]?.problem ?? "",
        file: "src/retry.ts",
        line: 11,
        quote: "const line11 = 11;",
      },
    ]);
    expect(await knownFindingsForWave(path.join(ROOT, "nope"))).toEqual([]);
  });
});
