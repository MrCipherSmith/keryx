import { describe, expect, test } from "bun:test";
import * as containmentModule from "./run-containment";
import { finalizeContainmentCase, type ContainmentEmissionIO } from "./run-containment";
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
