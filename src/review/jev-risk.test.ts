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
  rankHunksByRisk,
  RISK_DIMENSIONS,
  scoreHunk,
  selectRiskHunks,
  synthesizeRiskFindings,
  testFilesTouchedNearby,
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

  test("hasNearbyTest true when a sibling test file is also changed", () => {
    const r = region({ path: "src/auth/session.ts" });
    const facts = computeHunkRiskFacts(r, ["src/auth/session.ts", "src/auth/session.test.ts"]);
    expect(facts.hasNearbyTest).toBe(true);
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

  test("no finding when a nearby test exists, even above threshold", () => {
    const facts = computeHunkRiskFacts(region(), ["src/widget.ts", "src/widget.test.ts"]);
    const answers = Object.fromEntries(RISK_DIMENSIONS.map((d) => [d, { noul: 0.9 }]));
    const hunk = scoreHunk(facts, answers);
    expect(synthesizeRiskFindings([hunk], 0.7)).toEqual([]);
  });

  test("above threshold with no nearby test: exactly one finding, severity capped at minor", () => {
    const hunk = scoredHunk({ security: 0.95 });
    const findings = synthesizeRiskFindings([hunk], DEFAULT_JEV_RISK_THRESHOLD);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity === "info" || findings[0]!.severity === "minor").toBe(true);
    expect(findings[0]!.reviewer).toBe("review-jev-risk");
    expect(findings[0]!.file).toBe("src/widget.ts");
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
});
