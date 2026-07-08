// Fixture-corpora acceptance harness (specification.md §6a; arch §6; AC0-19,
// AC0-21). Generalizes the E6 "prove quality against labeled data, not prose"
// idea into a shared, per-block-code-free runner.
//
// `runCorpus(dir, detect)` loads a committed `fixtures/<corpus>/cases.json`,
// runs a block's `DetectorFn` over each labeled case, and computes a
// deterministic `CorpusReport` (false-negative rate + precision + recall). The
// report is order-stable (cases are sorted by id) and re-runnable, so a re-run
// diff is empty (`F-2`). Any block names its corpus directory as its acceptance
// gate; no per-block code lives here.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";

export interface CorpusCase {
  id: string;
  input: string;
  expected: "positive" | "negative";
}

export interface DetectorFn {
  (input: string): Promise<boolean> | boolean;
}

export interface CorpusReport {
  corpus: string;
  total: number;
  truePos: number;
  falseNeg: number;
  falsePos: number;
  trueNeg: number;
  fnRate: number;
  precision: number;
  recall: number;
}

// Parse + normalize the labeled cases from a corpus directory. Accepts either a
// bare array or `{ cases: [...] }`. Malformed entries are dropped. Cases are
// sorted by id so the report is deterministic regardless of file order.
export async function loadCorpusCases(dir: string): Promise<CorpusCase[]> {
  const file = path.join(dir, "cases.json");
  if (!(await pathExists(file))) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
  const rawCases = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { cases?: unknown })?.cases)
      ? (parsed as { cases: unknown[] }).cases
      : [];
  const cases: CorpusCase[] = [];
  for (const raw of rawCases) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.id === "string" &&
      typeof entry.input === "string" &&
      (entry.expected === "positive" || entry.expected === "negative")
    ) {
      cases.push({ id: entry.id, input: entry.input, expected: entry.expected });
    }
  }
  return cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

// Run `detect` over a corpus directory and compute a deterministic report.
export async function runCorpus(dir: string, detect: DetectorFn): Promise<CorpusReport> {
  const cases = await loadCorpusCases(dir);
  let truePos = 0;
  let falseNeg = 0;
  let falsePos = 0;
  let trueNeg = 0;

  for (const testCase of cases) {
    const flagged = Boolean(await detect(testCase.input));
    if (testCase.expected === "positive") {
      if (flagged) {
        truePos += 1;
      } else {
        falseNeg += 1;
      }
    } else if (flagged) {
      falsePos += 1;
    } else {
      trueNeg += 1;
    }
  }

  const positives = truePos + falseNeg;
  return {
    corpus: path.basename(dir),
    total: cases.length,
    truePos,
    falseNeg,
    falsePos,
    trueNeg,
    fnRate: ratio(falseNeg, positives),
    precision: ratio(truePos, truePos + falsePos),
    recall: ratio(truePos, positives),
  };
}
