// flow 332 (AC1/AC2/AC8): pure-function tests for `jev-risk.ts` — fact
// gathering (path class, exported symbols, nearby test), budget selection,
// ranking, finding synthesis and the routing hint. Hermetic: no I/O, no
// network, no client import (this module is core).

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_JEV_RISK_THRESHOLD,
  DEFAULT_MAX_JEV_RISK_CALLS,
  batchRiskQuestionsForHunk,
  classifyHunkRiskPath,
  computeHunkRiskFacts,
  computeRiskRoutingHints,
  isNonCodeHunk,
  isTestFilePath,
  rankHunksByRisk,
  RISK_DIMENSIONS,
  scoreHunk,
  selectRiskHunks,
  synthesizeRiskFindings,
  testFilesTouchedNearby,
  testHunkEvidence,
  touchedExportedSymbols,
  type ScoredRiskHunk,
} from "./jev-risk";
import type { ScopedRegion } from "./scope";

function region(overrides: Partial<ScopedRegion> = {}): ScopedRegion {
  return {
    path: "src/widget.ts",
    startLine: 10,
    endLine: 20,
    changedLines: 3,
    contextTruncated: false,
    text: "+export function widget() {}\n+  return 1;\n",
    ...overrides,
  };
}

describe("classifyHunkRiskPath", () => {
  test("matches path-based classes (auth, crypto, migrations, schema, config)", () => {
    expect(classifyHunkRiskPath(region({ path: "src/auth/login.ts" }), 0).classes).toContain("auth/permissions");
    expect(classifyHunkRiskPath(region({ path: "src/crypto/sign.ts" }), 0).classes).toContain("crypto");
    expect(classifyHunkRiskPath(region({ path: "src/db/migrations/001.ts" }), 0).classes).toContain("migrations");
    expect(classifyHunkRiskPath(region({ path: "src/db/schema.ts" }), 0).classes).toContain("schema");
    expect(classifyHunkRiskPath(region({ path: "src/lib/config.ts" }), 0).classes).toContain("config");
  });

  test("public API fires on an entry-point path OR an exported symbol count, independently", () => {
    expect(classifyHunkRiskPath(region({ path: "src/foo/index.ts" }), 0).classes).toContain("public API");
    expect(classifyHunkRiskPath(region({ path: "src/foo/internal.ts" }), 1).classes).toContain("public API");
    expect(classifyHunkRiskPath(region({ path: "src/foo/internal.ts" }), 0).classes).not.toContain("public API");
  });

  test("content-based classes match the hunk's own text, not its path", () => {
    const withLock = region({ path: "src/plain.ts", text: "+await mutex.lock();\n" });
    expect(classifyHunkRiskPath(withLock, 0).classes).toContain("concurrency primitives");
    const withIo = region({ path: "src/plain.ts", text: "+await readFile(x);\n" });
    expect(classifyHunkRiskPath(withIo, 0).classes).toContain("IO");
  });

  test("an unremarkable hunk matches nothing", () => {
    const plain = region({ path: "src/util/format.ts", text: "+const x = 1;\n" });
    expect(classifyHunkRiskPath(plain, 0).classes).toEqual([]);
  });
});

describe("touchedExportedSymbols", () => {
  test("collects exported declarations from added/removed lines only", () => {
    const text = ["+export function alpha() {}", "-export const beta = 1;", " const gamma = 2; // context, not counted", "+function notExported() {}"].join("\n");
    expect(touchedExportedSymbols(text)).toEqual(["alpha", "beta"]);
  });

  test("no exported symbol: empty array", () => {
    expect(touchedExportedSymbols("+const x = 1;\n")).toEqual([]);
  });
});

describe("testFilesTouchedNearby", () => {
  test("a changed test file with the same stem counts as nearby", () => {
    const nearby = testFilesTouchedNearby("src/widget.ts", ["src/widget.ts", "src/widget.test.ts", "src/other.ts"]);
    expect(nearby).toEqual(["src/widget.test.ts"]);
  });

  test("a changed test file in the same directory (different stem) also counts", () => {
    const nearby = testFilesTouchedNearby("src/widget.ts", ["src/widget.ts", "src/suite.test.ts"]);
    expect(nearby).toEqual(["src/suite.test.ts"]);
  });

  test("no test file changed: empty array", () => {
    expect(testFilesTouchedNearby("src/widget.ts", ["src/widget.ts", "src/other.ts"])).toEqual([]);
  });
});

