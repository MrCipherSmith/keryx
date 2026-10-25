import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import {
  ASSUMED_PARALLEL_DISPATCHES,
  CHILD_DEADLINE_MINUTES,
  CONFIRM_PLAN_TOOL,
  DEFAULT_MAX_DISPATCHES,
  DEFAULT_MAX_MINUTES,
  PLAN_CONFIRMATION_FILE,
  type RoundEstimate,
  TYPICAL_DISPATCH_MINUTES,
  estimatePackage,
  estimateRound,
  planConfirmationFor,
  planConfirmed,
  planGateRefusal,
  planKeyOf,
  readPlanConfirmation,
  readPlanThresholds,
  renderEstimate,
  writePlanConfirmation,
} from "./estimate";
import type { SliceManifest } from "./slice";

const manifest = (count: number, bytes: number, waveBytes: number): SliceManifest => ({
  schemaVersion: 1,
  maxBytes: bytes,
  waveBytes,
  source: "diff",
  slices: Array.from({ length: count }, (_, i) => ({ id: `s${i}`, path: `slices/s${i}.diff`, bytes, files: [`src/f${i}.ts`], domain: "d", split: "domain" })) as SliceManifest["slices"],
  omissions: [],
  totals: { slices: count, bytes: bytes * count, files: count, omittedFiles: 0, omittedBytes: 0, droppedBlocks: 0 },
});

test("roles x slices = assignments, waves follow the wave budget", () => {
  const e = estimateRound(["review-logic", "review-style", "review-clean-code"], manifest(10, 100, 500), "full");
  expect(e.assignments).toBe(30);
  expect(e.perRole.every((r) => r.slices === 10 && r.waves === 2)).toBe(true);
  expect(e.dispatches).toBe(6);
  expect(e.sequentialBatches).toBe(2);
  expect(e.minutes).toEqual({ min: 2 * TYPICAL_DISPATCH_MINUTES, max: 2 * CHILD_DEADLINE_MINUTES });
});

test("many roles queue behind the parallelism limit", () => {
  const roles = Array.from({ length: 8 }, (_, i) => `review-r${i}`);
  const e = estimateRound(roles, manifest(1, 10, 100));
  expect(e.dispatches).toBe(8);
  expect(e.sequentialBatches).toBe(Math.ceil(8 / ASSUMED_PARALLEL_DISPATCHES));
});

test("an unsliced package has assignments = roles and one wave each", () => {
  const e = estimateRound(["review-logic", "review-style"], undefined);
  expect(e).toMatchObject({ sliced: false, assignments: 2, dispatches: 2, sequentialBatches: 1 });
  expect(renderEstimate(e)).toContain("not sliced");
});

