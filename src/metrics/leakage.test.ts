import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkGoldLeakage } from "./leakage";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-leakage-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("checkGoldLeakage", () => {
  test("fails when the gold artifact is reachable under the agent root (AC-5)", async () => {
    await mkdir(path.join(root, "scripts", "benchmark"), { recursive: true });
    await writeFile(path.join(root, "scripts", "benchmark", "ablation-tasks.ts"), "export const X = 1;\n", "utf8");

    const result = checkGoldLeakage(root, ["scripts/benchmark/ablation-tasks.ts"]);
    expect(result.assertion).toBe("failed");
    expect(result.reachablePaths).toEqual(["scripts/benchmark/ablation-tasks.ts"]);
  });

  test("passes when none of the gold artifacts are reachable (post-strip)", () => {
    const result = checkGoldLeakage(root, ["scripts/benchmark/ablation-tasks.ts", "scripts/benchmark/mutating-tasks.ts"]);
    expect(result.assertion).toBe("passed");
    expect(result.reachablePaths).toEqual([]);
  });

  test("fails if even one of multiple gold artifacts is reachable", async () => {
    await mkdir(path.join(root, "scripts", "benchmark"), { recursive: true });
    await writeFile(path.join(root, "scripts", "benchmark", "mutating-tasks.ts"), "export const Y = 2;\n", "utf8");

    const result = checkGoldLeakage(root, ["scripts/benchmark/ablation-tasks.ts", "scripts/benchmark/mutating-tasks.ts"]);
    expect(result.assertion).toBe("failed");
    expect(result.reachablePaths).toEqual(["scripts/benchmark/mutating-tasks.ts"]);
  });

  test("an empty gold-artifact list always passes (nothing to leak)", () => {
    const result = checkGoldLeakage(root, []);
    expect(result.assertion).toBe("passed");
    expect(result.reachablePaths).toEqual([]);
  });
});