describe("computeHunkRiskFacts", () => {
  test("assembles path class, exported symbols, nearby-test facts into factLines", () => {
    const r = region({ path: "src/auth/session.ts", text: "+export function login() {}\n" });
    const facts = computeHunkRiskFacts(r, ["src/auth/session.ts"]);
    expect(facts.pathClasses).toContain("auth/permissions");
    expect(facts.pathClasses).toContain("public API");
    expect(facts.exportedSymbols).toEqual(["login"]);
    expect(facts.hasNearbyTest).toBe(false);
    expect(facts.factLines.some((line) => line.includes("auth/permissions"))).toBe(true);
  });

  test("hasNearbyTest true when a sibling test file is changed AND its own diff text mentions the touched symbol", () => {
    const r = region({ path: "src/auth/session.ts", text: "+export function login() {}\n" });
    const testText = new Map([["src/auth/session.test.ts", '+import { login } from "./session";\n+test("login", () => login());\n']]);
    const facts = computeHunkRiskFacts(r, ["src/auth/session.ts", "src/auth/session.test.ts"], testText);
    expect(facts.hasNearbyTest).toBe(true);
    expect(facts.evidencedTestFiles).toEqual(["src/auth/session.test.ts"]);
  });

  test("hasNearbyTest true when the nearby test's diff text imports the hunk's module by stem, even with no symbol mention", () => {
    const r = region({ path: "src/auth/session.ts", text: "+export function login() {}\n" });
    const testText = new Map([["src/auth/session.test.ts", '+import { helper } from "../auth/session";\n']]);
    const facts = computeHunkRiskFacts(r, ["src/auth/session.ts", "src/auth/session.test.ts"], testText);
    expect(facts.hasNearbyTest).toBe(true);
  });

  test("regression (flow 332 live-check false negative, providers.ts:723-733): a proximate test changed for an unrelated reason, with no evidence for THIS symbol, does not count as nearby", () => {
    const r = region({ path: "src/commands/providers.ts", text: "+export function boundedJsonBody() {}\n" });
    // providers.test.ts changed in the same diff, but its own diff text never mentions
    // `boundedJsonBody` and never imports `providers` — proximity alone used to suppress
    // the finding; it must not any more.
    const testText = new Map([["src/commands/providers.test.ts", '+test("something unrelated", () => {\n+  expect(1).toBe(1);\n+});\n']]);
    const facts = computeHunkRiskFacts(r, ["src/commands/providers.ts", "src/commands/providers.test.ts"], testText);
    expect(facts.hasNearbyTest).toBe(false);
    expect(facts.nearbyTestFiles).toEqual(["src/commands/providers.test.ts"]);
    expect(facts.evidencedTestFiles).toEqual([]);
  });

  test("no evidence map supplied at all: hasNearbyTest is false even with a proximate test (fails toward NOT suppressing)", () => {
    const r = region({ path: "src/auth/session.ts" });
    const facts = computeHunkRiskFacts(r, ["src/auth/session.ts", "src/auth/session.test.ts"]);
    expect(facts.hasNearbyTest).toBe(false);
  });
});

describe("testHunkEvidence", () => {
  test("matches a whole-identifier symbol mention", () => {
    expect(testHunkEvidence("+call(boundedJsonBody());\n", ["boundedJsonBody"], "providers")).toBe(true);
  });

  test("does not match a symbol as a substring of a longer identifier", () => {
    expect(testHunkEvidence("+call(boundedJsonBodyExtra());\n", ["boundedJsonBody"], "providers")).toBe(false);
  });

  test("matches an import of the module by stem even with no symbol mention", () => {
    expect(testHunkEvidence('+import { x } from "../commands/providers";\n', [], "providers")).toBe(true);
  });

  test("no symbol mention and no matching import: false", () => {
    expect(testHunkEvidence('+import { x } from "../other/thing";\n', ["boundedJsonBody"], "providers")).toBe(false);
  });
});

