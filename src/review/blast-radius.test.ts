import { describe, expect, test } from "bun:test";
import {
  BLAST_RADIUS_DROP_REASONS,
  BLAST_RADIUS_SCOPE_REVIEWER,
  isCapDrop,
  REASONED_DROP_REASONS,
  testsToRunLine,
  blastRadiusRecomputeDecision,
  computeBlastRadius,
  isBlastRadiusScopedFinding,
  DEFAULT_BLAST_RADIUS_DEPTH,
  DEFAULT_BLAST_RADIUS_MAX_FILES,
  renderBlastRadiusDispatchBrief,
  renderBlastRadiusMarkdown,
  renderBlastRadiusScreenMarkdown,
  screenBlastRadiusFindings,
  upsertBlastRadiusBlock,
  type BlastRadius,
} from "./blast-radius";
import type { GraphData } from "../gdgraph/types";
import type { StructuredReviewFinding } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * `from -> to` means `from` imports `to`, matching `GraphEdge`. The dependents
 * of `to` are therefore the `from`s, which is the relation `computeAffected`
 * walks and the one this module bounds.
 */
function graphOf(edges: ReadonlyArray<[string, string]>): GraphData {
  const paths = new Set<string>();
  for (const [from, to] of edges) {
    paths.add(from);
    paths.add(to);
  }
  return {
    nodes: [...paths].sort().map((path) => ({ id: path, kind: "file" as const, path, language: "typescript" as const })),
    edges: edges.map(([from, to], index) => ({
      id: `e${index}`,
      from,
      to,
      kind: "imports" as const,
      specifier: to,
    })),
  };
}

/**
 *     util <- a <- c <- d
 *          <- b
 *          <- dist/bundle.js
 *     a    <- a.test.ts
 */
const GRAPH = graphOf([
  ["src/a.ts", "src/core/util.ts"],
  ["src/b.ts", "src/core/util.ts"],
  ["dist/bundle.js", "src/core/util.ts"],
  ["src/c.ts", "src/a.ts"],
  ["src/a.test.ts", "src/a.ts"],
  ["src/d.ts", "src/c.ts"],
]);

const CHANGED = ["src/core/util.ts"];

function radius(overrides?: Parameters<typeof computeBlastRadius>[0]["config"], changed = CHANGED): BlastRadius {
  return computeBlastRadius({ graph: GRAPH, changedFiles: changed, config: overrides });
}

// ---------------------------------------------------------------------------
// AC2 — computed, ranked, bounded
// ---------------------------------------------------------------------------

