import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  buildCoverageMap,
  coveredFilesInMap,
  loadCoverageMap,
  normalizeCoverageMap,
  parseLcov,
  parseV8Json,
  selectByCoverageMap,
  serializeCoverageMap,
} from "./coverage-map";
import { staticChangedSelection } from "./selection";
import { selectChangedTests, loadTestingConfig } from "./service";
import type { TestingConfig, TestingContext } from "./types";
import expected from "../../fixtures/change-impacted-test/expected.json";
import { uniqueTestRoot } from "../lib/test-tmp";

const FIXTURE_DIR = path.join(import.meta.dir, "..", "..", "fixtures", "change-impacted-test");

function baseConfig(overrides: Partial<TestingConfig["coverageMap"]> = {}): TestingConfig {
  return {
    schemaVersion: 1,
    enabled: true,
    runner: "auto",
    changedSelection: { strategies: ["runner", "gdgraph", "naming"], fallbackWhenEmpty: "warn" },
    coverageMap: {
      enabled: true,
      source: "auto",
      path: "coverage/lcov.info",
      artifact: ".metaproject/data/testing/coverage-map.json",
      lineGranularity: true,
      ...overrides,
    },
    smoke: { selectors: [] },
    hooks: { postCommitRefresh: false, prePushGate: false },
    artifacts: { keepRawLogs: true, historyLimit: 50 },
  };
}

function ctx(testFiles: string[]): TestingContext {
  return {
    schemaVersion: 1,
    generatedAt: "t",
    frameworks: [],
    scripts: [],
    configs: [],
    testFiles,
    ciFiles: [],
    instructionFiles: [],
    conventions: [],
    recommendations: [],
  };
}

function precision(selected: string[], impacted: string[]): number {
  if (selected.length === 0) {
    return 0;
  }
  const truth = new Set(impacted);
  return selected.filter((t) => truth.has(t)).length / selected.length;
}

// --- parsers ---------------------------------------------------------------

test("parseLcov extracts covered files and covered (hit) lines", () => {
  const lcov = ["SF:src/a.ts", "DA:1,1", "DA:2,0", "DA:3,4", "end_of_record", "SF:src/b.ts", "DA:1,0", "end_of_record"].join("\n");
  const covered = parseLcov(lcov);
  expect(covered.get("src/a.ts")).toEqual([1, 3]);
  expect(covered.has("src/b.ts")).toBe(false); // no covered line ⇒ dropped
});

test("parseV8Json extracts covered lines from istanbul/bun-style JSON", () => {
  const covered = parseV8Json({ "src/a.ts": { lines: { "1": 2, "2": 0, "5": 1 } }, result: [] });
  expect(covered.get("src/a.ts")).toEqual([1, 5]);
});

// --- AC7: deterministic normalization + re-serialize identical -------------

test("AC7: normalizeCoverageMap sorts keys/arrays and is a re-serialize fixed point", () => {
  const map = normalizeCoverageMap(
    {
      "z.test.ts": { coveredFiles: ["src/b.ts", "src/a.ts", "src/a.ts"] },
      "a.test.ts": { coveredFiles: ["src/c.ts"], coveredLines: { "src/c.ts": [5, 1, 5] } },
    },
    null,
    "t",
  );
  expect(Object.keys(map.map)).toEqual(["a.test.ts", "z.test.ts"]);
  expect(map.map["z.test.ts"]?.coveredFiles).toEqual(["src/a.ts", "src/b.ts"]);
  expect(map.map["a.test.ts"]?.coveredLines?.["src/c.ts"]).toEqual([1, 5]);
  // Re-serializing the normalized map yields an identical string.
  expect(serializeCoverageMap(map)).toBe(serializeCoverageMap(map));
});

// --- AC8: coverage-map selection precision > static ------------------------

test("AC8: coverage-map selects the true impacted tests with higher precision than static", async () => {
  const map = await loadCoverageMap(FIXTURE_DIR, baseConfig({ artifact: "coverage-map.json" }));
  expect(map).not.toBeNull();

  const change = expected.change;
  const impacted = expected.impacted;
  const coverageSelected = selectByCoverageMap(change, map!).selectedTests;
  const staticSelected = Array.from(staticChangedSelection(change, expected.testFiles)).sort();

  expect(coverageSelected).toEqual(expected.coverageSelection);
  expect(staticSelected).toEqual(expected.staticSelection);

  const coverageP = precision(coverageSelected, impacted);
  const staticP = precision(staticSelected, impacted);
  expect(coverageP).toBe(expected.coveragePrecision);
  expect(staticP).toBe(expected.staticPrecision);
  expect(coverageP).toBeGreaterThan(staticP);
});

test("AC9: a changed file absent from the map falls back to the naming heuristic (unioned)", async () => {
  const map = await loadCoverageMap(FIXTURE_DIR, baseConfig({ artifact: "coverage-map.json" }));
  const inMap = coveredFilesInMap(map!);
  expect(inMap.has("src/gamma.ts")).toBe(false);
  // gamma.ts is absent ⇒ naming heuristic selects gamma.test.ts.
  const naming = Array.from(staticChangedSelection(expected.mapAbsentChange, expected.testFiles)).sort();
  expect(naming).toEqual(expected.mapAbsentSelection);
});