describe("isNonCodeHunk", () => {
  test("flags .md and .txt paths", () => {
    expect(isNonCodeHunk("docs/docs/cli-reference.md")).toBe(true);
    expect(isNonCodeHunk("NOTES.txt")).toBe(true);
  });

  test("does not flag code paths, including ones that mention docs in the name", () => {
    expect(isNonCodeHunk("src/docs/render.ts")).toBe(false);
    expect(isNonCodeHunk("README.mdx")).toBe(false);
  });

  test("flags .metaproject flow-bookkeeping and generated review metadata, unconditionally (live PR #743 fix)", () => {
    expect(isNonCodeHunk(".metaproject/flows/335-widget/flow.json")).toBe(true);
    expect(isNonCodeHunk(".metaproject/data/gdctx/artifacts/foo.json")).toBe(true);
    expect(isNonCodeHunk(".metaproject/reviews/743/report.json")).toBe(true);
    // No fixtures-directory exception for this class — unlike .md/.txt.
    expect(isNonCodeHunk(".metaproject/flows/335-widget/__fixtures__/flow.json")).toBe(true);
  });

  test("does not flag other .metaproject content (skills, rules, wiki) — only flows/data/reviews bookkeeping", () => {
    expect(isNonCodeHunk(".metaproject/skills/gdskills/review/foo/SKILL.md")).toBe(true); // still .md, caught by the existing rule
    expect(isNonCodeHunk(".metaproject/rules/foo.mdc")).toBe(false);
  });
});

describe("isTestFilePath", () => {
  test("a .test./.spec. infix, or a tests/__tests__ directory, is a test file", () => {
    expect(isTestFilePath("src/review/task-cost.test.ts")).toBe(true);
    expect(isTestFilePath("src/review/task-cost.spec.ts")).toBe(true);
    expect(isTestFilePath("src/__tests__/widget.ts")).toBe(true);
    expect(isTestFilePath("tests/e2e/widget.ts")).toBe(true);
  });

  test("an ordinary source path is not a test file", () => {
    expect(isTestFilePath("src/review/task-cost.ts")).toBe(false);
  });
});

describe("batchRiskQuestionsForHunk", () => {
  test("all five dimensions fit in one batch for an ordinary hunk", () => {
    const facts = computeHunkRiskFacts(region(), ["src/widget.ts"]);
    const batches = batchRiskQuestionsForHunk(facts);
    expect(batches).toHaveLength(1);
    expect(Object.keys(batches[0]!.questions).sort()).toEqual([...RISK_DIMENSIONS].sort());
  });
});

