import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { runCorpus, type DetectorFn } from "./corpus";
import { gateCorpus } from "./gate";

// Repo-root fixtures/ directory (two committed seed corpora).
const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
);

const secretDetector: DetectorFn = (input) =>
  /AKIA[0-9A-Z]{16}|ghp_[0-9A-Za-z]{36}|password\s*=\s*['"][^'"]+['"]/.test(input);

const emailDetector: DetectorFn = (input) =>
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(input);

test("runCorpus produces a perfect report for the seed-secrets corpus", async () => {
  const report = await runCorpus(path.join(FIXTURES, "seed-secrets"), secretDetector);
  expect(report.total).toBe(6);
  expect(report.truePos).toBe(3);
  expect(report.trueNeg).toBe(3);
  expect(report.falseNeg).toBe(0);
  expect(report.fnRate).toBe(0);
  expect(report.precision).toBe(1);
  expect(report.recall).toBe(1);
});

test("the same runner handles a second corpus with no per-corpus code", async () => {
  const report = await runCorpus(path.join(FIXTURES, "seed-emails"), emailDetector);
  expect(report.corpus).toBe("seed-emails");
  expect(report.total).toBe(6);
  expect(report.falseNeg).toBe(0);
});

test("report is deterministic — a re-run diff is empty", async () => {
  const first = await runCorpus(path.join(FIXTURES, "seed-secrets"), secretDetector);
  const second = await runCorpus(path.join(FIXTURES, "seed-secrets"), secretDetector);
  expect(JSON.stringify(first)).toBe(JSON.stringify(second));
});

test("fnRate reflects a lossy detector (false negatives raise the rate)", async () => {
  // A detector that only catches the AWS-key pattern misses 2 of 3 positives.
  const lossy: DetectorFn = (input) => /AKIA[0-9A-Z]{16}/.test(input);
  const report = await runCorpus(path.join(FIXTURES, "seed-secrets"), lossy);
  expect(report.falseNeg).toBe(2);
  expect(report.fnRate).toBeCloseTo(2 / 3, 10);
});

test("gateCorpus passes below threshold and fails above it", async () => {
  const good = await runCorpus(path.join(FIXTURES, "seed-secrets"), secretDetector);
  expect((await gateCorpus(good, { maxFnRate: 0.1 })).status).toBe("pass");

  const lossy: DetectorFn = (input) => /AKIA[0-9A-Z]{16}/.test(input);
  const bad = await runCorpus(path.join(FIXTURES, "seed-secrets"), lossy);
  const gate = await gateCorpus(bad, { maxFnRate: 0.1 });
  expect(gate.status).toBe("fail");
  expect(gate.reasons.length).toBeGreaterThan(0);
});
