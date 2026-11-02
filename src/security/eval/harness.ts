// Red-team eval harness (Block E, E6). Runs each labeled corpus through the
// security detectors and computes a per-detector false-negative rate, then gates
// on committed ceilings (`fixtures/thresholds.json`). The report is deterministic
// and git-diffable (no timestamps, stable ordering) so a re-run diff is empty
// and a detection regression shows up as a reviewable change (F-2, F-4).
//
// It reuses the shipped `DetectorMatch[]` contract: a case "fires" for a detector
// when some match carries a matching `policyId` OR `category`. Backends are opt-in
// via an injected `detect` function; the default is the pure deterministic path.

import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathExists } from "../../lib/fs";
import { loadSecurityConfig } from "../config";
import { runDetectors } from "../detect";
import type { DetectorMatch } from "../types";

export interface EvalCase {
  id: string;
  input: string;
  expected: "positive" | "negative";
  detector: string;
}

export interface DetectorEval {
  detector: string;
  positives: number;
  negatives: number;
  truePos: number;
  falseNeg: number;
  falsePos: number;
  trueNeg: number;
  fnRate: number;
}

export interface EvalReport {
  corpora: string[];
  totalCases: number;
  detectors: DetectorEval[];
  /** Requested corpora that could not be evaluated; each one fails the gate. */
  invalidCorpora: Array<{ corpus: string; reason: string }>;
}

export interface DetectFn {
  (input: string): Promise<DetectorMatch[]> | DetectorMatch[];
}

export interface ThresholdEntry {
  maxFnRate: number;
}
export type Thresholds = Record<string, ThresholdEntry>;

export interface GateResult {
  status: "pass" | "fail";
  reasons: string[];
}

export const DEFAULT_CORPORA = ["injection", "exfil", "structured-pii", "secret"];

// A corpus that cannot be evaluated. It is a gate failure, never an empty
// corpus: a cases.json broken by a conflict marker or a renamed directory used to
// load as [] and drop its detectors out of the gate (review-backend-slice-35:F-002).
export class EvalCorpusError extends Error {}

