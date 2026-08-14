import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { validatePairedBenchmark } from "./benchmark";
import { goldTestImpact, type CoverageMap } from "./gold";
import {
  buildEvidenceBundle,
  buildGdctxManifest,
  buildMemorySearchManifest,
  buildOracleManifest,
  buildOracleManifestsByGold,
  buildTestImpactManifest,
  DEFAULT_DEPTH_SEMANTICS,
  extractFacts,
  GDCTX_FACT_PRESERVATION_LABEL,
  gdctxTaskId,
  GOLD_KIND_LABELS,
  MEMORY_SEARCH_LABEL,
  memorySearchTaskId,
  oracleTaskId,
  oracleTaskIdForGold,
  persistEvidenceBundle,
  runOracleAndPersist,
  scoreGdctxRun,
  scoreMemorySearchRun,
  scoreOracleTarget,
  scoreTestImpactRun,
  TEST_IMPACT_LABEL,
  testImpactTaskId,
  type GdctxScoreInput,
  type MemoryScoreInput,
  type MultiGoldScoreInput,
  type OracleScoreInput,
  type TestImpactScoreInput,
  buildWikiAskManifest,
  scoreWikiAskRun,
  wikiAskTaskId,
  GDWIKI_ASK_LABEL,
  type WikiScoreInput,
} from "./oracle-runner";

// Three targets mirroring fixtures/benchmark/express (lib/application.js has an empty gold
// set; lib/express.js and lib/utils.js each have a small non-empty gold set).
const PERFECT: OracleScoreInput = {
  target: "lib/express.js",
  system: ["History.md", "package.json"],
  gold: ["History.md", "package.json"],
};
const PARTIAL: OracleScoreInput = {
  // system finds 1 of 2 gold and 1 spurious => precision 0.5, recall 0.5, f1 0.5.
  target: "lib/utils.js",
  system: ["lib/response.js", "lib/spurious.js"],
  gold: ["lib/response.js", "lib/other.js"],
};
const ZERO_OVERLAP: OracleScoreInput = {
  target: "lib/application.js",
  system: ["a.js", "b.js"],
  gold: ["x.js", "y.js"],
};

describe("scoreOracleTarget", () => {
  test("perfect match => precision/recall/f1 all 1", () => {
    const score = scoreOracleTarget(PERFECT);
    expect(score.precision).toBe(1);
    expect(score.recall).toBe(1);
    expect(score.f1).toBe(1);
    expect(score.truePositives).toBe(2);
    expect(score.falsePositives).toBe(0);
    expect(score.falseNegatives).toBe(0);
  });

  test("partial overlap => 0.5 across the board", () => {
    const score = scoreOracleTarget(PARTIAL);
    expect(score.precision).toBe(0.5);
    expect(score.recall).toBe(0.5);
    expect(score.f1).toBe(0.5);
    expect(score.truePositives).toBe(1);
    expect(score.falsePositives).toBe(1);
    expect(score.falseNegatives).toBe(1);
  });

  test("zero overlap => precision/recall/f1 all 0", () => {
    const score = scoreOracleTarget(ZERO_OVERLAP);
    expect(score.precision).toBe(0);
    expect(score.recall).toBe(0);
    expect(score.f1).toBe(0);
    expect(score.truePositives).toBe(0);
    expect(score.falsePositives).toBe(2);
    expect(score.falseNegatives).toBe(2);
  });

  test("empty gold set => recall is vacuously 1 (ir.ts convention)", () => {
    const score = scoreOracleTarget({ target: "t", system: ["a"], gold: [] });
    expect(score.recall).toBe(1);
    expect(score.precision).toBe(0); // "a" is not in the (empty) gold set
  });

  test("deterministic: same input yields identical scores", () => {
    expect(scoreOracleTarget(PARTIAL)).toEqual(scoreOracleTarget(PARTIAL));
  });
});