describe("computeBlastRadius — AC2: computed from the graph, never chosen", () => {
  test("the set is the dependent closure to the configured depth", () => {
    const result = radius();
    expect(result.depth).toBe(DEFAULT_BLAST_RADIUS_DEPTH);
    expect(result.files.map((entry) => entry.file)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/a.test.ts"]);
  });

  test("depth bounds the walk: depth 1 keeps only direct dependents", () => {
    const result = radius({ depth: 1 });
    expect(result.files.map((entry) => entry.file)).toEqual(["src/a.ts", "src/b.ts"]);
    // Nothing at hop 2 is silently present under another name.
    expect(result.files.every((entry) => entry.hop === 1)).toBe(true);
  });

  test("depth 3 reaches further, so the bound is what excluded d.ts and not the graph", () => {
    const result = radius({ depth: 3 });
    expect(result.files.map((entry) => entry.file)).toContain("src/d.ts");
  });

  test("ranked closest first, then by fan-in, then by path", () => {
    const result = radius();
    const hops = result.files.map((entry) => entry.hop);
    expect([...hops]).toEqual([...hops].sort((a, b) => a - b));
    // `src/a.ts` has two inbound edges and `src/b.ts` none, so a sorts first at
    // the same hop. A ranking that only sorted by path would put b first.
    expect(result.files[0]?.file).toBe("src/a.ts");
    expect(result.files[0]?.fanIn).toBeGreaterThan(result.files[1]?.fanIn ?? 0);
  });

  test("each entry carries its dependency path back to the change", () => {
    const result = radius();
    const c = result.files.find((entry) => entry.file === "src/c.ts");
    expect(c?.path).toEqual(["src/c.ts", "src/a.ts", "src/core/util.ts"]);
    expect(c?.via).toBe("src/core/util.ts");
  });

  test("the changed files themselves are never in their own blast radius", () => {
    const result = computeBlastRadius({ graph: GRAPH, changedFiles: ["src/core/util.ts", "src/a.ts"] });
    expect(result.files.map((entry) => entry.file)).not.toContain("src/a.ts");
    expect(result.files.map((entry) => entry.file)).not.toContain("src/core/util.ts");
  });

  test("the record names the graph it was computed against", () => {
    const result = radius();
    expect(result.graph.nodes).toBe(GRAPH.nodes.length);
    expect(result.graph.edges).toBe(GRAPH.edges.length);
  });
});

// ---------------------------------------------------------------------------
// AC1 — every drop recorded
// ---------------------------------------------------------------------------

describe("computeBlastRadius — AC1: the cap says what it cut", () => {
  test("the cap truncates and records every file it removed", () => {
    const result = radius({ maxFiles: 2 });
    expect(result.files).toHaveLength(2);
    const capped = result.dropped.filter((drop) => drop.reason === "cap");
    expect(capped.map((drop) => drop.file)).toEqual(["src/c.ts", "src/a.test.ts"]);
    for (const drop of capped) {
      expect(drop.detail).toContain("blast_radius_max_files=2");
      expect(drop.detail).toContain("NOT reviewed");
      expect(drop.via).toBe("src/core/util.ts");
      expect(drop.hop).toBeGreaterThan(0);
    }
  });

  test("nothing vanishes: retained + dropped accounts for every candidate", () => {
    const result = radius({ maxFiles: 1 });
    const seen = [...result.files.map((entry) => entry.file), ...result.dropped.map((drop) => drop.file)];
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(result.counts.candidates);
    expect(result.counts.retained + result.counts.droppedByCap + result.counts.droppedByPreFilter).toBe(
      result.counts.candidates,
    );
  });

  test("a truncated round cannot render as a complete one", () => {
    const markdown = renderBlastRadiusMarkdown(radius({ maxFiles: 1 }));
    expect(markdown).toContain("### Dropped — NOT reviewed");
    expect(markdown).toContain("src/c.ts");
    expect(markdown).not.toContain("_nothing was dropped");
  });

  test("the pre-filter's exclusions apply to the radius, with their own reason", () => {
    const result = radius();
    const preFilter = result.dropped.filter((drop) => drop.reason === "pre-filter");
    expect(preFilter.map((drop) => drop.file)).toEqual(["dist/bundle.js"]);
    expect(preFilter[0]?.detail).toContain("generated");
    expect(result.files.map((entry) => entry.file)).not.toContain("dist/bundle.js");
  });

  test("a changed file the graph has no node for is recorded, not read as an empty radius", () => {
    const result = computeBlastRadius({
      graph: GRAPH,
      changedFiles: [".metaproject/skills/review/review-orchestrator/SKILL.md"],
    });
    expect(result.files).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.reason).toBe("not-a-graph-node");
    expect(result.counts.changedFilesResolved).toBe(0);
    const markdown = renderBlastRadiusMarkdown(result);
    expect(markdown).toContain("NOT `nothing depends on the change`");
  });

  test("a changed file the pre-filter excludes is never seeded, and says so", () => {
    const result = computeBlastRadius({ graph: GRAPH, changedFiles: ["bun.lock"] });
    expect(result.unresolved[0]?.reason).toBe("excluded-by-pre-filter");
    expect(result.unresolved[0]?.detail).toContain("lockfile");
  });

  test("the rendered record carries the set, the depth and the drops together", () => {
    const markdown = renderBlastRadiusMarkdown(radius({ maxFiles: 2 }));
    expect(markdown).toContain("## Blast radius");
    expect(markdown).toContain("depth: 2");
    expect(markdown).toContain("max_files: 2");
    expect(markdown).toContain("### Under regression check");
    expect(markdown).toContain("src/a.ts");
    expect(markdown).toContain("### Changed files the graph could not answer for");
  });

  test("the block replaces itself rather than accumulating contradictory copies", () => {
    const first = renderBlastRadiusMarkdown(radius({ maxFiles: 1 }));
    const second = renderBlastRadiusMarkdown(radius({ maxFiles: 4 }));
    const once = upsertBlastRadiusBlock("# Review Scope\n\nsome preamble\n", first);
    const twice = upsertBlastRadiusBlock(once, second);
    expect(twice.match(/## Blast radius/g)).toHaveLength(1);
    expect(twice).toContain("max_files: 4");
    expect(twice).toContain("some preamble");
  });
});

// ---------------------------------------------------------------------------
// Related tests
// ---------------------------------------------------------------------------

describe("computeBlastRadius — related tests are added narrowly and ranked last", () => {
  const testFiles = ["src/core/util.test.ts", "src/unrelated/other.test.ts"];

  test("a naming-related test the graph does not reach is added", () => {
    const result = computeBlastRadius({ graph: GRAPH, changedFiles: CHANGED, testFiles });
    const added = result.files.find((entry) => entry.file === "src/core/util.test.ts");
    expect(added?.source).toBe("related-test");
    expect(result.counts.relatedTestsAdded).toBe(1);
    // Not a test that merely lives elsewhere in the tree.
    expect(result.files.map((entry) => entry.file)).not.toContain("src/unrelated/other.test.ts");
  });

  test("it ranks below every graph entry, so the cap reaches it first", () => {
    const result = computeBlastRadius({ graph: GRAPH, changedFiles: CHANGED, testFiles });
    expect(result.files.at(-1)?.file).toBe("src/core/util.test.ts");
    const capped = computeBlastRadius({ graph: GRAPH, changedFiles: CHANGED, testFiles, config: { maxFiles: 4 } });
    expect(capped.dropped.filter((drop) => drop.reason === "cap").map((drop) => drop.file)).toEqual([
      "src/core/util.test.ts",
    ]);
  });

  test("turning it off removes it and nothing else", () => {
    const on = computeBlastRadius({ graph: GRAPH, changedFiles: CHANGED, testFiles });
    const off = computeBlastRadius({ graph: GRAPH, changedFiles: CHANGED, testFiles, config: { includeRelatedTests: false } });
    expect(off.counts.relatedTestsAdded).toBe(0);
    expect(off.files.map((entry) => entry.file)).toEqual(
      on.files.filter((entry) => entry.source === "graph").map((entry) => entry.file),
    );
  });

  test("tests already reached by the graph are labelled, not duplicated", () => {
    const result = computeBlastRadius({ graph: GRAPH, changedFiles: CHANGED, testFiles: ["src/a.test.ts"] });
    const entries = result.files.filter((entry) => entry.file === "src/a.test.ts");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe("graph");
    expect(entries[0]?.isTest).toBe(true);
    expect(result.counts.testsRetained).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC4 — recompute
// ---------------------------------------------------------------------------

describe("blastRadiusRecomputeDecision — AC4", () => {
  const previous = { changedFiles: ["src/a.ts", "src/b.ts"], depth: 2, maxFiles: 40 };

  test("the first round always computes one", () => {
    const decision = blastRadiusRecomputeDecision({ changedFiles: ["src/a.ts"], isFinalRound: false });
    expect(decision.recompute).toBe(true);
    expect(decision.reason).toContain("no previous blast radius");
  });

  test("an unchanged file set on a middle round reuses the previous radius", () => {
    const decision = blastRadiusRecomputeDecision({
      changedFiles: ["src/b.ts", "src/a.ts"],
      isFinalRound: false,
      previous,
    });
    expect(decision.recompute).toBe(false);
    expect(decision.added).toEqual([]);
    expect(decision.removed).toEqual([]);
  });

  test("the SAME unchanged file set on the final round recomputes anyway", () => {
    const decision = blastRadiusRecomputeDecision({
      changedFiles: ["src/b.ts", "src/a.ts"],
      isFinalRound: true,
      previous,
    });
    expect(decision.recompute).toBe(true);
    expect(decision.reason).toContain("final round");
  });

  test("a moved changed-file set recomputes and names what moved", () => {
    const decision = blastRadiusRecomputeDecision({
      changedFiles: ["src/a.ts", "src/c.ts"],
      isFinalRound: false,
      previous,
    });
    expect(decision.recompute).toBe(true);
    expect(decision.added).toEqual(["src/c.ts"]);
    expect(decision.removed).toEqual(["src/b.ts"]);
  });

  test("changing the bounds recomputes: the previous answer was to a different question", () => {
    const decision = blastRadiusRecomputeDecision({
      changedFiles: ["src/a.ts", "src/b.ts"],
      isFinalRound: false,
      previous,
      depth: 3,
    });
    expect(decision.recompute).toBe(true);
    expect(decision.reason).toContain("bounds changed");
  });

  test("path separators do not make an identical set look moved", () => {
    const decision = blastRadiusRecomputeDecision({
      changedFiles: ["./src/a.ts", "src\\b.ts"],
      isFinalRound: false,
      previous,
    });
    expect(decision.recompute).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC3 — what scope B may raise
// ---------------------------------------------------------------------------

function finding(overrides: Partial<StructuredReviewFinding>): Partial<StructuredReviewFinding> {
  return {
    id: "F-001",
    reviewer: "review-regression",
    severity: "major",
    problem: "callers of util.ts now receive undefined",
    impact: "the render throws",
    suggested_fix: "restore the guard",
    evidence: "src/a.ts:12 calls the changed helper in src/core/util.ts",
    confidence: "high",
    file: "src/a.ts",
    ...overrides,
  };
}

describe("screenBlastRadiusFindings — AC3: rejection in code, not in prose", () => {
  const set = radius();

  test("a chunk-pass finding is not held to outside-set or no-link-to-change, and the record says so", () => {
    const isPass = (candidate: Partial<StructuredReviewFinding>): boolean => candidate.reviewer?.includes("/chunk-") === true;
    const claim = finding({ reviewer: "review-regression/chunk-001", file: "src/somewhere/else.ts", problem: "this function is long", impact: "future maintenance", evidence: "none" });
    const result = screenBlastRadiusFindings([claim], set, { chunkPass: isPass });
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted).toHaveLength(1);
    expect(result.exempted[0]).toMatchObject({ reason: "chunk-pass" });
    expect(renderBlastRadiusScreenMarkdown(result)).toContain("chunk-pass");
  });

  test("a minor chunk-pass finding is still dropped by the severity floor", () => {
    const result = screenBlastRadiusFindings([finding({ reviewer: "review-regression/chunk-001", severity: "minor" })], set, { chunkPass: () => true });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.rule).toBe("non-regression-severity");
  });

  test("the exemption is the caller's to grant: a finding that only carries the name is screened as before", () => {
    const result = screenBlastRadiusFindings([finding({ reviewer: "review-regression/chunk-001", file: "src/somewhere/else.ts" })], set);
    expect(result.rejected[0]?.rule).toBe("outside-set");
  });

  test("a regression claim inside the set is accepted", () => {
    const result = screenBlastRadiusFindings([finding({})], set);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  test("a blocker regression is judged on the claim, not on who raised it", () => {
    // The reviewer deny-list rejected this on the name `review-architecture`
    // while the finding in front of it named a changed file, claimed a broken
    // build, and cited the command that fails. A false negative at `blocker` is
    // the exact failure the screen exists to prevent.
    const result = screenBlastRadiusFindings(
      [
        finding({
          reviewer: "review-architecture",
          severity: "blocker",
          file: "src/a.ts",
          problem: "src/a.ts now imports from src/core/util.ts in the other direction, so the module graph has a cycle and the CLI fails to boot",
          impact: "the CLI does not start",
          evidence: "bun src/cli.ts --help fails",
          suggested_fix: "break the cycle",
        }),
      ],
      set,
    );
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted).toHaveLength(1);
  });

  test("a style nit is still refused — by the severity floor, which is a fact about the claim", () => {
    const result = screenBlastRadiusFindings([finding({ reviewer: "review-style", severity: "minor" })], set);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.rule).toBe("non-regression-severity");
  });

  test("no rule reads the reviewer's name: the same claim is judged the same whoever signs it", () => {
    const claim = {
      severity: "major" as const,
      file: "src/a.ts",
      problem: "the changed util contract returns undefined, so this call site throws",
      impact: "the render throws",
      evidence: "src/a.ts:12",
      suggested_fix: "restore the guard",
    };
    for (const reviewer of ["review-regression", "review-style", " Review_Architecture (sonnet) ", "review-clean-code"]) {
      const result = screenBlastRadiusFindings([finding({ ...claim, reviewer })], set);
      expect(result.accepted).toHaveLength(1);
    }
  });

  test("a finding about a file outside the computed set is rejected", () => {
    const result = screenBlastRadiusFindings([finding({ file: "src/somewhere/else.ts" })], set);
    expect(result.rejected[0]?.rule).toBe("outside-set");
  });

  test("a finding about a CHANGED file is inside scope, not outside it", () => {
    const result = screenBlastRadiusFindings([finding({ file: "src/core/util.ts" })], set);
    expect(result.accepted).toHaveLength(1);
  });

  test("a file-less finding is anchored by class_scope, or not at all", () => {
    const anchored = screenBlastRadiusFindings(
      [finding({ file: null, class_scope: { sites: ["src/b.ts:9"], enumeration_method: "grep for the helper" } })],
      set,
    );
    expect(anchored.accepted).toHaveLength(1);
    const unanchored = screenBlastRadiusFindings([finding({ file: null })], set);
    expect(unanchored.rejected[0]?.rule).toBe("outside-set");
  });

  test("minor and info are rejected: under the canonical rubric neither can be a regression", () => {
    const minor = screenBlastRadiusFindings([finding({ severity: "minor" })], set);
    expect(minor.rejected[0]?.rule).toBe("non-regression-severity");
    const info = screenBlastRadiusFindings([finding({ severity: "info" })], set);
    expect(info.rejected[0]?.rule).toBe("non-regression-severity");
    const blocker = screenBlastRadiusFindings([finding({ severity: "blocker" })], set);
    expect(blocker.accepted).toHaveLength(1);
  });

  test("the floor is configurable, because the rubric belongs to the repository", () => {
    const result = screenBlastRadiusFindings([finding({ severity: "minor" })], set, { minSeverity: "minor" });
    expect(result.accepted).toHaveLength(1);
    expect(result.minSeverity).toBe("minor");
  });

  test("a finding that never names the change is not a regression claim", () => {
    const result = screenBlastRadiusFindings(
      [
        finding({
          problem: "this function is long and hard to follow",
          impact: "future maintenance",
          evidence: "src/a.ts:12",
          suggested_fix: "extract a helper",
        }),
      ],
      set,
    );
    expect(result.rejected[0]?.rule).toBe("no-link-to-change");
  });

  test("a finding anchored to a changed file is linked by the anchor, not by repeating it in prose", () => {
    // `file` was excluded from the text the link rule reads, so a finding already
    // anchored to a changed file by rule 1 was then refused for not naming that
    // same file again in a sentence. Nothing below mentions `util`.
    const result = screenBlastRadiusFindings(
      [
        finding({
          reviewer: "review-logic",
          severity: "blocker",
          file: "src/core/util.ts",
          problem: "the caller now passes an unbounded depth, so the command allocates until the process is killed",
          impact: "the process is OOM-killed",
          evidence: "OOM at 4.1 GB",
          suggested_fix: "bound the depth",
        }),
      ],
      set,
    );
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted).toHaveLength(1);
  });

  test("naming the changed module rather than the changed path still links", () => {
    const result = screenBlastRadiusFindings(
      [
        finding({
          problem: "the new util contract returns undefined for an empty list",
          impact: "src/a.ts throws",
          evidence: "src/a.ts:12",
          suggested_fix: "restore the empty-list branch",
        }),
      ],
      set,
    );
    expect(result.accepted).toHaveLength(1);
  });

  test("a rejected finding is returned, never dropped", () => {
    const rejectedFinding = finding({ reviewer: "review-style", severity: "minor", id: "F-042" });
    const result = screenBlastRadiusFindings([rejectedFinding], set);
    expect(result.rejected[0]?.finding).toBe(rejectedFinding);
    const markdown = renderBlastRadiusScreenMarkdown(result);
    expect(markdown).toContain("F-042");
    expect(markdown).toContain("non-regression-severity");
    expect(markdown).toContain("Rejected findings are recorded, not deleted");
  });

  test("the record states the floor even when nothing was rejected", () => {
    const markdown = renderBlastRadiusScreenMarkdown(screenBlastRadiusFindings([finding({})], set));
    expect(markdown).toContain("severity_floor: major");
    expect(markdown).toContain("accepted: 1");
    expect(markdown).toContain("rejected: 0");
    expect(markdown).toContain("exempted: 0");
    // Rule 3 DID judge this one, so the blanket sentence is a true claim here.
    expect(markdown).toContain("every scope-B finding was a regression claim inside the computed set");
  });

  test("the blocker exemption is recorded, and the record does not claim rule 3 passed", () => {
    // ONE finding, twice, changing only the severity — the exact pair that
    // exposed the hole. A pure style observation on an in-set hop-2 file, naming
    // nothing the change did: rule 3 refuses the `major` and does not judge the
    // `blocker`. Before this, the `blocker` landed in `accepted` looking exactly
    // like a claim that passed all three rules, and the renderer then asserted
    // "every scope-B finding was a regression claim inside the computed set" —
    // false for a finding rule 3 never read. Reachable for any in-set file by
    // self-labelling `blocker`, and the finding then blocks completion at the
    // review gate: the state AC3 exists to prevent.
    const styleNit = {
      file: "src/a.ts",
      problem: "this file's naming is inconsistent and the helper is hard to read",
      impact: "future maintenance",
      evidence: "src/a.ts:12",
      suggested_fix: "rename the helper",
    };

    const major = screenBlastRadiusFindings([finding({ ...styleNit, severity: "major" })], set);
    expect(major.accepted).toHaveLength(0);
    expect(major.rejected[0]?.rule).toBe("no-link-to-change");
    expect(major.exempted).toHaveLength(0);

    const blocked = finding({ ...styleNit, severity: "blocker" });
    const blocker = screenBlastRadiusFindings([blocked], set);
    expect(blocker.accepted).toHaveLength(1);
    expect(blocker.rejected).toHaveLength(0);
    expect(blocker.exempted).toHaveLength(1);
    expect(blocker.exempted[0]?.rule).toBe("no-link-to-change");
    expect(blocker.exempted[0]?.finding).toBe(blocked);

    const markdown = renderBlastRadiusScreenMarkdown(blocker);
    expect(markdown).toContain("accepted: 1 (1 admitted by the blocker exemption without naming the change)");
    expect(markdown).toContain("exempted: 1");
    expect(markdown).toContain("Admitted without being judged");
    expect(markdown).toContain("F-001");
    expect(markdown).not.toContain("every scope-B finding was a regression claim inside the computed set");
  });

  test("a blocker that DOES name the change is not exempt — it passed rule 3", () => {
    // The exemption records what the screen did not establish. A blocker that
    // links to the change was judged and passed, and calling that an exemption
    // would put a claim on the record about a rule that ran.
    const result = screenBlastRadiusFindings([finding({ severity: "blocker" })], set);
    expect(result.accepted).toHaveLength(1);
    expect(result.exempted).toHaveLength(0);
  });

  test("the refusal does not advertise its own bypass", () => {
    // The standard is set in `review-regression/SKILL.md`, BEFORE the round. A
    // runtime refusal that tells the refused reviewer which severity would have
    // got through is an instruction to relabel.
    const result = screenBlastRadiusFindings(
      [
        finding({
          problem: "this function is long and hard to follow",
          impact: "future maintenance",
          evidence: "src/a.ts:12",
          suggested_fix: "extract a helper",
        }),
      ],
      set,
    );
    expect(result.rejected[0]?.rule).toBe("no-link-to-change");
    expect(result.rejected[0]?.detail).not.toContain("exempt");
    expect(result.rejected[0]?.detail).toContain("Name the changed file, module or symbol whose behaviour moved.");
  });
});

// ---------------------------------------------------------------------------
// Which findings the screen is about
//
// The rules above judge the CLAIM and never the claimant. This decides which
// QUESTION a finding was asked, which is a property of the dispatch — scope A
// and scope B run in the same round, and screening scope A's findings by scope
// B's floor would delete every legitimate `minor` on a changed file.
// ---------------------------------------------------------------------------

describe("isBlastRadiusScopedFinding", () => {
  test("the scope-B reviewer is scope B, and the scope-A reviewers are not", () => {
    expect(isBlastRadiusScopedFinding({ reviewer: BLAST_RADIUS_SCOPE_REVIEWER })).toBe(true);
    expect(isBlastRadiusScopedFinding({ reviewer: "review-style" })).toBe(false);
    expect(isBlastRadiusScopedFinding({ reviewer: "review-logic" })).toBe(false);
  });

  test("a decorated or differently cased name is the same reviewer", () => {
    for (const reviewer of ["Review-Regression", " review_regression ", "review-regression (deep)"]) {
      expect(isBlastRadiusScopedFinding({ reviewer })).toBe(true);
    }
  });

  test("a finding with no reviewer is not claimed by scope B", () => {
    expect(isBlastRadiusScopedFinding({})).toBe(false);
    expect(isBlastRadiusScopedFinding({ reviewer: "" })).toBe(false);
  });

  test("an orchestrator that dispatched scope B under other names declares them", () => {
    expect(isBlastRadiusScopedFinding({ reviewer: "regression-sweep" }, ["regression-sweep"])).toBe(true);
    expect(isBlastRadiusScopedFinding({ reviewer: BLAST_RADIUS_SCOPE_REVIEWER }, ["regression-sweep"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The dispatch brief
// ---------------------------------------------------------------------------

describe("renderBlastRadiusDispatchBrief", () => {
  test("states the scope, the question, and what is not covered", () => {
    const brief = renderBlastRadiusDispatchBrief(radius({ maxFiles: 2 }));
    expect(brief).toContain("SCOPE: blast-radius");
    expect(brief).toContain("regression check, not under review");
    expect(brief).toContain("UNDER REGRESSION CHECK (2");
    expect(brief).toContain("NOT CHECKED");
    expect(brief).toContain("src/a.ts  [hop 1]");
  });

  test("the header does not contradict the rows under it", () => {
    // Related tests are ranked at `depth + 1` so the cap reaches them first, so a
    // flat `depth <= 2` sat above a hop-3 row. Cosmetic, but it is the text a
    // model is asked to trust.
    const withTest = computeBlastRadius({
      graph: GRAPH,
      changedFiles: ["src/a.ts"],
      testFiles: ["src/a.other.test.ts"],
    });
    const beyond = withTest.files.filter((entry) => entry.hop > withTest.depth);
    expect(beyond.length).toBeGreaterThan(0);
    const brief = renderBlastRadiusDispatchBrief(withTest);
    expect(brief).toContain(`graph depth <= ${withTest.depth}`);
    expect(brief).toContain(`ranked last, at hop ${withTest.depth + 1}`);
    for (const entry of beyond) {
      expect(brief).toContain(`[hop ${entry.hop}]`);
    }
    // And nothing claims a flat bound the rows break.
    expect(brief).not.toContain(`closest first, depth <= ${withTest.depth})`);
  });

  test("the related-test note is absent when no related test is in the set", () => {
    expect(renderBlastRadiusDispatchBrief(radius())).not.toContain("ranked last, at hop");
  });

  test("an empty radius is reported as unanswerable, not as clean", () => {
    const brief = renderBlastRadiusDispatchBrief(
      computeBlastRadius({ graph: GRAPH, changedFiles: ["docs/requirements/thing.md"] }),
    );
    expect(brief).toContain("NOT ANSWERABLE");
    expect(brief).toContain("unknown, not empty");
  });
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe("defaults", () => {
  test("depth 2 and 40 files, asserted here rather than only in a comment", () => {
    expect(DEFAULT_BLAST_RADIUS_DEPTH).toBe(2);
    expect(DEFAULT_BLAST_RADIUS_MAX_FILES).toBe(40);
    const result = computeBlastRadius({ graph: GRAPH, changedFiles: CHANGED });
    expect(result.depth).toBe(2);
    expect(result.maxFiles).toBe(40);
  });

  test("a nonsensical bound falls back rather than producing NaN", () => {
    const result = radius({ depth: Number.NaN, maxFiles: Number.NaN });
    expect(result.depth).toBe(DEFAULT_BLAST_RADIUS_DEPTH);
    expect(result.maxFiles).toBe(DEFAULT_BLAST_RADIUS_MAX_FILES);
  });

  test("a cap of zero reviews nothing and records the whole set as cut", () => {
    const result = radius({ maxFiles: 0 });
    expect(result.files).toHaveLength(0);
    expect(result.counts.droppedByCap).toBeGreaterThan(0);
  });
});

test("an exempted finding and a rejected one each sit under their own heading", () => {
  // The case no existing test had: every other render case has exempted OR
  // rejected at zero, and the exemption block opened a heading it never closed —
  // so the rejection table rendered as content of "Admitted without being
  // judged", showing a DELETED finding under a heading saying it was admitted.
  const radius = {
    changedFiles: ["src/gdskills/model-tier.ts"],
    files: [{ file: "src/harness/child/spawn.ts", hop: 2 }],
  };
  const screened = screenBlastRadiusFindings(
    [
      {
        id: "F-EXEMPT",
        reviewer: "review-regression",
        severity: "blocker",
        file: "src/harness/child/spawn.ts",
        problem: "this file's naming is inconsistent and the helper is hard to read",
        evidence: "read the file",
      },
      {
        id: "F-REJECT",
        reviewer: "review-regression",
        severity: "blocker",
        file: "src/nowhere.ts",
        problem: "something about a file that is not in the set at all",
        evidence: "read the file",
      },
    ] as never,
    radius as never,
  );
  expect(screened.exempted).toHaveLength(1);
  expect(screened.rejected).toHaveLength(1);

  const markdown = renderBlastRadiusScreenMarkdown(screened as never);
  const admitted = markdown.indexOf("### Admitted without being judged");
  const rejectedHeading = markdown.indexOf("### Rejected");
  const exemptRow = markdown.indexOf("F-EXEMPT");
  const rejectRow = markdown.indexOf("F-REJECT");

  expect(admitted).toBeGreaterThan(-1);
  expect(rejectedHeading).toBeGreaterThan(-1);
  // The exempted finding is under the admitted heading; the rejected one is not.
  expect(exemptRow).toBeGreaterThan(admitted);
  expect(exemptRow).toBeLessThan(rejectedHeading);
  expect(rejectRow).toBeGreaterThan(rejectedHeading);
});

// ---------------------------------------------------------------------------
// Flow 457 AC2/AC3 — symbol reach, text links and reasoned omissions
// ---------------------------------------------------------------------------

describe("the symbol radius records non-consumers as reasoned omissions (flow 457 AC2)", () => {
  const SOURCES: Record<string, string> = {
    "src/core.ts": "export function alpha(): number {\n  return 1;\n}\n\nexport function beta(): number {\n  return 2;\n}\n",
    "src/uses-alpha.ts": 'import { alpha } from "./core";\nexport const a = alpha();\n',
    "src/uses-beta.ts": 'import { beta } from "./core";\nexport const b = beta();\n',
    "src/after-alpha.ts": 'import { a } from "./uses-alpha";\nexport const c = a;\n',
  };
  const graph: GraphData = {
    nodes: Object.keys(SOURCES).map((path) => ({ id: path, kind: "file" as const, path, language: "typescript" as const })),
    edges: [
      { id: "1", from: "src/uses-alpha.ts", to: "src/core.ts", kind: "imports", specifier: "./core" },
      { id: "2", from: "src/uses-beta.ts", to: "src/core.ts", kind: "imports", specifier: "./core" },
      { id: "3", from: "src/after-alpha.ts", to: "src/uses-alpha.ts", kind: "imports", specifier: "./uses-alpha" },
    ],
  };
  const symbols = {
    read: { head: (file: string) => SOURCES[file] },
    diff: new Map([["src/core.ts", { path: "src/core.ts", oldPath: "src/core.ts", hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }] }]]),
  };

  test("a body edit to alpha keeps alpha's consumers and omits beta's importer with the reason and a detail", () => {
    const radius = computeBlastRadius({ graph, changedFiles: ["src/core.ts"], symbols, config: { includeRelatedTests: false } });
    expect(radius.files.map((entry) => [entry.file, entry.hop])).toEqual([
      ["src/uses-alpha.ts", 1],
      ["src/after-alpha.ts", 2],
    ]);
    expect(radius.dropped).toEqual([
      expect.objectContaining({ file: "src/uses-beta.ts", reason: "unrelated-symbol", detail: expect.stringContaining("imports {beta}") }),
    ]);
    expect(radius.counts.droppedByCap).toBe(0);
    expect(radius.counts.droppedUnrelatedSymbol).toBe(1);
    expect(radius.reach?.mode).toBe("symbol");
    expect(radius.reach?.seeds[0]?.names).toEqual(["alpha"]);
  });

  test("the plain file walk is unchanged without symbol input, and every reason is a known drop reason", () => {
    const radius = computeBlastRadius({ graph, changedFiles: ["src/core.ts"], config: { includeRelatedTests: false } });
    expect(radius.files.map((entry) => entry.file).sort()).toEqual(["src/after-alpha.ts", "src/uses-alpha.ts", "src/uses-beta.ts"]);
    expect(radius.reach).toBeUndefined();
    expect(BLAST_RADIUS_DROP_REASONS).toEqual(["cap", "pre-filter", "unrelated-symbol", "hub-damped", "text-hub", "test-consumer"]);
    expect(["cap", "legacy-unknown"].map(isCapDrop)).toEqual([true, true]);
    expect(["pre-filter", ...REASONED_DROP_REASONS].map(isCapDrop)).toEqual([false, false, false, false, false]);
  });

  test("the cap cuts only consumers; reasoned omissions never count against it", () => {
    const radius = computeBlastRadius({ graph, changedFiles: ["src/core.ts"], symbols, config: { includeRelatedTests: false, maxFiles: 1 } });
    expect(radius.files.map((entry) => entry.file)).toEqual(["src/uses-alpha.ts"]);
    expect(radius.dropped.map((drop) => [drop.file, drop.reason])).toEqual([
      ["src/after-alpha.ts", "cap"],
      ["src/uses-beta.ts", "unrelated-symbol"],
    ]);
  });

  test("text links add implicit consumers at hop 1; a hub key's files are text-hub omissions", () => {
    const radius = computeBlastRadius({
      graph,
      changedFiles: ["src/core.ts"],
      symbols,
      config: { includeRelatedTests: false },
      textLinks: {
        keys: [],
        links: [{ file: "src/locales/en.json", key: "core.title", kind: "i18n-key", via: "src/core.ts" }],
        hubs: [{ key: "btn", kind: "css-class", via: "src/core.ts", hits: 2, files: ["src/x.tsx", "src/uses-alpha.ts"], detail: "css-class btn is a hub" }],
        skipped: [],
      },
    });
    expect(radius.files.find((entry) => entry.file === "src/locales/en.json")).toMatchObject({ hop: 1, source: "text-link", path: ["src/locales/en.json", "src/core.ts"] });
    expect(radius.dropped.filter((drop) => drop.reason === "text-hub")).toEqual([
      expect.objectContaining({ file: "src/x.tsx", detail: "css-class btn is a hub" }),
    ]);
    expect(radius.counts.textLinksAdded).toBe(1);
    expect(radius.counts.droppedTextHub).toBe(1);
    const brief = renderBlastRadiusDispatchBrief(radius);
    expect(brief).toContain("OMITTED WITH A REASON (2");
    expect(brief).not.toContain("NOT CHECKED");
    expect(renderBlastRadiusMarkdown(radius)).toContain("omitted_unrelated_symbol: 1");
  });

  describe("tests are run, not read (test-consumer)", () => {
    const withTests: Record<string, string> = {
      ...SOURCES,
      "src/core.test.ts": 'import { alpha, beta } from "./core";\ntest("x", () => alpha() + beta());\n',
      "src/uses-alpha.test.ts": 'import { a } from "./uses-alpha";\ntest("y", () => a);\n',
    };
    const testGraph: GraphData = {
      nodes: Object.keys(withTests).map((path) => ({ id: path, kind: "file" as const, path, language: "typescript" as const })),
      edges: [
        ...graph.edges,
        { id: "4", from: "src/core.test.ts", to: "src/core.ts", kind: "imports", specifier: "./core" },
        { id: "5", from: "src/uses-alpha.test.ts", to: "src/uses-alpha.ts", kind: "imports", specifier: "./uses-alpha" },
      ],
    };
    const run = (testFiles: string[] = []) =>
      computeBlastRadius({
        graph: testGraph,
        changedFiles: ["src/core.ts"],
        testFiles,
        symbols: { ...symbols, read: { head: (file: string) => withTests[file] } },
        testCommand: "bun test",
        config: { maxFiles: 1 },
      });

    test("reached tests (any hop) and related tests are test-consumer omissions on the run list, never cap drops", () => {
      const radius = run(["src/core.test.ts", "src/other/core.test.ts"]);
      expect(radius.files.map((entry) => entry.file)).toEqual(["src/uses-alpha.ts"]);
      const tests = radius.dropped.filter((drop) => drop.reason === "test-consumer");
      expect(tests.map((drop) => [drop.file, drop.hop])).toEqual([
        ["src/core.test.ts", 1],
        ["src/uses-alpha.test.ts", 2],
        ["src/other/core.test.ts", 3],
      ]);
      expect(tests[0]?.detail).toBe("exercises {alpha} of src/core.ts (hop 1, from src/core.ts): run it, it is not read");
      expect(tests[1]?.detail).toContain("exercises {a} of src/uses-alpha.ts (hop 2");
      expect(tests[2]?.detail).toContain("a test named after the changed src/core.ts");
      expect(radius.dropped.filter((drop) => drop.reason === "cap").map((drop) => drop.file)).toEqual(["src/after-alpha.ts"]);
      expect(radius.counts.droppedTestConsumer).toBe(3);
      expect(radius.testsToRun).toEqual([
        { file: "src/core.test.ts", reason: "graph-consumer", symbols: ["alpha"], via: "src/core.ts" },
        { file: "src/other/core.test.ts", reason: "related-test", symbols: [], via: "src/core.ts" },
        { file: "src/uses-alpha.test.ts", reason: "graph-consumer", symbols: ["a"], via: "src/core.ts" },
      ]);
    });

    test("the brief and the markdown carry the run command", () => {
      const radius = run();
      const line = "2 tests exercise the changed code — run them: `bun test src/core.test.ts src/uses-alpha.test.ts`";
      expect(testsToRunLine(radius)).toBe(line);
      expect(renderBlastRadiusDispatchBrief(radius)).toContain(`TESTS TO RUN: ${line}`);
      expect(renderBlastRadiusMarkdown(radius)).toContain(`### Tests to run\n\n${line}`);
      expect(testsToRunLine({ testsToRun: radius.testsToRun ?? [] })).toBe("2 tests exercise the changed code — run them: src/core.test.ts src/uses-alpha.test.ts");
    });

    test("a hub-damped test stays on the run list (flow 457 review M1)", () => {
      const sources: Record<string, string> = { "src/hub.ts": "export function t(key: string): string {\n  return key;\n}\n" };
      for (let index = 0; index < 400; index += 1) sources[`src/c${index}.ts`] = `import { t } from "./hub";\nexport const v${index} = t("k");\n`;
      sources["src/c0.test.ts"] = 'import { v0 } from "./c0";\ntest("v0", () => v0);\n';
      const edges = Object.entries(sources).flatMap(([from, source]) => {
        const match = /from "\.\/([^"]+)"/.exec(source);
        return match === null ? [] : [{ id: from, from, to: `src/${match[1]}.ts`, kind: "imports" as const, specifier: `./${match[1]}` }];
      });
      const radius = computeBlastRadius({
        graph: { nodes: Object.keys(sources).map((path) => ({ id: path, kind: "file" as const, path, language: "typescript" as const })), edges },
        changedFiles: ["src/hub.ts"],
        symbols: {
          read: { head: (file: string) => sources[file] },
          diff: new Map([["src/hub.ts", { path: "src/hub.ts", oldPath: "src/hub.ts", hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }] }]]),
        },
        config: { includeRelatedTests: false, maxFiles: 1000 },
      });
      expect(radius.files).toHaveLength(400);
      expect(radius.dropped.find((drop) => drop.file === "src/c0.test.ts")?.reason).toBe("hub-damped");
      expect(radius.testsToRun).toEqual([{ file: "src/c0.test.ts", reason: "graph-consumer", symbols: [], via: "src/hub.ts" }]);
    });

    test("the plain file walk keeps tests in the reviewed set and has no run list", () => {
      const radius = computeBlastRadius({ graph: testGraph, changedFiles: ["src/core.ts"], config: { includeRelatedTests: false } });
      expect(radius.files.some((entry) => entry.file === "src/core.test.ts")).toBe(true);
      expect(radius.testsToRun).toBeUndefined();
    });
  });
});
