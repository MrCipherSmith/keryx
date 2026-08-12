import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { validatePairedBenchmark } from "./benchmark";
import {
  buildEvidenceBundle,
  buildOracleManifest,
  oracleTaskId,
  persistEvidenceBundle,
  runOracleAndPersist,
  scoreOracleTarget,
  type OracleScoreInput,
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
