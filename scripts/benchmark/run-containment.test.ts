import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as containmentModule from "./run-containment";
import {
  CONTAINMENT_GOLD_ARTIFACT_PATH,
  finalizeContainmentCase,
  verifyContainmentWorktreeClean,
  type ContainmentEmissionIO,
} from "./run-containment";
import type { PairedBenchmarkManifestV2 } from "../../src/metrics/benchmark";

type ResolveContainmentPort = (port: number | undefined) => number;

function resolver(): ResolveContainmentPort {
  const candidate = (containmentModule as Record<string, unknown>).resolveContainmentPort;
  expect(candidate).toBeFunction();
  return candidate as ResolveContainmentPort;
}

test("containment accepts the concrete port returned by the bound local listener", () => {
  expect(resolver()(43123)).toBe(43123);
});

test("containment refuses an absent listener port instead of choosing an unsafe default", () => {
  expect(() => resolver()(undefined)).toThrow(/containment.*port|bound.*port|listener.*port/i);
});

// RED/GREEN coverage for finalizeContainmentCase (flow 238/T8, same defect shape as
// scripts/benchmark/ablation-emission-gating.test.ts / oracle-emission-gating.test.ts): the
// raw per-case-class fixture used to be written to disk and the derived manifest printed to
// stdout BEFORE validatePairedBenchmark ran. Each of the 3 case classes is scored and
// persisted independently — no live provider calls, no sandboxed shell_exec, no git
// worktrees — only the pure finalize function with injected fake I/O.
describe("finalizeContainmentCase", () => {
  function fakeManifest(): PairedBenchmarkManifestV2 {
    return {
      protocol: "paired-3-5-v2",
      ladder: "harness",
      task_ids: ["harness:containment:example"],
      runs: [],
      speedClaim: { claimed: false },
    };
  }

  function fakeIo(): { io: ContainmentEmissionIO; writes: string[]; prints: string[]; lines: string[] } {
    const writes: string[] = [];
    const prints: string[] = [];
    const lines: string[] = [];
    return {
      io: {
        writeResultsFixture: async (contents) => {
          writes.push(contents);
        },
        printManifest: (contents) => {
          prints.push(contents);
        },
        logLine: (line) => {
          lines.push(line);
        },
      },
      writes,
      prints,
      lines,
    };
  }

  test("an invalid manifest is never written to disk or printed, and the returned code is 1", async () => {
    const { io, writes, prints, lines } = fakeIo();
    const code = await finalizeContainmentCase(
      { note: "fake" },
      fakeManifest(),
      { valid: false, errors: ["fabricated validation error"] },
      "workspace-write-containment",
      "fixtures/benchmark/keryx/safety-containment-workspace-write-containment.json",
      io,
    );

    expect(code).toBe(1);
    expect(writes).toEqual([]);
    expect(prints).toEqual([]);
    expect(lines.some((l) => l.includes("valid: no"))).toBe(true);
    expect(lines.some((l) => l.includes("fabricated validation error"))).toBe(true);
    expect(lines.some((l) => l.includes("left unchanged"))).toBe(true);
  });

  test("a valid manifest is written to disk and printed exactly once, and the returned code is 0", async () => {
    const { io, writes, prints, lines } = fakeIo();
    const code = await finalizeContainmentCase(
      { note: "fake" },
      fakeManifest(),
      { valid: true, errors: [] },
      "shell-permission-restraint",
      "fixtures/benchmark/keryx/safety-containment-shell-permission-restraint.json",
      io,
    );

    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(prints).toHaveLength(1);
    expect(lines.some((l) => l.includes("valid: yes"))).toBe(true);
    expect(lines.some((l) => l.startsWith("wrote fixtures/benchmark/keryx/safety-containment-shell-permission-restraint.json"))).toBe(true);
  });

  test("one case class's invalid manifest never suppresses another's valid emission (independent gating)", async () => {
    const invalid = fakeIo();
    const valid = fakeIo();
    const invalidCode = await finalizeContainmentCase(
      { note: "fake" },
      fakeManifest(),
      { valid: false, errors: ["prompt-injection fabricated error"] },
      "prompt-injection-resistance",
      "fixtures/benchmark/keryx/safety-containment-prompt-injection-resistance.json",
      invalid.io,
    );
    const validCode = await finalizeContainmentCase(
      { note: "fake" },
      fakeManifest(),
      { valid: true, errors: [] },
      "workspace-write-containment",
      "fixtures/benchmark/keryx/safety-containment-workspace-write-containment.json",
      valid.io,
    );

    expect(invalidCode).toBe(1);
    expect(invalid.writes).toEqual([]);
    expect(invalid.prints).toEqual([]);
    expect(validCode).toBe(0);
    expect(valid.writes).toHaveLength(1);
    expect(valid.prints).toHaveLength(1);
  });
});

// T14 (flow 238), AC7 money gate: offline coverage for verifyContainmentWorktreeClean —
// no live model, no sandbox, no real git worktree, just a real temp directory standing in
// for one.
describe("verifyContainmentWorktreeClean (AC7 money gate)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-containment-gate-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a clean worktree (nothing planted) passes without throwing", async () => {
    await expect(verifyContainmentWorktreeClean(root)).resolves.toBeUndefined();
  });

  test("strips this script's own copy when present, and passes", async () => {
    await mkdir(path.join(root, "scripts", "benchmark"), { recursive: true });
    const scriptPath = path.join(root, CONTAINMENT_GOLD_ARTIFACT_PATH);
    await writeFile(scriptPath, "export const X = 1;\n", "utf8");
    await expect(verifyContainmentWorktreeClean(root)).resolves.toBeUndefined();
    expect(existsSync(scriptPath)).toBe(false);
  });

  // Proves the underlying check this gate is built on can genuinely fail (not just "the
  // strip happened to work"): calling the gate against a worktree root that does not exist
  // at all — the strip is a silent no-op (`rm(..., {force:true})`), and
  // checkAnswerReachability then correctly reports the root as `"unverified"`, which the
  // gate treats as a refusal exactly like `"reachable"` — "I could not check" must never
  // read the same as "clean" (src/metrics/preflight.ts's own framing, reused here).
  test("refuses when the worktree root cannot be verified at all (e.g. missing/removed)", async () => {
    const missingRoot = path.join(root, "does-not-exist");
    await expect(verifyContainmentWorktreeClean(missingRoot)).rejects.toThrow(/AC7/);
  });
});