describe("selectRiskHunks", () => {
  test("caps hunks so hunks*5 <= maxCalls, reporting skipped rather than silently dropping", () => {
    const regions = Array.from({ length: 10 }, (_, i) => region({ path: `src/f${i}.ts` }));
    const selection = selectRiskHunks(regions, 12); // floor(12/5) = 2
    expect(selection.selected).toHaveLength(2);
    expect(selection.skipped).toHaveLength(8);
    expect(selection.pairsSelected).toBe(10);
    expect(selection.pairsSkipped).toBe(40);
  });

  test("default budget", () => {
    expect(selectRiskHunks([]).maxCalls).toBe(DEFAULT_MAX_JEV_RISK_CALLS);
  });

  test("docs (.md/.txt) hunks are excluded before the budget, reported separately as notCode, never scored", () => {
    const regions = [
      region({ path: "src/widget.ts" }),
      region({ path: "docs/docs/cli-reference.md" }),
      region({ path: "NOTES.txt" }),
      region({ path: "src/other.ts" }),
    ];
    const selection = selectRiskHunks(regions, 150);
    expect(selection.notCode.map((r) => r.path)).toEqual(["docs/docs/cli-reference.md", "NOTES.txt"]);
    expect(selection.selected.map((r) => r.path)).toEqual(["src/widget.ts", "src/other.ts"]);
    expect(selection.skipped).toEqual([]);
  });

  test("docs hunks never consume --max-calls budget", () => {
    const regions = [region({ path: "docs/README.md" }), region({ path: "src/a.ts" })];
    const selection = selectRiskHunks(regions, 5); // floor(5/5) = 1 code hunk
    expect(selection.selected.map((r) => r.path)).toEqual(["src/a.ts"]);
    expect(selection.skipped).toEqual([]);
    expect(selection.notCode.map((r) => r.path)).toEqual(["docs/README.md"]);
  });

  test(".metaproject flow-bookkeeping/generated-metadata hunks are excluded before the budget, reported as notCode (live PR #743 fix)", () => {
    const regions = [
      region({ path: "src/widget.ts" }),
      region({ path: ".metaproject/flows/335-widget/flow.json" }),
      region({ path: ".metaproject/data/gdctx/artifacts/foo.json" }),
      region({ path: ".metaproject/reviews/743/report.json" }),
    ];
    const selection = selectRiskHunks(regions, 150);
    expect(selection.notCode.map((r) => r.path)).toEqual([
      ".metaproject/flows/335-widget/flow.json",
      ".metaproject/data/gdctx/artifacts/foo.json",
      ".metaproject/reviews/743/report.json",
    ]);
    expect(selection.selected.map((r) => r.path)).toEqual(["src/widget.ts"]);
    expect(selection.skipped).toEqual([]);
  });
});

function scoredHunk(overrides: Partial<Record<(typeof RISK_DIMENSIONS)[number], number>> = {}, pathOverride?: Partial<ScopedRegion>): ScoredRiskHunk {
  const facts = computeHunkRiskFacts(region(pathOverride), []);
  const answers = Object.fromEntries(RISK_DIMENSIONS.map((d) => [d, { noul: overrides[d] ?? 0.1 }]));
  return scoreHunk(facts, answers);
}

describe("scoreHunk / rankHunksByRisk", () => {
  test("combinedRisk is the MAX across dimensions, topDimension names it", () => {
    const hunk = scoredHunk({ security: 0.9, concurrency: 0.2 });
    expect(hunk.combinedRisk).toBe(0.9);
    expect(hunk.topDimension).toBe("security");
  });

  test("ranks descending by combinedRisk, ties broken by input order", () => {
    const a = scoredHunk({ security: 0.5 }, { path: "src/a.ts" });
    const b = scoredHunk({ security: 0.9 }, { path: "src/b.ts" });
    const c = scoredHunk({ security: 0.5 }, { path: "src/c.ts" });
    const ranked = rankHunksByRisk([a, b, c]);
    expect(ranked.map((h) => h.facts.region.path)).toEqual(["src/b.ts", "src/a.ts", "src/c.ts"]);
  });
});

