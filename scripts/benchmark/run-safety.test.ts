// RED/GREEN coverage for finalizeSafetyRun (flow 238/T8, same defect shape as
// scripts/benchmark/ablation-emission-gating.test.ts / oracle-emission-gating.test.ts):
// both raw case fixtures (completion-honesty, false-premise) used to be written to disk and
// both derived manifests printed to stdout BEFORE validatePairedBenchmark ran. The two case
// groups are independent (never averaged — see run-safety.ts's module comment), so each is
// gated on ITS OWN validity, not on the other's. No live provider calls, no network, no git
// worktrees — only the pure finalize function with injected fake I/O.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PairedBenchmarkManifestV2 } from "../../src/metrics/benchmark";
import {
  finalizeSafetyRun,
  SAFETY_ANSWER_NEEDLES,
  SAFETY_GOLD_ARTIFACT_PATH,
  verifyFalsePremiseWorktreeClean,
  type SafetyEmissionIO,
} from "./run-safety";

function fakeManifest(taskId: string): PairedBenchmarkManifestV2 {
  return {
    protocol: "paired-3-5-v2",
    ladder: "harness",
    task_ids: [taskId],
    runs: [],
    speedClaim: { claimed: false },
  };
}

function fakeIo(): {
  io: SafetyEmissionIO;
  honestyWrites: string[];
  premiseWrites: string[];
  honestyPrints: string[];
  premisePrints: string[];
  lines: string[];
} {
  const honestyWrites: string[] = [];
  const premiseWrites: string[] = [];
  const honestyPrints: string[] = [];
  const premisePrints: string[] = [];
  const lines: string[] = [];
  return {
    io: {
      writeHonestyFixture: async (contents) => {
        honestyWrites.push(contents);
      },
      writePremiseFixture: async (contents) => {
        premiseWrites.push(contents);
      },
      printHonestyManifest: (contents) => {
        honestyPrints.push(contents);
      },
      printPremiseManifest: (contents) => {
        premisePrints.push(contents);
      },
      logLine: (line) => {
        lines.push(line);
      },
    },
    honestyWrites,
    premiseWrites,
    honestyPrints,
    premisePrints,
    lines,
  };
}

describe("finalizeSafetyRun", () => {
  test("both groups invalid: nothing written, nothing printed, exit code 1", async () => {
    const { io, honestyWrites, premiseWrites, honestyPrints, premisePrints, lines } = fakeIo();
    const code = await finalizeSafetyRun(
      { note: "honesty" },
      fakeManifest("honesty"),
      { valid: false, errors: ["honesty fabricated error"] },
      { note: "premise" },
      fakeManifest("premise"),
      { valid: false, errors: ["premise fabricated error"] },
      io,
    );

    expect(code).toBe(1);
    expect(honestyWrites).toEqual([]);
    expect(premiseWrites).toEqual([]);
    expect(honestyPrints).toEqual([]);
    expect(premisePrints).toEqual([]);
    expect(lines.some((l) => l.includes("honesty fabricated error"))).toBe(true);
    expect(lines.some((l) => l.includes("premise fabricated error"))).toBe(true);
  });

  test("both groups valid: both fixtures written and both manifests printed exactly once, exit code 0", async () => {
    const { io, honestyWrites, premiseWrites, honestyPrints, premisePrints, lines } = fakeIo();
    const code = await finalizeSafetyRun(
      { note: "honesty" },
      fakeManifest("honesty"),
      { valid: true, errors: [] },
      { note: "premise" },
      fakeManifest("premise"),
      { valid: true, errors: [] },
      io,
    );

    expect(code).toBe(0);
    expect(honestyWrites).toHaveLength(1);
    expect(premiseWrites).toHaveLength(1);
    expect(honestyPrints).toHaveLength(1);
    expect(premisePrints).toHaveLength(1);
    expect(lines.some((l) => l.includes("wrote fixtures/benchmark/keryx/safety-completion-honesty"))).toBe(true);
    expect(lines.some((l) => l.includes("wrote fixtures/benchmark/keryx/safety-false-premise"))).toBe(true);
  });

  test("honesty invalid, premise valid: honesty is suppressed, premise still emits independently, exit code 1", async () => {
    const { io, honestyWrites, premiseWrites, honestyPrints, premisePrints, lines } = fakeIo();
    const code = await finalizeSafetyRun(
      { note: "honesty" },
      fakeManifest("honesty"),
      { valid: false, errors: ["honesty fabricated error"] },
      { note: "premise" },
      fakeManifest("premise"),
      { valid: true, errors: [] },
      io,
    );

    expect(code).toBe(1);
    expect(honestyWrites).toEqual([]);
    expect(honestyPrints).toEqual([]);
    // The false-premise group is independently valid and is NOT held hostage by the
    // unrelated completion-honesty group's invalidity.
    expect(premiseWrites).toHaveLength(1);
    expect(premisePrints).toHaveLength(1);
    expect(lines.some((l) => l.includes("honesty fabricated error"))).toBe(true);
  });
});

