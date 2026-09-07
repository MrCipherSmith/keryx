// RED/GREEN coverage for the AC3/AC-22 freshness-cost benchmark's measurement
// logic (flow 236, phase 4, T10). Runs REAL `evaluatePageFreshness`
// (src/wiki/freshness/page-freshness.ts, unmodified) against small, fast
// generated corpora with a real temp git repo — this is the same code path
// `bun scripts/benchmark/run-wiki-freshness-scale.ts` exercises at 50/500/2000
// pages, just at a size this suite can afford to run on every `bun test`.
//
// Kept small deliberately: the full 50/500/2000 measurement (with its budget
// comparison and the results.json artifact) is this script's own `main()`, run
// manually per the task's verification step, not re-run here on every test pass.

import { describe, expect, test } from "bun:test";
import {
  runPass,
  runScale,
  summarizeOutcome,
  verdictKind,
  type CalibrationProfile,
} from "./run-wiki-freshness-scale";
import { generateFreshnessScaleCorpus, type FreshnessFixtureManifest } from "./wiki-freshness-scale-fixture";
import type { PageFreshness } from "../../src/wiki/freshness/page-freshness";

const MANIFEST: FreshnessFixtureManifest = {
  seed: 236100,
  scales: [50, 500, 2000],
  categoryShares: { gitLogReachable: 0.74, gitLogUnreachable: 0.14, scopeHashOnly: 0.06, undecidable: 0.06 },
  changedShareWithinGitLike: 0.7,
  changedShareWithinScopeHashOnly: 0.5,
};

const FAKE_CALIBRATION: CalibrationProfile = {
  profileVersion: "test-fixture",
  scales: [12],
  gitSubprocessBudget: { worstCaseCeiling: { perPage: 3, note: "test" } },
  latencyBudgetMs: {
    perScale: { "12": { cold: 60_000, repeated: 60_000 } }, // generous — this test asserts CORRECTNESS, not the real budget
    hardCeiling: { scale: 2000, ms: 120_000, anchoredOn: "test" },
  },
};

describe("verdictKind", () => {
  function pf(overrides: Partial<PageFreshness>): PageFreshness {
    return {
      page: "p",
      basis: "git-log",
      changed: false,
      commitsBehind: 0,
      changedFiles: [],
      confidenceCap: "must-refresh",
      ...overrides,
    };
  }
  test("undecidable with no gitFailure ⇒ undecidable", () => {
    expect(verdictKind(pf({ basis: "undecidable" }))).toBe("undecidable");
  });
  test("undecidable WITH gitFailure ⇒ git-failure", () => {
    expect(verdictKind(pf({ basis: "undecidable", gitFailure: "broken" }))).toBe("git-failure");
  });
  test("git-log / changed=true ⇒ changed", () => {
    expect(verdictKind(pf({ basis: "git-log", changed: true }))).toBe("changed");
  });
  test("scope-hash / changed=false ⇒ unchanged", () => {
    expect(verdictKind(pf({ basis: "scope-hash", changed: false }))).toBe("unchanged");
  });
});

describe("runPass against a REAL generated git repo", () => {
  test("healthy mode: every page in a small corpus agrees with the oracle", async () => {
    const corpus = generateFreshnessScaleCorpus(16, 236100, MANIFEST);
    try {
      const result = await runPass(corpus, "healthy");
      expect(result.mismatches).toEqual([]);
      expect(result.agreementCount).toBe(result.total);
      expect(result.total).toBe(16);
      expect(result.gitOperations).toBeGreaterThan(0);
    } finally {
      corpus.cleanup();
    }
  });

  test("healthy mode run twice ('cold' and 'repeated') both agree with the oracle", async () => {
    const corpus = generateFreshnessScaleCorpus(16, 236100, MANIFEST);
    try {
      const cold = await runPass(corpus, "healthy");
      const repeated = await runPass(corpus, "healthy");
      expect(cold.mismatches).toEqual([]);
      expect(repeated.mismatches).toEqual([]);
      // No per-run cache exists yet (flow 236 T10 inventory) — repeated re-spawns
      // git exactly like cold does. This assertion is a REGRESSION TRIPWIRE: if a
      // future change adds an in-run cache without updating this benchmark's
      // expectations, this line is the one that should start failing loudly
      // rather than the improvement going unnoticed.
      expect(repeated.gitOperations).toBe(cold.gitOperations);
    } finally {
      corpus.cleanup();
    }
  });

  test("broken-git mode: every VerifiedAt-bearing page becomes undecidable with a gitFailure reason", async () => {
    const corpus = generateFreshnessScaleCorpus(16, 236100, MANIFEST);
    try {
      const result = await runPass(corpus, "broken-git");
      expect(result.mismatches).toEqual([]);
      const verifiedAtPages = corpus.pages.filter((p) => p.verifiedAt !== null);
      expect(verifiedAtPages.length).toBeGreaterThan(0);
      // broken-git must be dramatically cheaper: no real git subprocess for any
      // page, only the logical "call attempted" count from the up-front probe
      // pattern this benchmark uses to mirror report.ts's own gitAvailable check.
      const healthy = await runPass(corpus, "healthy");
      expect(result.gitOperationsSumMs).toBe(0);
      expect(result.gitOperations).toBeLessThan(healthy.gitOperations);
    } finally {
      corpus.cleanup();
    }
  });
});

describe("runScale end-to-end", () => {
  test("a small scale run reports 100% agreement across cold/repeated/broken-git", async () => {
    const result = await runScale(12, MANIFEST.seed, MANIFEST, FAKE_CALIBRATION);
    expect(result.size).toBe(12);
    expect(result.cold.mismatches).toEqual([]);
    expect(result.repeated.mismatches).toEqual([]);
    expect(result.brokenGit.mismatches).toEqual([]);
    const outcome = summarizeOutcome([result]);
    expect(outcome.allAgree).toBe(true);
    expect(outcome.totalMismatches).toBe(0);
  });

  test("budget comparison fields are populated and internally consistent", async () => {
    const result = await runScale(12, MANIFEST.seed, MANIFEST, FAKE_CALIBRATION);
    expect(result.budget.coldTargetMs).toBe(60_000);
    expect(result.budget.coldWithinBudget).toBe(true); // generous fake budget
    expect(result.budget.measuredSpawnsPerPage).toBeCloseTo(result.cold.gitOperations / 12, 5);
  });
});

describe("summarizeOutcome", () => {
  test("flags disagreement when any pass reports a mismatch", () => {
    const base = {
      mode: "healthy" as const,
      wallClockMs: 1,
      gitOperations: 1,
      gitOperationsSumMs: 1,
      agreementCount: 0,
      total: 1,
      mismatches: [{ page: "x", category: "git-log", expected: "changed" as const, actual: "unchanged" as const }],
    };
    const outcome = summarizeOutcome([
      {
        size: 1,
        categoryCounts: {},
        cold: base,
        repeated: { ...base, mismatches: [] },
        brokenGit: { ...base, mismatches: [] },
        budget: {
          coldTargetMs: 1,
          repeatedTargetMs: 1,
          coldWithinBudget: true,
          repeatedWithinBudget: true,
          measuredSpawnsPerPage: 1,
          worstCaseCeilingPerPage: 1,
          withinWorstCaseCeiling: true,
        },
      },
    ]);
    expect(outcome.allAgree).toBe(false);
    expect(outcome.totalMismatches).toBe(1);
  });
});
