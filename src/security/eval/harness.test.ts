import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import {
  DEFAULT_CORPORA,
  formatEvalReport,
  gateEval,
  loadThresholds,
  runEval,
  type DetectFn,
} from "./harness";
import { runDetectors } from "../detect";
import { DEFAULT_SECURITY_CONFIG } from "../config";
import type { DetectorMatch } from "../types";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
);

const pure: DetectFn = (input) => runDetectors(input, DEFAULT_SECURITY_CONFIG);

// AC6.1 — the report is deterministic and git-diffable (re-run diff is empty).
test("AC6.1: eval report is deterministic across runs", async () => {
  const thresholds = await loadThresholds(path.join(FIXTURES, "thresholds.json"));
  const a = await runEval({ fixturesRoot: FIXTURES, corpora: DEFAULT_CORPORA, detect: pure });
  const b = await runEval({ fixturesRoot: FIXTURES, corpora: DEFAULT_CORPORA, detect: pure });
  expect(formatEvalReport(a, thresholds)).toBe(formatEvalReport(b, thresholds));
  // Per-detector FN rate is present for every corpus family.
  const ids = a.detectors.map((d) => d.detector);
  expect(ids).toContain("secret");
  expect(ids).toContain("egress");
  expect(ids).toContain("prompt-injection");
});

// AC6.2 — passes within thresholds; a seeded regression (dropping a detector
// rule) demonstrably flips the gate to fail.
test("AC6.2: gate passes within thresholds and fails on a seeded regression", async () => {
  const thresholds = await loadThresholds(path.join(FIXTURES, "thresholds.json"));

  const baseline = await runEval({
    fixturesRoot: FIXTURES,
    corpora: DEFAULT_CORPORA,
    detect: pure,
  });
  expect(gateEval(baseline, thresholds).status).toBe("pass");

  // Seeded regression: a detector that has "lost" its secret rules. Every secret
  // positive now becomes a false negative ⇒ secret fnRate 1.0 > ceiling 0.
  const regressed: DetectFn = (input) =>
    runDetectors(input, DEFAULT_SECURITY_CONFIG).filter(
      (m: DetectorMatch) => m.category !== "secret",
    );
  const report = await runEval({
    fixturesRoot: FIXTURES,
    corpora: DEFAULT_CORPORA,
    detect: regressed,
  });
  const gate = gateEval(report, thresholds);
  expect(gate.status).toBe("fail");
  expect(gate.reasons.some((r) => r.includes("secret"))).toBe(true);
});

// AC6.3 — pure by default; a (stubbed) model backend lowers the injection FN
// rate below the regex-only baseline.
test("AC6.3: model-augmented run improves injection recall over the pure baseline", async () => {
  const pureReport = await runEval({
    fixturesRoot: FIXTURES,
    corpora: ["injection"],
    detect: pure,
  });
  const pureInj = pureReport.detectors.find((d) => d.detector === "prompt-injection")!;
  expect(pureInj.falseNeg).toBeGreaterThan(0); // regex misses the paraphrases

  // A stubbed "model": recovers any injection the regex missed (deterministic).
  const withModel: DetectFn = (input) => {
    const deterministic = runDetectors(input, DEFAULT_SECURITY_CONFIG);
    if (deterministic.some((m) => m.category === "prompt-injection")) {
      return deterministic;
    }
    // Seeded classifier: paraphrases mention directives/config/memory.
    if (/directive|configuration|memory|comply/i.test(input)) {
      return [
        ...deterministic,
        {
          category: "prompt-injection",
          policyId: "prompt-injection.model",
          severity: "low",
          confidence: 0.9,
          start: 0,
          end: 0,
          value: "",
        } as DetectorMatch,
      ];
    }
    return deterministic;
  };
  const modelReport = await runEval({
    fixturesRoot: FIXTURES,
    corpora: ["injection"],
    detect: withModel,
  });
  const modelInj = modelReport.detectors.find((d) => d.detector === "prompt-injection")!;
  expect(modelInj.fnRate).toBeLessThan(pureInj.fnRate);
});
