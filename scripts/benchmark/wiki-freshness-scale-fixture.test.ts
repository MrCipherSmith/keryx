// RED/GREEN coverage for the AC3/AC-22 fixture + oracle (flow 236, phase 4, T10).
// Deliberately does NOT import anything from src/wiki/freshness/** — this file
// checks the FIXTURE's own bookkeeping against real `git log`/`git cat-file`
// output and an independent hash reimplementation, never against the code under
// test. See wiki-freshness-scale-fixture.ts's header note for why that split
// matters.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  expectedVerifiedScope,
  generateFreshnessScaleCorpus,
  mulberry32,
  type FreshnessFixtureManifest,
} from "./wiki-freshness-scale-fixture";

const MANIFEST: FreshnessFixtureManifest = {
  seed: 236100,
  scales: [50, 500, 2000],
  categoryShares: { gitLogReachable: 0.74, gitLogUnreachable: 0.14, scopeHashOnly: 0.06, undecidable: 0.06 },
  changedShareWithinGitLike: 0.7,
  changedShareWithinScopeHashOnly: 0.5,
};

function runGit(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString("utf8")}`);
  return r.stdout.toString("utf8").trim();
}

describe("mulberry32", () => {
  test("is a deterministic, seed-dependent sequence in [0,1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    const seqC = Array.from({ length: 5 }, () => c());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("expectedVerifiedScope", () => {
  test("matches a hand-computed sha256-of-sorted-pairs for a known input", () => {
    const files = [
      { path: "b.ts", content: "beta" },
      { path: "a.ts", content: "alpha" },
    ];
    const sortedCombined = "a.ts:" + createHash("sha256").update("alpha").digest("hex") + "\n" + "b.ts:" + createHash("sha256").update("beta").digest("hex");
    const expected = `sha256:${createHash("sha256").update(sortedCombined).digest("hex")}`;
    expect(expectedVerifiedScope(files)).toBe(expected);
  });

  test("a missing/null file hashes using the literal <missing> sentinel as its digest (not the string's own hash)", () => {
    const withMissing = expectedVerifiedScope([{ path: "gone.ts", content: null }]);
    const combined = "gone.ts:<missing>";
    const expected = `sha256:${createHash("sha256").update(combined).digest("hex")}`;
    expect(withMissing).toBe(expected);
  });

  test("path order does not affect the result (sorted internally)", () => {
    const a = expectedVerifiedScope([{ path: "z.ts", content: "1" }, { path: "a.ts", content: "2" }]);
    const b = expectedVerifiedScope([{ path: "a.ts", content: "2" }, { path: "z.ts", content: "1" }]);
    expect(a).toBe(b);
  });
});

describe("generateFreshnessScaleCorpus", () => {
  test("same (size, seed, manifest) produces byte-identical page bookkeeping AND identical commit shas", () => {
    const corpusA = generateFreshnessScaleCorpus(30, 236100, MANIFEST);
    const corpusB = generateFreshnessScaleCorpus(30, 236100, MANIFEST);
    try {
      expect(corpusA.pages).toEqual(corpusB.pages);
      // Commit dates are pinned (see commitEnv in wiki-freshness-scale-fixture.ts)
      // specifically so two separate runs of the SAME seed produce the SAME
      // commit shas, not just the same logical bookkeeping — real wall-clock
      // commit dates would silently break "the same seed must give the same
      // corpus" (fixtures/wiki-freshness-scale/README.md) despite identical file
      // content, since a commit sha is a function of its author/committer date.
      expect(corpusA.rootCommit).toBe(corpusB.rootCommit);
      expect(corpusA.headCommit).toBe(corpusB.headCommit);
    } finally {
      corpusA.cleanup();
      corpusB.cleanup();
    }
  });

  test("a different seed changes the classification", () => {
    const corpusA = generateFreshnessScaleCorpus(30, 236100, MANIFEST);
    const corpusB = generateFreshnessScaleCorpus(30, 999, MANIFEST);
    try {
      expect(corpusA.pages).not.toEqual(corpusB.pages);
    } finally {
      corpusA.cleanup();
      corpusB.cleanup();
    }
  });

  test("category proportions roughly match the manifest shares at a moderate size", () => {
    const corpus = generateFreshnessScaleCorpus(400, 236100, MANIFEST);
    try {
      const counts: Record<string, number> = {};
      for (const p of corpus.pages) counts[p.category] = (counts[p.category] ?? 0) + 1;
      expect((counts["git-log"] ?? 0) / 400).toBeGreaterThan(0.6);
      expect((counts["git-log"] ?? 0) / 400).toBeLessThan(0.85);
      expect((counts["undecidable"] ?? 0) / 400).toBeGreaterThan(0.02);
      expect((counts["undecidable"] ?? 0) / 400).toBeLessThan(0.12);
    } finally {
      corpus.cleanup();
    }
  });

  test("REAL git independently confirms every git-log page's changed/unchanged bookkeeping", () => {
    const corpus = generateFreshnessScaleCorpus(25, 236100, MANIFEST);
    try {
      const gitLogPages = corpus.pages.filter((p) => p.category === "git-log");
      expect(gitLogPages.length).toBeGreaterThan(0);
      for (const p of gitLogPages) {
        const log = runGit(corpus.root, ["log", "--format=%H", `${p.verifiedAt}..HEAD`, "--", p.describePath]);
        const touchedSinceVerifiedAt = log.length > 0;
        expect(touchedSinceVerifiedAt).toBe(p.changed);
        expect(p.oracle.kind).toBe(p.changed ? "changed" : "unchanged");
      }
    } finally {
      corpus.cleanup();
    }
  });

  test("git-log-unreachable pages carry a VerifiedAt that real git cannot resolve", () => {
    const corpus = generateFreshnessScaleCorpus(25, 236100, MANIFEST);
    try {
      const unreachable = corpus.pages.filter((p) => p.category === "git-log-unreachable");
      expect(unreachable.length).toBeGreaterThan(0);
      for (const p of unreachable) {
        const r = Bun.spawnSync(["git", "cat-file", "-e", `${p.verifiedAt}^{commit}`], { cwd: corpus.root, stdout: "pipe", stderr: "pipe" });
        expect(r.exitCode).not.toBe(0);
      }
    } finally {
      corpus.cleanup();
    }
  });

  test("scope-hash pages: 'unchanged' frozen VerifiedScope matches the CURRENT file's independently-hashed content", () => {
    const corpus = generateFreshnessScaleCorpus(60, 236100, MANIFEST);
    try {
      const unchanged = corpus.pages.filter((p) => p.category === "scope-hash" && !p.changed);
      expect(unchanged.length).toBeGreaterThan(0);
      for (const p of unchanged) {
        const current = readFileSync(path.join(corpus.root, p.describePath), "utf8");
        expect(p.verifiedScope).toBe(expectedVerifiedScope([{ path: p.describePath, content: current }]));
      }
    } finally {
      corpus.cleanup();
    }
  });

  test("scope-hash pages: 'changed' frozen VerifiedScope does NOT match the current (mutated) file", () => {
    const corpus = generateFreshnessScaleCorpus(60, 236100, MANIFEST);
    try {
      const changed = corpus.pages.filter((p) => p.category === "scope-hash" && p.changed);
      expect(changed.length).toBeGreaterThan(0);
      for (const p of changed) {
        const current = readFileSync(path.join(corpus.root, p.describePath), "utf8");
        expect(p.verifiedScope).not.toBe(expectedVerifiedScope([{ path: p.describePath, content: current }]));
      }
    } finally {
      corpus.cleanup();
    }
  });

  test("undecidable pages carry neither VerifiedAt nor VerifiedScope", () => {
    const corpus = generateFreshnessScaleCorpus(60, 236100, MANIFEST);
    try {
      const undecidable = corpus.pages.filter((p) => p.category === "undecidable");
      expect(undecidable.length).toBeGreaterThan(0);
      for (const p of undecidable) {
        expect(p.verifiedAt).toBeNull();
        expect(p.verifiedScope).toBeNull();
        expect(p.oracle.kind).toBe("undecidable");
      }
    } finally {
      corpus.cleanup();
    }
  });

  test("oracleUnderGitFailure flips every VerifiedAt-bearing page to git-failure and leaves the rest unchanged", () => {
    const corpus = generateFreshnessScaleCorpus(60, 236100, MANIFEST);
    try {
      for (const p of corpus.pages) {
        if (p.verifiedAt !== null) {
          expect(p.oracleUnderGitFailure.kind).toBe("git-failure");
        } else {
          expect(p.oracleUnderGitFailure).toEqual(p.oracle);
        }
      }
    } finally {
      corpus.cleanup();
    }
  });

  test("the generated GraphData lists every source file as a known file node", () => {
    const corpus = generateFreshnessScaleCorpus(10, 236100, MANIFEST);
    try {
      const known = new Set(corpus.graph.nodes.map((n) => n.path));
      for (const p of corpus.pages) expect(known.has(p.describePath)).toBe(true);
    } finally {
      corpus.cleanup();
    }
  });
});