// --- AC8/AC11: end-to-end selectChangedTests availability pair -------------

async function seedRepo(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await cp(path.join(FIXTURE_DIR, "src"), path.join(root, "src"), { recursive: true });
  const run = (argv: string[]) => Bun.spawn(argv, { cwd: root, stdout: "pipe", stderr: "pipe" }).exited;
  await run(["git", "init", "-q"]);
  await run(["git", "config", "user.email", "t@t.t"]);
  await run(["git", "config", "user.name", "t"]);
  await run(["git", "add", "-A"]);
  await run(["git", "commit", "-qm", "baseline"]);
}

async function enableCapability(root: string): Promise<void> {
  await mkdir(path.join(root, ".metaproject", "data", "testing"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({ modules: { testing: { enabled: true, capabilities: ["coverageMap"] } } }, null, 2),
  );
  await cp(
    path.join(FIXTURE_DIR, "coverage-map.json"),
    path.join(root, ".metaproject", "data", "testing", "coverage-map.json"),
  );
}

const TEST_FILES = ["src/alpha.extra.test.ts", "src/alpha.test.ts", "src/beta.test.ts", "src/gamma.test.ts"];

test("AC8: with capability ON + map present, selectChangedTests uses the coverage map", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-tia-on");
  await seedRepo(root);
  await enableCapability(root);
  // Change alpha.ts.
  await writeFile(path.join(root, "src", "alpha.ts"), "export function alpha(n: number): number {\n  return n + 100;\n}\n");

  const result = await selectChangedTests(root, ctx(TEST_FILES), "HEAD", baseConfig());
  expect(result.changedFiles).toContain("src/alpha.ts");
  expect(result.strategies).toEqual(["runner", "gdgraph", "naming", "coverage-map"]);
  expect(result.selectedTests).toEqual(["src/alpha.test.ts"]);

  await rm(root, { recursive: true, force: true });
});

test("AC11: with capability OFF (no manifest), selectChangedTests is byte-identical static selection", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-tia-off");
  await seedRepo(root);
  // No manifest ⇒ capability off. Change alpha.ts.
  await writeFile(path.join(root, "src", "alpha.ts"), "export function alpha(n: number): number {\n  return n + 100;\n}\n");

  const result = await selectChangedTests(root, ctx(TEST_FILES), "HEAD", baseConfig());
  // Static path: naming over-selects alpha.extra.test.ts; strategies stay base.
  expect(result.strategies).toEqual(["runner", "gdgraph", "naming"]);
  const expectedStatic = Array.from(staticChangedSelection(result.changedFiles, TEST_FILES)).sort();
  expect(result.selectedTests).toEqual(expectedStatic);
  expect(result.selectedTests).toContain("src/alpha.extra.test.ts");

  await rm(root, { recursive: true, force: true });
});

test("AC9: capability ON, a map-absent changed file unions in its naming-related test", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-tia-absent");
  await seedRepo(root);
  await enableCapability(root);
  await writeFile(path.join(root, "src", "alpha.ts"), "export function alpha(n: number): number {\n  return n + 100;\n}\n");
  // New source file absent from the map.
  await writeFile(path.join(root, "src", "gamma.ts"), "export const gamma = 1;\n");

  const result = await selectChangedTests(root, ctx(TEST_FILES), "HEAD", baseConfig());
  expect(result.selectedTests).toContain("src/alpha.test.ts"); // map
  expect(result.selectedTests).toContain("src/gamma.test.ts"); // naming fallback
  expect(result.selectedTests).not.toContain("src/alpha.extra.test.ts"); // excluded by map

  await rm(root, { recursive: true, force: true });
});

// --- AC7 build determinism + AC10 malformed config → defaults --------------

test("AC7: buildCoverageMap (import) writes a deterministic map; re-build is identical", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-tia-build");
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, "coverage"), { recursive: true });
  await writeFile(
    path.join(root, "coverage", "lcov.info"),
    ["SF:src/a.ts", "DA:1,1", "DA:2,1", "end_of_record"].join("\n"),
  );
  const cfg = baseConfig({ source: "import", path: "coverage/lcov.info" });
  const first = await buildCoverageMap(root, cfg, { testFiles: [] });
  const second = await buildCoverageMap(root, cfg, { testFiles: [] });
  // The deterministic content (the `map` body) is byte-identical across builds;
  // only the `generatedAt` metadata reflects build time.
  expect(JSON.stringify(second.map.map)).toBe(JSON.stringify(first.map.map));
  expect(coveredFilesInMap(first.map).has("src/a.ts")).toBe(true);
  await rm(root, { recursive: true, force: true });
});

test("AC10: malformed testing.config.json falls back to defaults (coverageMap off)", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-tia-malformed");
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "testing.config.json"), "{ not json");
  const cfg = await loadTestingConfig(root);
  expect(cfg.coverageMap.enabled).toBe(false);
  expect(cfg.smoke.selectors).toEqual([]);
  await rm(root, { recursive: true, force: true });
});