describe("buildOracleManifest", () => {
  test("emitted manifest passes validatePairedBenchmark", () => {
    const manifest = buildOracleManifest([PERFECT, PARTIAL, ZERO_OVERLAP]);
    const result = validatePairedBenchmark(manifest);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.protocol).toBe("paired-3-5-v2");
  });

  test("manifest is metastore ladder with one deterministic baseline run per target", () => {
    const manifest = buildOracleManifest([PERFECT, PARTIAL, ZERO_OVERLAP]);
    expect(manifest.ladder).toBe("metastore");
    expect(manifest.runs).toHaveLength(3);
    for (const run of manifest.runs) {
      expect(run.caseKind).toBe("deterministic");
      expect(run.variant).toBe("baseline");
      expect(run.seeds).toEqual([1]);
      expect(run.oracle?.precision?.reliability).toBe("exact");
      expect(run.oracle?.recall?.reliability).toBe("exact");
      expect(run.oracle?.f1?.reliability).toBe("exact");
    }
    expect(manifest.task_ids).toEqual(
      [PERFECT, PARTIAL, ZERO_OVERLAP].map((i) => oracleTaskId(i.target)).sort(),
    );
  });

  test("perfect-match run carries precision/recall values of 1", () => {
    const manifest = buildOracleManifest([PERFECT, PARTIAL, ZERO_OVERLAP]);
    const perfect = manifest.runs.find((run) => run.task_id === oracleTaskId(PERFECT.target));
    expect(perfect?.oracle?.precision?.value).toBe(1);
    expect(perfect?.oracle?.recall?.value).toBe(1);
    expect(perfect?.oracle?.f1?.value).toBe(1);
    // rate blocks carry a Wilson CI and a matching point rate
    expect(perfect?.rates?.precision?.rate).toBe(1);
    expect(perfect?.rates?.recall?.rate).toBe(1);
  });

  test("zero-overlap run carries precision/recall values of 0 and still validates", () => {
    const manifest = buildOracleManifest([PERFECT, PARTIAL, ZERO_OVERLAP]);
    const zero = manifest.runs.find((run) => run.task_id === oracleTaskId(ZERO_OVERLAP.target));
    expect(zero?.oracle?.precision?.value).toBe(0);
    expect(zero?.oracle?.recall?.value).toBe(0);
    expect(zero?.oracle?.f1?.value).toBe(0);
    expect(zero?.rates?.precision?.successes).toBe(0);
    expect(validatePairedBenchmark(manifest).valid).toBe(true);
  });

  test("empty retrieved set omits the precision rate (no fabricated n)", () => {
    const manifest = buildOracleManifest([
      { target: "empty-sys", system: [], gold: ["g"] },
      PERFECT,
      PARTIAL,
    ]);
    const empty = manifest.runs.find((run) => run.task_id === oracleTaskId("empty-sys"));
    expect(empty?.rates?.precision).toBeUndefined();
    // recall still has an n (gold non-empty)
    expect(empty?.rates?.recall?.n).toBe(1);
    expect(validatePairedBenchmark(manifest).valid).toBe(true);
  });

  test("manifest is byte-for-byte reproducible", () => {
    const a = buildOracleManifest([PERFECT, PARTIAL, ZERO_OVERLAP]);
    const b = buildOracleManifest([PERFECT, PARTIAL, ZERO_OVERLAP]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("buildOracleManifestsByGold (two-gold, decision (a)+(b))", () => {
  // One system output scored against BOTH golds. Mirrors the real express shape: the
  // dependency-based system set matches co-change poorly but is a real subset of the
  // transitive import closure (co-change gold vs dependency gold).
  const INPUTS: MultiGoldScoreInput[] = [
    {
      target: "lib/application.js",
      system: ["lib/express.js", "lib/utils.js", "lib/view.js"],
      golds: [
        { kind: "co-change", gold: [] },
        { kind: "dependency", gold: ["lib/express.js", "lib/utils.js", "lib/view.js", "index.js"] },
      ],
    },
    {
      target: "lib/express.js",
      system: ["lib/application.js", "lib/request.js"],
      golds: [
        { kind: "co-change", gold: ["History.md", "package.json"] },
        { kind: "dependency", gold: ["lib/application.js", "lib/request.js", "lib/response.js", "lib/utils.js"] },
      ],
    },
    {
      target: "lib/utils.js",
      system: ["lib/response.js", "test/utils.js"],
      golds: [
        { kind: "co-change", gold: ["lib/response.js"] },
        { kind: "dependency", gold: ["lib/response.js", "test/utils.js", "index.js", "lib/express.js"] },
      ],
    },
  ];

  test("yields two labeled manifests, one per gold kind, both valid", () => {
    const manifests = buildOracleManifestsByGold(INPUTS);
    expect(Object.keys(manifests).sort()).toEqual(["co-change", "dependency"]);
    for (const kind of ["co-change", "dependency"] as const) {
      const manifest = manifests[kind];
      expect(manifest).toBeDefined();
      const result = validatePairedBenchmark(manifest!);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
      expect(manifest!.ladder).toBe("metastore");
      expect(manifest!.runs).toHaveLength(3);
      // Every run is a deterministic baseline whose task id and metric label carry the kind.
      for (const run of manifest!.runs) {
        expect(run.caseKind).toBe("deterministic");
        expect(run.task_id).toContain(`:${kind}:`);
        expect(run.oracle?.precision?.source).toContain(`gold=${kind}: ${GOLD_KIND_LABELS[kind]}`);
        expect(run.oracle?.precision?.notes).toBe(DEFAULT_DEPTH_SEMANTICS[kind]);
      }
    }
  });

  test("the two golds are scored separately, never averaged", () => {
    const manifests = buildOracleManifestsByGold(INPUTS);
    const co = manifests["co-change"]!;
    const dep = manifests["dependency"]!;
    // lib/utils.js: perfect recall on co-change (response.js found), and on the dependency
    // gold every system id is a real closure member => precision 1.
    const coUtils = co.runs.find((r) => r.task_id === oracleTaskIdForGold("co-change", "lib/utils.js"));
    const depUtils = dep.runs.find((r) => r.task_id === oracleTaskIdForGold("dependency", "lib/utils.js"));
    expect(coUtils?.oracle?.recall?.value).toBe(1); // response.js is the only co-change gold and was found
    expect(coUtils?.oracle?.precision?.value).toBe(0.5); // 1 of 2 system ids is a co-change gold member
    expect(depUtils?.oracle?.precision?.value).toBe(1); // both system ids are in the dependency gold
    // Distinct numbers per gold — a single averaged value could not equal both precisions.
    expect(coUtils?.oracle?.precision?.value).not.toBe(depUtils?.oracle?.precision?.value);
  });

  test("perfect and zero cases per gold both validate", () => {
    const perfectCoZeroDep: MultiGoldScoreInput = {
      target: "t1",
      system: ["a", "b"],
      golds: [
        { kind: "co-change", gold: ["a", "b"] }, // perfect
        { kind: "dependency", gold: ["x", "y"] }, // zero overlap
      ],
    };
    const zeroCoPerfectDep: MultiGoldScoreInput = {
      target: "t2",
      system: ["c", "d"],
      golds: [
        { kind: "co-change", gold: ["p", "q"] }, // zero overlap
        { kind: "dependency", gold: ["c", "d"] }, // perfect
      ],
    };
    const partial: MultiGoldScoreInput = {
      target: "t3",
      system: ["e", "z"],
      golds: [
        { kind: "co-change", gold: ["e", "f"] },
        { kind: "dependency", gold: ["e", "f"] },
      ],
    };
    const manifests = buildOracleManifestsByGold([perfectCoZeroDep, zeroCoPerfectDep, partial]);
    const co = manifests["co-change"]!;
    const dep = manifests["dependency"]!;
    expect(validatePairedBenchmark(co).valid).toBe(true);
    expect(validatePairedBenchmark(dep).valid).toBe(true);

    const coPerfect = co.runs.find((r) => r.task_id === oracleTaskIdForGold("co-change", "t1"));
    expect(coPerfect?.oracle?.f1?.value).toBe(1);
    const depPerfect = dep.runs.find((r) => r.task_id === oracleTaskIdForGold("dependency", "t2"));
    expect(depPerfect?.oracle?.f1?.value).toBe(1);
    const coZero = co.runs.find((r) => r.task_id === oracleTaskIdForGold("co-change", "t2"));
    expect(coZero?.oracle?.f1?.value).toBe(0);
    const depZero = dep.runs.find((r) => r.task_id === oracleTaskIdForGold("dependency", "t1"));
    expect(depZero?.oracle?.f1?.value).toBe(0);
  });

  test("a custom depthSemantics/label override flows onto every metric of that gold", () => {
    const inputs: MultiGoldScoreInput[] = INPUTS.map((input) => ({
      ...input,
      golds: input.golds.map((g) =>
        g.kind === "dependency" ? { ...g, label: "graph correctness @ depth 1", depthSemantics: "aligned to maxDepth=1" } : g,
      ),
    }));
    const dep = buildOracleManifestsByGold(inputs)["dependency"]!;
    for (const run of dep.runs) {
      expect(run.oracle?.f1?.notes).toBe("aligned to maxDepth=1");
      expect(run.oracle?.f1?.source).toContain("graph correctness @ depth 1");
    }
  });

  test("byte-for-byte reproducible per gold kind", () => {
    const a = buildOracleManifestsByGold(INPUTS);
    const b = buildOracleManifestsByGold(INPUTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("testing / TIA oracle (system test-impact vs coverage-derived gold)", () => {
  // Mirrors the real keryx dogfood slice (fixtures/benchmark/keryx): a per-test coverage
  // map, from which goldTestImpact derives the impacted-test gold for each changed file,
  // scored against the `keryx test related` naming+import heuristic system output.
  const COVERAGE: CoverageMap = {
    "src/metrics/gold.test.ts": ["src/metrics/gold.ts"],
    "src/metrics/ir.test.ts": ["src/metrics/ir.ts"],
    "src/metrics/oracle-runner.test.ts": [
      "src/metrics/benchmark.ts",
      "src/metrics/gold.ts",
      "src/metrics/ir.ts",
      "src/metrics/oracle-runner.ts",
    ],
    "src/metrics/service.test.ts": ["src/metrics/benchmark.ts"],
  };
  // System output = `keryx test related <changedFile>` per target (naming + direct-import).
  const SYSTEM: Record<string, string[]> = {
    "src/metrics/benchmark.ts": ["src/metrics/oracle-runner.test.ts"],
    "src/metrics/gold.ts": ["src/metrics/gold.test.ts", "src/metrics/oracle-runner.test.ts"],
    "src/metrics/ir.ts": ["src/metrics/ir.test.ts"],
    "src/metrics/oracle-runner.ts": ["src/metrics/oracle-runner.test.ts"],
  };
  const inputsFor = (changedFiles: readonly string[]): TestImpactScoreInput[] =>
    changedFiles.map((changedFile) => ({
      changedFile,
      system: SYSTEM[changedFile] ?? [],
      gold: goldTestImpact(COVERAGE, [changedFile]),
    }));

  test("perfect case: system == coverage-derived gold => precision/recall/f1 all 1", () => {
    // gold.ts is covered only by gold.test.ts, which is exactly what the heuristic finds.
    const run = scoreTestImpactRun(inputsFor(["src/metrics/gold.ts"])[0]!);
    expect(run.oracle?.precision?.value).toBe(1);
    expect(run.oracle?.recall?.value).toBe(1);
    expect(run.oracle?.f1?.value).toBe(1);
    expect(run.oracle?.precision?.reliability).toBe("exact");
  });

  test("recall gap: heuristic misses a transitively-covering test", () => {
    // ir.ts is covered by ir.test.ts AND oracle-runner.test.ts (which imports oracle-runner,
    // not ir, so `test related` misses it): precision 1, recall 0.5, f1 ~0.667.
    const run = scoreTestImpactRun(inputsFor(["src/metrics/ir.ts"])[0]!);
    expect(run.oracle?.precision?.value).toBe(1);
    expect(run.oracle?.recall?.value).toBe(0.5);
    expect(run.oracle?.f1?.value).toBeCloseTo(2 / 3, 10);
  });

  test("zero case: system finds a test the coverage gold does not include", () => {
    const run = scoreTestImpactRun({
      changedFile: "src/metrics/orphan.ts",
      system: ["src/metrics/wrong.test.ts"],
      gold: goldTestImpact(COVERAGE, ["src/metrics/orphan.ts"]), // no coverage => empty gold
    });
    // Empty gold => recall vacuously 1 (ir.ts convention), but the spurious system id is a
    // false positive so precision is 0.
    expect(run.oracle?.recall?.value).toBe(1);
    expect(run.oracle?.precision?.value).toBe(0);
  });

  test("task ids carry the test-impact namespace and metric source carries the layer label", () => {
    const run = scoreTestImpactRun(inputsFor(["src/metrics/ir.ts"])[0]!);
    expect(run.task_id).toBe(testImpactTaskId("src/metrics/ir.ts"));
    expect(run.task_id).toContain("metastore:test-impact:");
    expect(run.oracle?.precision?.source).toContain(`layer=testing: ${TEST_IMPACT_LABEL}`);
  });

  test("emitted manifest is a valid metastore paired-3-5-v2 manifest", () => {
    const manifest = buildTestImpactManifest(
      inputsFor([
        "src/metrics/benchmark.ts",
        "src/metrics/gold.ts",
        "src/metrics/ir.ts",
        "src/metrics/oracle-runner.ts",
      ]),
    );
    const result = validatePairedBenchmark(manifest);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(manifest.ladder).toBe("metastore");
    expect(manifest.runs).toHaveLength(4);
    for (const run of manifest.runs) {
      expect(run.caseKind).toBe("deterministic");
      expect(run.variant).toBe("baseline");
      expect(run.seeds).toEqual([1]);
    }
  });

  test("full-slice numbers match the committed dogfood result (precision 1; recall 1/1/0.5/0.5)", () => {
    const manifest = buildTestImpactManifest(
      inputsFor([
        "src/metrics/benchmark.ts",
        "src/metrics/gold.ts",
        "src/metrics/ir.ts",
        "src/metrics/oracle-runner.ts",
      ]),
    );
    const byId = new Map(manifest.runs.map((run) => [run.task_id, run]));
    const recall = (f: string): number | null | undefined =>
      byId.get(testImpactTaskId(f))?.oracle?.recall?.value;
    const precision = (f: string): number | null | undefined =>
      byId.get(testImpactTaskId(f))?.oracle?.precision?.value;
    for (const f of Object.keys(SYSTEM)) expect(precision(f)).toBe(1);
    expect(recall("src/metrics/gold.ts")).toBe(1);
    expect(recall("src/metrics/oracle-runner.ts")).toBe(1);
    expect(recall("src/metrics/ir.ts")).toBe(0.5);
    expect(recall("src/metrics/benchmark.ts")).toBe(0.5);
  });

  test("byte-for-byte reproducible", () => {
    const files = ["src/metrics/benchmark.ts", "src/metrics/gold.ts", "src/metrics/ir.ts"];
    const a = buildTestImpactManifest(inputsFor(files));
    const b = buildTestImpactManifest(inputsFor(files));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("gdwiki oracle (ranked passages vs curated Q→passage gold, nDCG/recall@k + groundedness)", () => {
  const G_STRICT = { scores: [2, 2, 2] as const, rationale: "all judges: cited passage grounds the answer" };
  const PERFECT_WIKI: WikiScoreInput = {
    query: "how does the OS sandbox contain a process",
    system: ["architecture/os-sandbox.md", "architecture/project-map.md"],
    gold: ["architecture/os-sandbox.md"],
    k: 5,
    groundedness: G_STRICT,
  };
  const ZERO_WIKI: WikiScoreInput = {
    query: "an unrelated question with no relevant passage",
    system: ["architecture/project-map.md", "architecture/testing-map.md"],
    gold: ["architecture/quality-map.md"],
    k: 5,
    groundedness: { scores: [0, 0, 0] as const, rationale: "no cited passage grounds the answer" },
  };
  const BOUNDARY_SYSTEM = ["a.md", "b.md", "c.md", "d.md"];
  const BOUNDARY_GOLD = ["c.md"];

  test("perfect case: gold passage at rank 1 => nDCG 1 and recall@k 1", () => {
    const run = scoreWikiAskRun(PERFECT_WIKI);
    expect(run.oracle?.ndcg?.value).toBe(1);
    expect(run.oracle?.recallAtK?.value).toBe(1);
    expect(run.oracle?.ndcg?.reliability).toBe("exact");
  });

  test("zero case: gold passage absent from citations => nDCG 0 and recall@k 0", () => {
    const run = scoreWikiAskRun(ZERO_WIKI);
    expect(run.oracle?.ndcg?.value).toBe(0);
    expect(run.oracle?.recallAtK?.value).toBe(0);
  });

  test("k-boundary: same ranking, only k differs, flips recall@k between 0 and 1", () => {
    const atK2 = scoreWikiAskRun({ query: "b", system: BOUNDARY_SYSTEM, gold: BOUNDARY_GOLD, k: 2, groundedness: G_STRICT });
    const atK3 = scoreWikiAskRun({ query: "b", system: BOUNDARY_SYSTEM, gold: BOUNDARY_GOLD, k: 3, groundedness: G_STRICT });
    expect(atK2.oracle?.recallAtK?.value).toBe(0);
    expect(atK3.oracle?.recallAtK?.value).toBe(1);
  });

  test("groundedness judge panel: strict = all three score 2, lenient = at least two", () => {
    const strict = scoreWikiAskRun({ ...PERFECT_WIKI, groundedness: { scores: [2, 2, 2] as const } });
    const lenient = scoreWikiAskRun({ ...PERFECT_WIKI, groundedness: { scores: [2, 2, 1] as const } });
    const fail = scoreWikiAskRun({ ...PERFECT_WIKI, groundedness: { scores: [2, 1, 1] as const } });
    expect(strict.judge?.strict).toBe(true);
    expect(strict.judge?.lenient).toBe(true);
    expect(lenient.judge?.strict).toBe(false);
    expect(lenient.judge?.lenient).toBe(true);
    expect(fail.judge?.lenient).toBe(false);
  });

  test("task id carries the gdwiki namespace and metric source carries the layer label + k", () => {
    const run = scoreWikiAskRun(PERFECT_WIKI);
    expect(run.task_id).toBe(wikiAskTaskId(PERFECT_WIKI.query));
    expect(run.task_id).toContain("metastore:gdwiki-ask:");
    expect(run.oracle?.ndcg?.source).toContain(`layer=gdwiki: ${GDWIKI_ASK_LABEL}, k=${PERFECT_WIKI.k}`);
  });

  test("emitted manifest is a valid metastore paired-3-5-v2 manifest", () => {
    const manifest = buildWikiAskManifest([
      PERFECT_WIKI,
      ZERO_WIKI,
      { query: "third", system: BOUNDARY_SYSTEM, gold: BOUNDARY_GOLD, k: 3, groundedness: G_STRICT },
    ]);
    const result = validatePairedBenchmark(manifest);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(manifest.ladder).toBe("metastore");
    expect(manifest.runs).toHaveLength(3);
  });
});

describe("memory oracle (ranked system search vs curated gold, recall@k)", () => {
  // Mirrors the real keryx dogfood slice (fixtures/benchmark/keryx/memory-{gold,search-results}.json):
  // a curated gold relevant-id per query, scored against the ranked `keryx memory search`
  // system output.
  const PERFECT_MEM: MemoryScoreInput = {
    query: "flow ids allocated per clone worktree",
    system: ["constraints/flow-ids-allocated-per-clone.md", "lessons/allowlist-not-a-boundary.md"],
    gold: ["constraints/flow-ids-allocated-per-clone.md"],
    k: 2,
  };
  const ZERO_MEM: MemoryScoreInput = {
    query: "an unrelated query with no match",
    system: ["lessons/tui-alignself-height-collapse.md", "lessons/regex-guards-lose-to-spellings.md"],
    gold: ["constraints/code-blanks-string-literals.md"],
    k: 2,
  };
  // k-boundary: the sole gold id sits at rank 3, so k=2 excludes it (recall@2 = 0) while
  // k=3 includes it (recall@3 = 1) — same system/gold, only k differs.
  const BOUNDARY_SYSTEM = [
    "lessons/allowlist-not-a-boundary.md",
    "lessons/tui-alignself-height-collapse.md",
    "lessons/regex-guards-lose-to-spellings.md",
    "constraints/stale-installed-keryx-binary.md",
  ];
  const BOUNDARY_GOLD = ["lessons/regex-guards-lose-to-spellings.md"];

  test("perfect case: gold id found within k => recall@k 1, unranked recall 1", () => {
    const run = scoreMemorySearchRun(PERFECT_MEM);
    expect(run.oracle?.recallAtK?.value).toBe(1);
    expect(run.oracle?.recall?.value).toBe(1);
    expect(run.oracle?.precision?.value).toBe(0.5); // 1 of 2 system ids is gold
    expect(run.oracle?.recallAtK?.reliability).toBe("exact");
  });

  test("zero case: gold id absent from the ranked list => recall@k 0, unranked recall 0", () => {
    const run = scoreMemorySearchRun(ZERO_MEM);
    expect(run.oracle?.recallAtK?.value).toBe(0);
    expect(run.oracle?.recall?.value).toBe(0);
    expect(run.oracle?.precision?.value).toBe(0);
  });

  test("k-boundary: same system/gold, only k differs, flips recall@k between 0 and 1", () => {
    const atK2 = scoreMemorySearchRun({ query: "boundary", system: BOUNDARY_SYSTEM, gold: BOUNDARY_GOLD, k: 2 });
    const atK3 = scoreMemorySearchRun({ query: "boundary", system: BOUNDARY_SYSTEM, gold: BOUNDARY_GOLD, k: 3 });
    expect(atK2.oracle?.recallAtK?.value).toBe(0);
    expect(atK3.oracle?.recallAtK?.value).toBe(1);
    // Unranked recall is k-independent: the gold id is present in the full system list either way.
    expect(atK2.oracle?.recall?.value).toBe(1);
    expect(atK3.oracle?.recall?.value).toBe(1);
  });

  test("task id carries the memory-search namespace and metric source carries the layer label + k", () => {
    const run = scoreMemorySearchRun(PERFECT_MEM);
    expect(run.task_id).toBe(memorySearchTaskId(PERFECT_MEM.query));
    expect(run.task_id).toContain("metastore:memory-search:");
    expect(run.oracle?.recallAtK?.source).toContain(`layer=memory: ${MEMORY_SEARCH_LABEL}, k=${PERFECT_MEM.k}`);
  });

  test("emitted manifest is a valid metastore paired-3-5-v2 manifest", () => {
    const inputs: MemoryScoreInput[] = [
      PERFECT_MEM,
      ZERO_MEM,
      { query: "boundary-2", system: BOUNDARY_SYSTEM, gold: BOUNDARY_GOLD, k: 3 },
    ];
    const manifest = buildMemorySearchManifest(inputs);
    const result = validatePairedBenchmark(manifest);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(manifest.ladder).toBe("metastore");
    expect(manifest.runs).toHaveLength(3);
    for (const run of manifest.runs) {
      expect(run.caseKind).toBe("deterministic");
      expect(run.variant).toBe("baseline");
      expect(run.seeds).toEqual([1]);
      expect(run.oracle?.recallAtK?.reliability).toBe("exact");
    }
  });

  test("never averaged with the gdgraph/testing oracles: distinct task-id namespace", () => {
    const memRun = scoreMemorySearchRun(PERFECT_MEM);
    const testRun = scoreTestImpactRun({ changedFile: "src/x.ts", system: ["a"], gold: ["a"] });
    expect(memRun.task_id.startsWith("metastore:memory-search:")).toBe(true);
    expect(testRun.task_id.startsWith("metastore:test-impact:")).toBe(true);
    expect(memRun.task_id).not.toBe(testRun.task_id);
  });

  test("byte-for-byte reproducible", () => {
    const inputs: MemoryScoreInput[] = [PERFECT_MEM, ZERO_MEM];
    const a = inputs.map((i) => scoreMemorySearchRun(i));
    const b = inputs.map((i) => scoreMemorySearchRun(i));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("extractFacts (gdctx fact-extraction rule)", () => {
  test("extracts bare relative file-path lines (dot-extension required)", () => {
    const facts = extractFacts("src/metrics/ir.ts\nsrc/metrics/gold.ts\n");
    expect(facts).toEqual(["src/metrics/gold.ts", "src/metrics/ir.ts"]);
  });

  test("extracts a leading-dot (hidden-dir) path, e.g. keryx's own .metaproject tree", () => {
    const facts = extractFacts(".metaproject/skills/catalog.md");
    expect(facts).toEqual([".metaproject/skills/catalog.md"]);
  });

  test("extracts `key: value` metadata lines, normalized and backtick-insensitive", () => {
    const facts = extractFacts("Exit code: 0\nRaw lines: `18`\nstdout bytes: 436\n");
    expect(facts.sort()).toEqual(["exit code:0", "raw lines:18", "stdout bytes:436"]);
  });

  test("recovers a path token embedded in a longer header line", () => {
    const facts = extractFacts("Command: `bash -c find src/metrics/ir.ts`");
    expect(facts).toContain("src/metrics/ir.ts");
  });

  test("does not treat a bare directory (no extension) or an elision marker as a fact", () => {
    const facts = extractFacts(
      "Command: `bash -c find .metaproject/skills -type f`\n... omitted 35 lines ...\n```text\n```\n",
    );
    expect(facts).toEqual([]);
  });

  test("dedupes repeated facts across lines", () => {
    const facts = extractFacts("src/metrics/ir.ts\nsrc/metrics/ir.ts\n");
    expect(facts).toEqual(["src/metrics/ir.ts"]);
  });

  test("a fact preserved verbatim in a re-wrapped compact line normalizes identically", () => {
    const raw = extractFacts("Raw lines: 18");
    const compact = extractFacts("Raw lines: `18`");
    expect(raw).toEqual(compact);
  });
});

describe("gdctx fact-preservation oracle (compact form vs raw-output facts)", () => {
  // Mirrors the real keryx dogfood slice (fixtures/benchmark/keryx/gdctx-fact-preservation.json):
  // rawFacts/compactFacts already extracted (via extractFacts) from a real `keryx ctx run --
  // <command>` compaction, so the oracle-runner tests here stay offline and deterministic.
  const PERFECT_GDCTX: GdctxScoreInput = {
    // Real committed shape: a listing short enough that gdctx's compactor never truncates it,
    // so every raw fact survives — see fixtures/benchmark/keryx/gdctx-fact-preservation.json
    // ("bash -c find src/metrics -type f | sort", rate 1.0, 18/18).
    input: "bash -c find src/metrics -type f | sort",
    rawFacts: ["src/metrics/gold.ts", "src/metrics/ir.ts", "src/metrics/oracle-runner.ts"],
    // The compact form also carries header-only facts (exit code, raw lines) that are not in
    // rawFacts — they must not affect the score (factPreservation only counts RAW facts found
    // in the compact set, never penalizes or rewards extras).
    compactFacts: ["exit code:0", "raw lines:3", "src/metrics/gold.ts", "src/metrics/ir.ts", "src/metrics/oracle-runner.ts"],
  };
  const LOSSY_GDCTX: GdctxScoreInput = {
    // Real committed shape: a listing long enough that gdctx's compactor elides the middle —
    // see fixtures/benchmark/keryx/gdctx-fact-preservation.json ("bash -c find docs -type f |
    // sort", rate ~0.336, 110/327). Here: 2 of 4 raw facts survive => rate 0.5.
    input: "bash -c find docs -type f | sort",
    rawFacts: ["docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md"],
    compactFacts: ["docs/a.md", "docs/d.md", "exit code:0", "raw lines:4"],
  };
  const ZERO_GDCTX: GdctxScoreInput = {
    input: "zero-preservation",
    rawFacts: ["a.ts", "b.ts"],
    compactFacts: ["exit code:0"],
  };

  test("perfect preservation: every raw fact survives => rate 1.0", () => {
    const run = scoreGdctxRun(PERFECT_GDCTX);
    expect(run.oracle?.factPreservation?.value).toBe(1);
    expect(run.oracle?.factPreservation?.reliability).toBe("exact");
    expect(run.rates?.factPreservation).toEqual({
      successes: 3,
      n: 3,
      rate: 1,
      ci95: { lower: expect.any(Number), upper: 1 },
      reliability: "exact",
    });
  });

  test("lossy case: half the raw facts survive => rate 0.5", () => {
    const run = scoreGdctxRun(LOSSY_GDCTX);
    expect(run.oracle?.factPreservation?.value).toBe(0.5);
    expect(run.rates?.factPreservation?.successes).toBe(2);
    expect(run.rates?.factPreservation?.n).toBe(4);
  });

  test("zero case: no raw fact survives => rate 0", () => {
    const run = scoreGdctxRun(ZERO_GDCTX);
    expect(run.oracle?.factPreservation?.value).toBe(0);
    expect(run.rates?.factPreservation?.successes).toBe(0);
  });

  test("empty raw-facts set => rate vacuously 1 and no fabricated rate n", () => {
    const run = scoreGdctxRun({ input: "empty-raw", rawFacts: [], compactFacts: ["a.ts"] });
    expect(run.oracle?.factPreservation?.value).toBe(1);
    expect(run.rates?.factPreservation).toBeUndefined();
  });

  test("task id carries the gdctx-fact-preservation namespace and metric source carries the layer label", () => {
    const run = scoreGdctxRun(PERFECT_GDCTX);
    expect(run.task_id).toBe(gdctxTaskId(PERFECT_GDCTX.input));
    expect(run.task_id).toContain("metastore:gdctx-fact-preservation:");
    expect(run.oracle?.factPreservation?.source).toContain(`layer=gdctx: ${GDCTX_FACT_PRESERVATION_LABEL}`);
  });

  test("deterministic case shape: baseline variant, single seed", () => {
    const run = scoreGdctxRun(PERFECT_GDCTX);
    expect(run.caseKind).toBe("deterministic");
    expect(run.variant).toBe("baseline");
    expect(run.seeds).toEqual([1]);
    expect(run.ladder).toBe("metastore");
  });

  test("emitted manifest is a valid metastore paired-3-5-v2 manifest", () => {
    const manifest = buildGdctxManifest([PERFECT_GDCTX, LOSSY_GDCTX, ZERO_GDCTX]);
    const result = validatePairedBenchmark(manifest);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(manifest.ladder).toBe("metastore");
    expect(manifest.runs).toHaveLength(3);
    for (const run of manifest.runs) {
      expect(run.caseKind).toBe("deterministic");
      expect(run.variant).toBe("baseline");
      expect(run.seeds).toEqual([1]);
      expect(run.oracle?.factPreservation?.reliability).toBe("exact");
    }
  });

  test("never averaged with the gdgraph/testing/memory oracles: distinct task-id namespace", () => {
    const gdctxRun = scoreGdctxRun(PERFECT_GDCTX);
    const testRun = scoreTestImpactRun({ changedFile: "src/x.ts", system: ["a"], gold: ["a"] });
    const memRun = scoreMemorySearchRun({ query: "q", system: ["a"], gold: ["a"], k: 1 });
    expect(gdctxRun.task_id.startsWith("metastore:gdctx-fact-preservation:")).toBe(true);
    expect(gdctxRun.task_id).not.toBe(testRun.task_id);
    expect(gdctxRun.task_id).not.toBe(memRun.task_id);
  });

  test("byte-for-byte reproducible", () => {
    const a = buildGdctxManifest([PERFECT_GDCTX, LOSSY_GDCTX, ZERO_GDCTX]);
    const b = buildGdctxManifest([PERFECT_GDCTX, LOSSY_GDCTX, ZERO_GDCTX]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("buildEvidenceBundle", () => {
  test("carries inputs / run / grading per spec §5.1", () => {
    const bundle = buildEvidenceBundle(PARTIAL, {
      repo: "https://github.com/expressjs/express.git",
      commit: "a3714473feb3d2908add734d340e7755fd85e0a3",
      goldReference: "fixtures/benchmark/express/gold-affected-set.json",
      timestamp: "2026-08-12T00:00:00.000Z",
    });
    expect(bundle.inputs.ladder).toBe("metastore");
    expect(bundle.inputs.commit).toBe("a3714473feb3d2908add734d340e7755fd85e0a3");
    expect(bundle.inputs.leakageAssertion).toBe("not-applicable");
    expect(bundle.run.seed).toBe(1);
    expect(bundle.run.startedAt).toBe("2026-08-12T00:00:00.000Z");
    expect(bundle.grading.metrics.f1?.value).toBe(0.5);
    expect(bundle.grading.raw.truePositives).toBe(1);
    expect(bundle.grading.raw.systemAffected).toEqual(["lib/response.js", "lib/spurious.js"]);
  });
});

describe("persistEvidenceBundle + runOracleAndPersist", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keryx-oracle-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes inputs/run/grading under bench/<ladder>/<target>/...", async () => {
    const bundle = buildEvidenceBundle(PERFECT, { timestamp: "2026-01-01T00:00:00.000Z" });
    const written = await persistEvidenceBundle(dir, bundle);
    expect(written).toContain(join("bench", "metastore", "lib/express.js"));
    const grading = JSON.parse(await readFile(join(written, "grading.json"), "utf8"));
    expect(grading.metrics.precision.value).toBe(1);
    const inputs = JSON.parse(await readFile(join(written, "inputs.json"), "utf8"));
    expect(inputs.ladder).toBe("metastore");
    const run = JSON.parse(await readFile(join(written, "run.json"), "utf8"));
    expect(run.seed).toBe(1);
  });

  test("runOracleAndPersist returns a valid manifest and one bundle dir per target", async () => {
    const { manifest, bundleDirs } = await runOracleAndPersist(
      [PERFECT, PARTIAL, ZERO_OVERLAP],
      dir,
      { timestamp: "2026-01-01T00:00:00.000Z" },
    );
    expect(bundleDirs).toHaveLength(3);
    expect(validatePairedBenchmark(manifest).valid).toBe(true);
  });
});