test("estimatePackage reads the manifest and the recorded depth from a package", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-estimate-"));
  try {
    for (const name of ["review-orchestrator", "review-logic", "review-style", "review-testing-practices", "review-clean-code"]) {
      const dir = path.join(root, ".metaproject", "skills", "gdskills", "review", name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n`);
    }
    await writeFile(path.join(root, ".metaproject", "metaproject.json"), JSON.stringify({ modules: { gdskills: {} } }));
    const pkg = path.join(root, ".metaproject", "reviews", "r1");
    await mkdir(path.join(pkg, "slices"), { recursive: true });
    await writeFile(path.join(pkg, "slices", "manifest.json"), JSON.stringify(manifest(4, 100, 1000)));
    await writeFile(path.join(pkg, "scope-files.json"), JSON.stringify({ version: 1, files: ["src/a.ts"], changedLines: 10 }));
    await writeFile(path.join(pkg, "round-depth.json"), JSON.stringify({ requested: "auto", depth: "light", reason: "auto: small", files: ["src/a.ts"], changedLines: 10 }));
    const withoutStyle = await estimatePackage(pkg);
    expect(withoutStyle.roles).toBe(2);
    await writeFile(path.join(pkg, "round-roles.json"), JSON.stringify({ enabled: ["review-clean-code", "review-style"] }));
    const e = await estimatePackage(pkg);
    expect(e.manifest).toBe(path.join(".metaproject", "reviews", "r1", "slices", "manifest.json"));
    expect(renderEstimate(e)).toContain("manifest: .metaproject/reviews/r1/slices/manifest.json");
    expect(e.depth).toBe("light");
    expect(e.roles).toBe(3);
    // review-testing-practices is path-gated to test files, so it owns none of these slices: 2 roles x 4 slices.
    expect(e.assignments).toBe(8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--manifest and the shell-host default manifest are read, and the estimate names the one used", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-estimate-"));
  try {
    for (const name of ["review-orchestrator", "review-logic"]) {
      const dir = path.join(root, ".metaproject", "skills", "gdskills", "review", name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n`);
    }
    await writeFile(path.join(root, ".metaproject", "metaproject.json"), JSON.stringify({ modules: { gdskills: {} } }));
    const pkg = path.join(root, ".metaproject", "reviews", "r1");
    await mkdir(pkg, { recursive: true });
    const shellHost = path.join(root, ".metaproject", "data", "review", "slices");
    await mkdir(shellHost, { recursive: true });
    await writeFile(path.join(shellHost, "manifest.json"), JSON.stringify(manifest(3, 100, 1000)));
    const fallback = await estimatePackage(pkg);
    expect(fallback.slices).toBe(3);
    expect(fallback.manifest).toBe(path.join(".metaproject", "data", "review", "slices", "manifest.json"));

    const explicit = path.join(root, "elsewhere.json");
    await writeFile(explicit, JSON.stringify(manifest(7, 100, 1000)));
    const given = await estimatePackage(pkg, { manifest: explicit });
    expect(given.slices).toBe(7);
    expect(given.manifest).toBe("elsewhere.json");

    await expect(estimatePackage(pkg, { manifest: path.join(root, "missing.json") })).rejects.toThrow("is not a slice manifest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const routed = (roles: string[][], bytes = 100, waveBytes = 1000): SliceManifest => {
  const base = manifest(roles.length, bytes, waveBytes);
  return { ...base, slices: base.slices.map((slice, i) => ({ ...slice, roles: roles[i]!, depth: roles[i]!.includes("review-security-code") ? "deep" as const : "light" as const })) };
};

describe("estimateRound honours slice roles", () => {
  test("a role owns only its routed slices; a routable role with none needs no dispatch", () => {
    const e = estimateRound(["review-logic", "review-style", "review-security-code"], routed([["review-logic"], ["review-logic", "review-style"], ["review-logic", "review-security-code"]]));
    expect(e.perRole).toEqual([
      { role: "review-logic", slices: 3, waves: 1 },
      { role: "review-style", slices: 1, waves: 1 },
      { role: "review-security-code", slices: 1, waves: 1 },
    ]);
    expect(e.assignments).toBe(5);
    expect(e.routing).toEqual({ deep: 1, light: 2, audit: 0 });
    const none = estimateRound(["review-logic", "review-style"], routed([["review-logic"]]));
    expect(none.routedOut).toEqual(["review-style"]);
    expect(none.dispatches).toBe(1);
  });

  test("a manifest with neither size is refused, never estimated as NaN", () => {
    const unsized = { ...manifest(2, 100, 1000), waveBytes: undefined, maxBytes: undefined } as unknown as SliceManifest;
    expect(() => estimateRound(["review-logic"], unsized)).toThrow("neither waveBytes nor maxBytes");
  });
});

describe("over-threshold plans", () => {
  test("more dispatches than the threshold, or a longer upper duration, flags the plan", () => {
    const small = estimateRound(["review-logic"], manifest(10, 100, 100));
    expect(small).toMatchObject({ dispatches: 10, overThreshold: false, overReasons: [] });
    const many = estimateRound(["review-logic", "review-style", "review-clean-code", "review-architecture", "review-performance"], manifest(10, 100, 100));
    expect(many.dispatches).toBe(50);
    expect(many.overThreshold).toBe(true);
    expect(many.overReasons[0]).toBe(`50 dispatches > ${DEFAULT_MAX_DISPATCHES}`);
    expect(renderEstimate(many)).toContain("over threshold: 50 dispatches > 40");
    // One role with 20 waves: 20 batches x 5 min = 100 min > 90, though 20 dispatches is under 40.
    const long = estimateRound(["review-logic"], manifest(20, 100, 100));
    expect(long.overReasons).toEqual([`up to 100 min > ${DEFAULT_MAX_MINUTES}`]);
    expect(estimateRound(["review-logic"], manifest(20, 100, 100), "full", { maxDispatches: 40, maxMinutes: 120 }).overThreshold).toBe(false);
  });

  test("routing.config.json reviewPlan sets the thresholds; a bad field keeps its default", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-plan-thresholds-"));
    try {
      expect(await readPlanThresholds(root)).toMatchObject({ maxDispatches: 40, maxMinutes: 90, source: "default" });
      await writeFile(path.join(root, "routing.config.json"), JSON.stringify({ reviewPlan: { maxDispatches: 12, maxMinutes: "x" } }));
      expect(await readPlanThresholds(root)).toMatchObject({ maxDispatches: 12, maxMinutes: 90, source: "routing.config.json" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the plan key is stable for the same plan and changes with a slice's roles or depth", () => {
    const a = estimateRound(["review-logic", "review-style"], routed([["review-logic"], ["review-logic", "review-style"]]));
    const again = estimateRound(["review-style", "review-logic"], routed([["review-logic"], ["review-logic", "review-style"]]));
    expect(again.planKey).toBe(a.planKey);
    expect(planKeyOf(a)).toBe(a.planKey);
    const moved = estimateRound(["review-logic", "review-style"], routed([["review-logic", "review-style"], ["review-logic", "review-style"]]));
    expect(moved.planKey).not.toBe(a.planKey);
  });
});

describe("plan confirmation", () => {
  const big = (): RoundEstimate => estimateRound(["review-logic", "review-style", "review-clean-code", "review-architecture", "review-performance"], manifest(10, 100, 100));

  test("an over-threshold plan is refused until a confirmation for exactly this plan is recorded; the refusal names the card and the terminal command", async () => {
    const pkg = await mkdtemp(path.join(tmpdir(), "keryx-plan-confirm-"));
    try {
      const estimate = big();
      expect(planConfirmed(pkg, estimate)).toBe(false);
      const refusal = planGateRefusal(estimate, planConfirmed(pkg, estimate), pkg)!;
      expect(refusal).toContain(CONFIRM_PLAN_TOOL);
      expect(refusal).toContain(`keryx review estimate --package ${pkg} --confirm --quote`);

      await writePlanConfirmation(pkg, planConfirmationFor(estimate, "go ahead, 50 is fine", "tui-card", new Date("2026-10-16T00:00:00Z")));
      expect(readPlanConfirmation(pkg)).toEqual({ planKey: estimate.planKey, dispatches: 50, minutes: [estimate.minutes.min, estimate.minutes.max], quote: "go ahead, 50 is fine", confirmedVia: "tui-card", at: "2026-10-16T00:00:00.000Z" });
      expect(planConfirmed(pkg, estimate)).toBe(true);
      expect(planGateRefusal(estimate, true, pkg)).toBeUndefined();

      // Another plan (one more role) is not covered by that confirmation.
      const other = estimateRound(["review-logic", "review-style", "review-clean-code", "review-architecture", "review-performance", "review-highload"], manifest(10, 100, 100));
      expect(planConfirmed(pkg, other)).toBe(false);
    } finally {
      await rm(pkg, { recursive: true, force: true });
    }
  });

  test("a malformed confirmation, or one without the operator's words, does not count", async () => {
    const pkg = await mkdtemp(path.join(tmpdir(), "keryx-plan-confirm-"));
    try {
      const estimate = big();
      await writeFile(path.join(pkg, PLAN_CONFIRMATION_FILE), JSON.stringify({ planKey: estimate.planKey, dispatches: 50, minutes: [1, 2], quote: " ", confirmedVia: "terminal", at: "x" }));
      expect(readPlanConfirmation(pkg)).toBeUndefined();
      await writeFile(path.join(pkg, PLAN_CONFIRMATION_FILE), JSON.stringify({ planKey: estimate.planKey, dispatches: 50, minutes: [1, 2], quote: "ok", confirmedVia: "agent", at: "x" }));
      expect(planConfirmed(pkg, estimate)).toBe(false);
      expect(() => planConfirmationFor(estimate, "  ", "terminal")).toThrow("operator's own words");
      expect(planGateRefusal(estimateRound(["review-logic"], manifest(2, 100, 100)), false, pkg)).toBeUndefined();
    } finally {
      await rm(pkg, { recursive: true, force: true });
    }
  });

  test("`keryx review estimate --confirm` records a confirmation only at a terminal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-plan-cli-"));
    const cwd = process.cwd();
    const log = console.log;
    const error = console.error;
    const errors: string[] = [];
    try {
      await mkdir(path.join(root, ".metaproject"), { recursive: true });
      const pkg = path.join(root, ".metaproject", "reviews", "r1");
      await mkdir(path.join(pkg, "slices"), { recursive: true });
      await writeFile(path.join(pkg, "slices", "manifest.json"), JSON.stringify(manifest(3, 100, 1000)));
      process.chdir(root);
      console.log = () => {};
      console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(" ")); };
      const args = ["estimate", "--package", pkg, "--confirm", "--quote", "yes, run it"];
      await reviewCommand(args, { isTerminal: () => false });
      expect(process.exitCode).toBe(1);
      expect(errors.join("\n")).toContain(`call the ${CONFIRM_PLAN_TOOL} tool`);
      expect(readPlanConfirmation(pkg)).toBeUndefined();
      errors.length = 0;
      process.exitCode = 0;
      await reviewCommand(["estimate", "--package", pkg, "--confirm"], { isTerminal: () => true });
      expect(errors.join("\n")).toContain("--quote");
      expect(readPlanConfirmation(pkg)).toBeUndefined();
      process.exitCode = 0;
      await reviewCommand(args, { isTerminal: () => true });
      expect(process.exitCode).toBe(0);
      const recorded = readPlanConfirmation(pkg);
      expect(recorded).toMatchObject({ quote: "yes, run it", confirmedVia: "terminal" });
      expect(recorded?.planKey).toBe((await estimatePackage(pkg)).planKey);
    } finally {
      console.log = log;
      console.error = error;
      process.exitCode = 0;
      process.chdir(cwd);
      await rm(root, { recursive: true, force: true });
    }
  });
});
