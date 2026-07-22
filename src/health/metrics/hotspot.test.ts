import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { fileComplexity, hotspotScore, rankHotspots } from "./hotspot";
import { getChurn } from "./churn";
import { analyzeSourceFiles } from "../source-analysis";
import { computeMetrics } from "../scopes";
import { computeGate } from "../gate";
import { healthScore, hotspotPenalty } from "../scoring";
import { DEFAULT_HEALTH_CONFIG } from "../config";
import type { CoverageData } from "./coverage";
import type { BaselineEntry } from "../baseline";
import type { HealthConfig } from "../types";
import expected from "../../../fixtures/churn-complexity/expected.json";
import seededChurn from "../../../fixtures/churn-complexity/churn.json";
import { uniqueTestRoot } from "../../lib/test-tmp";

const FIXTURE_DIR = path.join(import.meta.dir, "..", "..", "..", "fixtures", "churn-complexity");
const FIXTURE_FILES = [
  "src/hot.ts",
  "src/churny-simple.ts",
  "src/complex-stable.ts",
  "src/cold.ts",
];

function churnMap(): Map<string, number> {
  return new Map(Object.entries(seededChurn as Record<string, number>));
}

function emptyCoverage(): CoverageData {
  return { status: "missing", total: null, byFile: new Map() };
}

// --- unit ---------------------------------------------------------------

test("hotspotScore is churn × complexity", () => {
  expect(hotspotScore(100, 6)).toBe(600);
  expect(hotspotScore(0, 6)).toBe(0);
  expect(hotspotScore(100, 0)).toBe(0);
});

test("fileComplexity sums per-function cyclomatic complexity", () => {
  expect(fileComplexity({ file: "a", loc: 1, complexity: [3, 4, 1] })).toBe(8);
  expect(fileComplexity({ file: "a", loc: 1, complexity: [] })).toBe(0);
  expect(fileComplexity(undefined)).toBe(0);
});

test("rankHotspots sorts by score desc then path asc (stable, deterministic)", () => {
  const churn = new Map([
    ["b.ts", 5],
    ["a.ts", 5],
    ["c.ts", 1],
  ]);
  const analysis = new Map([
    ["a.ts", { file: "a.ts", loc: 1, complexity: [2] }],
    ["b.ts", { file: "b.ts", loc: 1, complexity: [2] }],
    ["c.ts", { file: "c.ts", loc: 1, complexity: [2] }],
  ]);
  const ranked = rankHotspots(["c.ts", "b.ts", "a.ts"], churn, analysis);
  // a.ts and b.ts tie on score (10); path asc breaks the tie → a before b.
  expect(ranked.map((h) => h.file)).toEqual(["a.ts", "b.ts", "c.ts"]);
});

// --- AC2: ranking exactness against the committed fixture -----------------

test("AC2: fixture hotspot ranking matches the seeded expected set exactly", async () => {
  const analysis = await analyzeSourceFiles(FIXTURE_DIR, FIXTURE_FILES);
  const ranked = rankHotspots(FIXTURE_FILES, churnMap(), analysis);

  expect(ranked.map((h) => h.file)).toEqual(expected.ranking);
  const files = expected.files as Record<string, { churn: number; complexity: number; score: number }>;
  for (const entry of ranked) {
    const want = files[entry.file];
    expect(want).toBeDefined();
    expect({ churn: entry.churn, complexity: entry.complexity, score: entry.score }).toEqual(want!);
  }
});

// --- AC3: reproducibility -------------------------------------------------