// Load the labeled cases for a corpus directory. Accepts `{ cases: [...] }` or a
// bare array; cases are sorted by id for a deterministic report regardless of
// file order. Throws `EvalCorpusError` when the file is missing, does not parse,
// has neither shape, holds no cases or holds a malformed entry.
export async function loadEvalCases(dir: string): Promise<EvalCase[]> {
  const file = path.join(dir, "cases.json");
  if (!(await pathExists(file))) {
    throw new EvalCorpusError("cases.json is missing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new EvalCorpusError("cases.json is not valid JSON");
  }
  const raw: unknown = Array.isArray(parsed) ? parsed : (parsed as { cases?: unknown } | null)?.cases;
  if (!Array.isArray(raw)) {
    throw new EvalCorpusError("cases.json is neither a cases array nor { cases: [...] }");
  }
  if (raw.length === 0) {
    throw new EvalCorpusError("cases.json has no cases");
  }
  const cases: EvalCase[] = [];
  for (const [index, entry] of raw.entries()) {
    const e = (entry !== null && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    if (
      typeof e.id !== "string" ||
      typeof e.input !== "string" ||
      typeof e.detector !== "string" ||
      (e.expected !== "positive" && e.expected !== "negative")
    ) {
      throw new EvalCorpusError(
        `cases.json entry ${index} is malformed (needs string id/input/detector and expected positive|negative)`,
      );
    }
    cases.push({
      id: e.id,
      input: e.input,
      detector: e.detector,
      expected: e.expected,
    });
  }
  return cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// True when `matches` contains a finding attributable to `detector` (by exact
// policyId or by category — so a corpus may label at either granularity).
export function firedFor(detector: string, matches: DetectorMatch[]): boolean {
  return matches.some((m) => m.policyId === detector || m.category === detector);
}

function ratio(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

// The default pure detector: the shipped deterministic pipeline with the
// workspace config (all opt-in backends off unless the caller wires them in).
export async function pureDetect(cwd: string): Promise<DetectFn> {
  const config = await loadSecurityConfig(cwd);
  return (input: string) => runDetectors(input, config);
}

// Run the selected corpora through `detect` and aggregate a per-detector report.
export async function runEval(opts: {
  fixturesRoot: string;
  corpora: string[];
  detect: DetectFn;
}): Promise<EvalReport> {
  const acc = new Map<
    string,
    { truePos: number; falseNeg: number; falsePos: number; trueNeg: number }
  >();
  const corporaSeen: string[] = [];
  const invalidCorpora: EvalReport["invalidCorpora"] = [];
  let totalCases = 0;

  for (const corpus of opts.corpora) {
    const dir = path.join(opts.fixturesRoot, corpus);
    let cases: EvalCase[];
    try {
      cases = await loadEvalCases(dir);
    } catch (error) {
      if (!(error instanceof EvalCorpusError)) throw error;
      invalidCorpora.push({ corpus, reason: error.message });
      continue;
    }
    corporaSeen.push(corpus);
    for (const testCase of cases) {
      totalCases += 1;
      const matches = await opts.detect(testCase.input);
      const fired = firedFor(testCase.detector, matches);
      const bucket =
        acc.get(testCase.detector) ??
        { truePos: 0, falseNeg: 0, falsePos: 0, trueNeg: 0 };
      if (testCase.expected === "positive") {
        if (fired) bucket.truePos += 1;
        else bucket.falseNeg += 1;
      } else if (fired) {
        bucket.falsePos += 1;
      } else {
        bucket.trueNeg += 1;
      }
      acc.set(testCase.detector, bucket);
    }
  }

  const detectors: DetectorEval[] = [...acc.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([detector, b]) => {
      const positives = b.truePos + b.falseNeg;
      return {
        detector,
        positives,
        negatives: b.trueNeg + b.falsePos,
        truePos: b.truePos,
        falseNeg: b.falseNeg,
        falsePos: b.falsePos,
        trueNeg: b.trueNeg,
        fnRate: ratio(b.falseNeg, positives),
      };
    });

  invalidCorpora.sort((a, b) => (a.corpus < b.corpus ? -1 : a.corpus > b.corpus ? 1 : 0));
  return { corpora: corporaSeen.sort(), totalCases, detectors, invalidCorpora };
}

// Load the committed threshold table.
export async function loadThresholds(file: string): Promise<Thresholds> {
  if (!(await pathExists(file))) {
    return {};
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      thresholds?: Thresholds;
    } & Thresholds;
    const table = parsed.thresholds ?? parsed;
    const out: Thresholds = {};
    for (const [k, v] of Object.entries(table)) {
      if (v && typeof v === "object" && typeof (v as ThresholdEntry).maxFnRate === "number") {
        out[k] = { maxFnRate: (v as ThresholdEntry).maxFnRate };
      }
    }
    return out;
  } catch {
    return {};
  }
}

// Gate the report against thresholds. A detector with no committed threshold
// defaults to 0 (any false negative fails), so an unlisted detector cannot
// silently regress — and a requested corpus that could not be evaluated fails,
// so its detectors cannot leave the gate by disappearing from the report.
export function gateEval(report: EvalReport, thresholds: Thresholds): GateResult {
  const reasons: string[] = report.invalidCorpora.map(
    ({ corpus, reason }) => `corpus "${corpus}": not evaluated, ${reason}`,
  );
  for (const d of report.detectors) {
    const max = thresholds[d.detector]?.maxFnRate ?? 0;
    if (d.fnRate > max + 1e-9) {
      reasons.push(
        `detector "${d.detector}": fnRate ${d.fnRate.toFixed(4)} exceeds ceiling ${max.toFixed(4)} ` +
          `(${d.falseNeg} FN of ${d.positives} positive(s))`,
      );
    }
  }
  return { status: reasons.length > 0 ? "fail" : "pass", reasons };
}

// Deterministic, git-diffable plaintext report. No timestamps or absolute paths.
export function formatEvalReport(report: EvalReport, thresholds: Thresholds = {}): string {
  const lines: string[] = [];
  lines.push("security eval — false-negative rate by detector");
  lines.push(`corpora: ${report.corpora.join(", ") || "(none)"}`);
  lines.push(`cases: ${report.totalCases}`);
  for (const { corpus, reason } of report.invalidCorpora) {
    lines.push(`not evaluated: ${corpus} (${reason})`);
  }
  lines.push("");
  lines.push("detector                     pos   TP   FN   FP   fnRate  ceiling  status");
  for (const d of report.detectors) {
    const max = thresholds[d.detector]?.maxFnRate ?? 0;
    const status = d.fnRate > max + 1e-9 ? "FAIL" : "ok";
    lines.push(
      [
        d.detector.padEnd(28),
        String(d.positives).padStart(3),
        String(d.truePos).padStart(4),
        String(d.falseNeg).padStart(4),
        String(d.falsePos).padStart(4),
        d.fnRate.toFixed(4).padStart(8),
        max.toFixed(4).padStart(8),
        `  ${status}`,
      ].join(" "),
    );
  }
  return `${lines.join("\n")}\n`;
}
