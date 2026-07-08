import path from "node:path";
import { expect, test } from "bun:test";
import { runCorpus } from "./corpus";
import { gateCorpus } from "./gate";
import { analyzeSourceFiles } from "../health/source-analysis";
import { rankHotspots } from "../health/metrics/hotspot";
import { loadCoverageMap, selectByCoverageMap } from "../testing/coverage-map";
import type { TestingConfig } from "../testing/types";
import churn from "../../fixtures/churn-complexity/churn.json";

// Block D · AC17 (F-1): both fixture corpora plug into the Block 0 fixture-corpora
// acceptance harness (runCorpus/gateCorpus) and are the named Block-D acceptance
// gate — capability metrics measured against labeled data, not asserted in prose.

const HOTSPOT_DIR = path.join(import.meta.dir, "..", "..", "fixtures", "churn-complexity");
const TIA_DIR = path.join(import.meta.dir, "..", "..", "fixtures", "change-impacted-test");

test("AC17: churn-complexity corpus — hotspot detector has 0 false negatives + perfect precision", async () => {
  const files = ["src/hot.ts", "src/churny-simple.ts", "src/complex-stable.ts", "src/cold.ts"];
  const analysis = await analyzeSourceFiles(HOTSPOT_DIR, files);
  const ranked = rankHotspots(files, new Map(Object.entries(churn as Record<string, number>)), analysis);
  const scoreByFile = new Map(ranked.map((h) => [h.file, h.score]));

  const report = await runCorpus(HOTSPOT_DIR, (input) => (scoreByFile.get(input) ?? 0) > 100);
  expect(report.total).toBe(4);
  expect(report.fnRate).toBe(0);
  expect(report.precision).toBe(1);
  expect(report.recall).toBe(1);
  expect((await gateCorpus(report, { maxFnRate: 0 })).status).toBe("pass");
});

test("AC17: change-impacted-test corpus — coverage-map TIA detector has 0 false negatives + perfect precision", async () => {
  const cfg = { coverageMap: { artifact: "coverage-map.json" } } as unknown as TestingConfig;
  const map = await loadCoverageMap(TIA_DIR, cfg);
  expect(map).not.toBeNull();
  const selected = new Set(selectByCoverageMap(["src/alpha.ts"], map!).selectedTests);

  const report = await runCorpus(TIA_DIR, (input) => selected.has(input));
  expect(report.total).toBe(4);
  expect(report.fnRate).toBe(0);
  expect(report.precision).toBe(1);
  expect(report.recall).toBe(1);
  expect((await gateCorpus(report, { maxFnRate: 0 })).status).toBe("pass");
});