test("AC3: re-ranking the fixture twice is byte-identical", async () => {
  const analysis = await analyzeSourceFiles(FIXTURE_DIR, FIXTURE_FILES);
  const a = rankHotspots(FIXTURE_FILES, churnMap(), analysis);
  const b = rankHotspots(FIXTURE_FILES, churnMap(), analysis);
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

// --- AC5: score/gate invariance at weight 0 ------------------------------

test("AC5: hotspotPenalty is exactly 0 at default weight 0", async () => {
  const analysis = await analyzeSourceFiles(FIXTURE_DIR, FIXTURE_FILES);
  const ranked = rankHotspots(FIXTURE_FILES, churnMap(), analysis);
  // All four files have score > 0, yet the penalty is still 0 at weight 0.
  expect(ranked.every((h) => h.score > 0)).toBe(true);
  expect(hotspotPenalty(ranked, DEFAULT_HEALTH_CONFIG)).toBe(0);
});

test("AC5: healthScore with the hotspot term is identical to the pre-D1 formula at weight 0", () => {
  // Pre-D1 total = risk + coverage + complexity (no hotspot term).
  const preD1 = healthScore({ risk: 40, coverage: 10, complexity: 6, loc: 500 }, DEFAULT_HEALTH_CONFIG);
  const withHotspotZero = healthScore(
    { risk: 40, coverage: 10, complexity: 6, loc: 500, hotspot: 0 },
    DEFAULT_HEALTH_CONFIG,
  );
  expect(withHotspotZero).toBe(preD1);
});

test("AC5: every fixture scope score + gate is identical to pre-D1 at weight 0 (regression == 0)", async () => {
  const config = DEFAULT_HEALTH_CONFIG;
  const baseline = new Map<string, BaselineEntry>();
  const metrics = await computeMetrics({
    cwd: FIXTURE_DIR,
    config,
    findings: [],
    sourceFiles: FIXTURE_FILES,
    coverage: emptyCoverage(),
    churn: churnMap(),
    baseline,
  });

  // Pre-D1 recomputation for each scope: healthScore WITHOUT the hotspot term.
  for (const scope of metrics) {
    const preD1 = healthScore(
      { risk: scope.risk_score, coverage: 0, complexity: 0, loc: scope.loc },
      config,
    );
    // No findings and no above-threshold complexity ⇒ pre-D1 score is 100 and
    // the D1 (weight-0) score must equal it exactly.
    expect(scope.health_score).toBe(preD1);
    expect(scope.regression_score).toBe(0);
  }

  const project = metrics.find((m) => m.key === "project");
  expect(project?.health_score).toBe(100);
  const gate = computeGate({ findings: [], projectMetrics: project, sources: [], config, strict: false });
  expect(gate.status).toBe("pass");
});

// --- AC6: weighted escalation --------------------------------------------

test("AC6: a positive hotspotWeight measurably lowers the score and escalates the gate via regression", async () => {
  const weighted: HealthConfig = {
    ...DEFAULT_HEALTH_CONFIG,
    metrics: { ...DEFAULT_HEALTH_CONFIG.metrics, hotspotThreshold: 0 },
    scoring: { ...DEFAULT_HEALTH_CONFIG.scoring, hotspotWeight: 5 },
  };
  // Baseline captured at the weight-0 (pre-escalation) score of 100.
  const baseline = new Map<string, BaselineEntry>([
    ["project", { health_score: 100, risk_score: 0 }],
  ]);
  const metrics = await computeMetrics({
    cwd: FIXTURE_DIR,
    config: weighted,
    findings: [],
    sourceFiles: FIXTURE_FILES,
    coverage: emptyCoverage(),
    churn: churnMap(),
    baseline,
  });
  const project = metrics.find((m) => m.key === "project");
  // 4 files with score > 0 × weight 5 = 20 penalty; loc < normalizePerLoc so the
  // normalized penalty is the raw 20 ⇒ 100 - 20 = 80.
  expect(project?.health_score).toBe(80);
  expect(project?.regression_score).toBe(20);

  const gate = computeGate({ findings: [], projectMetrics: project, sources: [], config: weighted, strict: false });
  // regression 20 ≥ failOnRegressionDrop (10) ⇒ the existing gate rule fails.
  expect(gate.status).toBe("fail");
});

// --- AC1: the churn seam is real git (no new dependency) -----------------

test("AC1: getChurn drives the hotspot ranking end-to-end on a seeded git history", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-hotspot-churn");
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  const run = (argv: string[]) => Bun.spawn(argv, { cwd: root, stdout: "pipe", stderr: "pipe" }).exited;
  await run(["git", "init", "-q"]);
  await run(["git", "config", "user.email", "t@t.t"]);
  await run(["git", "config", "user.name", "t"]);

  // Seed: churn hot.ts heavily, cold.ts once.
  await writeFile(path.join(root, "src", "cold.ts"), "export const identity = (v: number) => v;\n");
  await writeFile(path.join(root, "src", "hot.ts"), "export function f(x: number) { if (x) { return 1; } return 0; }\n");
  await run(["git", "add", "-A"]);
  await run(["git", "commit", "-qm", "init"]);
  for (let i = 0; i < 5; i += 1) {
    await writeFile(
      path.join(root, "src", "hot.ts"),
      `export function f(x: number) { if (x > ${i}) { return ${i}; } if (x < 0) { return -1; } return 0; }\n`,
    );
    await run(["git", "add", "-A"]);
    await run(["git", "commit", "-qm", `edit ${i}`]);
  }

  const churn = await getChurn(root, 3650);
  const analysis = await analyzeSourceFiles(root, ["src/hot.ts", "src/cold.ts"]);
  const ranked = rankHotspots(["src/hot.ts", "src/cold.ts"], churn, analysis);

  expect(churn.get("src/hot.ts")).toBeGreaterThan(churn.get("src/cold.ts") ?? 0);
  expect(ranked[0]?.file).toBe("src/hot.ts");

  await rm(root, { recursive: true, force: true });
});