describe("synthesizeRiskFindings", () => {
  test("no finding below threshold", () => {
    const hunk = scoredHunk({ security: 0.5 });
    expect(synthesizeRiskFindings([hunk], 0.7)).toEqual([]);
  });

  test("no finding when a nearby test exists AND its diff text evidences the touched symbol, even above threshold", () => {
    const testText = new Map([["src/widget.test.ts", '+import { widget } from "./widget";\n+test("widget", () => widget());\n']]);
    const facts = computeHunkRiskFacts(region(), ["src/widget.ts", "src/widget.test.ts"], testText);
    const answers = Object.fromEntries(RISK_DIMENSIONS.map((d) => [d, { noul: 0.9 }]));
    const hunk = scoreHunk(facts, answers);
    expect(synthesizeRiskFindings([hunk], 0.7)).toEqual([]);
  });

  test("a proximate-but-unrelated nearby test does NOT suppress the finding (flow 332 tightened hasNearbyTest)", () => {
    const testText = new Map([["src/widget.test.ts", '+test("unrelated", () => {\n+  expect(1).toBe(1);\n+});\n']]);
    const facts = computeHunkRiskFacts(region(), ["src/widget.ts", "src/widget.test.ts"], testText);
    const answers = Object.fromEntries(RISK_DIMENSIONS.map((d) => [d, { noul: 0.9 }]));
    const hunk = scoreHunk(facts, answers);
    expect(synthesizeRiskFindings([hunk], 0.7)).toHaveLength(1);
  });

  test("above threshold with no nearby test: exactly one finding, severity capped at minor", () => {
    const hunk = scoredHunk({ security: 0.95 });
    const findings = synthesizeRiskFindings([hunk], DEFAULT_JEV_RISK_THRESHOLD);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity === "info" || findings[0]!.severity === "minor").toBe(true);
    expect(findings[0]!.reviewer).toBe("review-jev-risk");
    expect(findings[0]!.file).toBe("src/widget.ts");
  });

  test("a test file's own hunk never produces a finding on its own, even above threshold (live PR #743 fix, task-cost.test.ts)", () => {
    const hunk = scoredHunk({ security: 0.95 }, { path: "src/review/task-cost.test.ts" });
    expect(synthesizeRiskFindings([hunk], DEFAULT_JEV_RISK_THRESHOLD)).toEqual([]);
  });

  test("a production file's own hunk in the same run still produces its finding, independent of any test hunk", () => {
    const testHunk = scoredHunk({ security: 0.95 }, { path: "src/review/task-cost.test.ts" });
    const prodHunk = scoredHunk({ security: 0.95 }, { path: "src/review/task-cost.ts" });
    const findings = synthesizeRiskFindings([testHunk, prodHunk], DEFAULT_JEV_RISK_THRESHOLD);
    expect(findings.map((f) => f.file)).toEqual(["src/review/task-cost.ts"]);
  });
});

describe("computeRiskRoutingHints", () => {
  test("security/concurrency above threshold produce hints with the right suggested reviewer", () => {
    const hunk = scoredHunk({ security: 0.9, concurrency: 0.8, "data-migration": 0.1 });
    const hints = computeRiskRoutingHints([hunk], 0.7);
    expect(hints).toHaveLength(2);
    expect(hints.find((h) => h.dimension === "security")?.suggestedReviewer).toBe("review-security-code");
    expect(hints.find((h) => h.dimension === "concurrency")?.suggestedReviewer).toBe("review-highload");
  });

  test("no hint below threshold, and other dimensions never produce a hint", () => {
    const hunk = scoredHunk({ security: 0.5, "public-api": 0.95 });
    expect(computeRiskRoutingHints([hunk], 0.7)).toEqual([]);
  });

  test("a test file's own hunk never produces a routing hint on its own, even above threshold (live PR #743 fix, task-cost.test.ts)", () => {
    const hunk = scoredHunk({ security: 0.9, concurrency: 0.8 }, { path: "src/review/task-cost.test.ts" });
    expect(computeRiskRoutingHints([hunk], 0.7)).toEqual([]);
  });

  test("a production file's own hunk in the same run still produces its hint, independent of any test hunk", () => {
    const testHunk = scoredHunk({ security: 0.9 }, { path: "src/review/task-cost.test.ts" });
    const prodHunk = scoredHunk({ security: 0.9 }, { path: "src/review/task-cost.ts" });
    const hints = computeRiskRoutingHints([testHunk, prodHunk], 0.7);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.file).toBe("src/review/task-cost.ts");
  });
});

test("review round 2 of PR #726: a comment-only mention is not test evidence; a fixture .txt stays scored", () => {
  expect(testHunkEvidence("+  // still need to cover boundedJsonBody\n", ["boundedJsonBody"], "providers")).toBe(false);
  expect(testHunkEvidence("+  /* boundedJsonBody */\n", ["boundedJsonBody"], "providers")).toBe(false);
  expect(testHunkEvidence("+  expect(boundedJsonBody(res)).toBe(1);\n", ["boundedJsonBody"], "providers")).toBe(true);
  expect(isNonCodeHunk("src/foo/__fixtures__/expected.txt")).toBe(false);
  expect(isNonCodeHunk("docs/notes.txt")).toBe(true);
});