// T14 (flow 238), AC7 money gate: offline coverage for verifyFalsePremiseWorktreeClean —
// no live model, no git worktree, just a real temp directory standing in for one. Proves
// the gate can actually FAIL, not only pass: a plain path-existence check on
// SAFETY_GOLD_ARTIFACT_PATH alone would miss a leaked COPY of the ground truth sitting
// elsewhere in the tree (exactly what fixtures/benchmark/keryx/safety-false-premise*.json
// turned out to carry — the fix in run-safety.ts strips those too, not only the script).
describe("verifyFalsePremiseWorktreeClean (AC7 money gate)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-safety-gate-"));
    // checkAnswerReachability's content scan reports "unverified" (a refusal) when it
    // matches zero readable files under agentRoot — an accurate signal for a genuinely
    // empty/unreadable root, but a bare mkdtemp() has nothing in it at all. Seed one
    // innocuous file so the scan has something real to examine, the same way a real git
    // worktree checkout (thousands of files) always does.
    await writeFile(path.join(root, "README.md"), "placeholder file so the reachability scan has something to examine\n", "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a clean worktree (nothing planted) passes without throwing", async () => {
    await expect(verifyFalsePremiseWorktreeClean(root)).resolves.toBeUndefined();
  });

  test("strips this script's own gold-bearing copy when present, and passes", async () => {
    await mkdir(path.join(root, "scripts", "benchmark"), { recursive: true });
    const scriptPath = path.join(root, SAFETY_GOLD_ARTIFACT_PATH);
    await writeFile(scriptPath, "export const X = 1;\n", "utf8");
    await expect(verifyFalsePremiseWorktreeClean(root)).resolves.toBeUndefined();
    expect(existsSync(scriptPath)).toBe(false);
  });

  // The refusal path: a decoy file at a DIFFERENT path than SAFETY_GOLD_ARTIFACT_PATH still
  // carries the exact ground-truth text. Stripping the canonical path alone (a bare
  // checkGoldLeakage-style path check) would miss this — only the content scan
  // (answerNeedles) catches it, which is exactly why the gate uses checkAnswerReachability,
  // not just a path-existence check.
  test("refuses when the ground truth is reachable from a DIFFERENT file (content scan, not just a path check)", async () => {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "leaked-notes.md"), `Notes: ${SAFETY_ANSWER_NEEDLES[0]}\n`, "utf8");
    await expect(verifyFalsePremiseWorktreeClean(root)).rejects.toThrow(/AC7/);
  });

  // The real vulnerability this fix found while wiring the gate: the checked-in RESULT
  // fixtures this same script writes embed the ground truth verbatim (see the module
  // comment above stripSafetyFalsePremiseFixtures in run-safety.ts) — a full checkout
  // carries every already-committed provider's fixture, not just this run's own.
  test("strips every safety-false-premise*.json result fixture, not only the canonical one for this provider", async () => {
    const fixturesDir = path.join(root, "fixtures", "benchmark", "keryx");
    await mkdir(fixturesDir, { recursive: true });
    const decoyFixture = path.join(fixturesDir, "safety-false-premise-some-other-provider.json");
    await writeFile(
      decoyFixture,
      JSON.stringify({ cases: [{ rationale: `premise is false because: ${SAFETY_ANSWER_NEEDLES[0]}` }] }),
      "utf8",
    );
    await expect(verifyFalsePremiseWorktreeClean(root)).resolves.toBeUndefined();
    expect(existsSync(decoyFixture)).toBe(false);
  });

  test("an unrelated fixture file (different name) is left alone", async () => {
    const fixturesDir = path.join(root, "fixtures", "benchmark", "keryx");
    await mkdir(fixturesDir, { recursive: true });
    const unrelated = path.join(fixturesDir, "ablation-results.json");
    await writeFile(unrelated, JSON.stringify({ note: "unrelated" }), "utf8");
    await expect(verifyFalsePremiseWorktreeClean(root)).resolves.toBeUndefined();
    expect(existsSync(unrelated)).toBe(true);
  });
});
