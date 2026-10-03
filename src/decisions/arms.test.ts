// Flow 400 (AC1, AC4): the four arms. The assignment is a pure function of (salt, seq),
// so every test here is exact: no clock, no real randomness, no network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ARMS,
  ARM_FACTORS,
  DEFAULT_ARM_WEIGHTS,
  armOfMode,
  assignArm,
  chooseArm,
  loadArmWeights,
  loadRepoSalt,
  modeOfArm,
  parseArmWeights,
  pickArm,
  seedFile,
  type Arm,
} from "./arms";
import { openDecision } from "./journal";
import { readRecords } from "./store";
import type { OpenRecord } from "./types";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-arms-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const OPTIONS = [
  { id: "a", label: "Option A", description: "the safe one" },
  { id: "b", label: "Option B", description: "the quick one" },
  { id: "c", label: "Option C", description: "the odd one" },
];
const REC = { optionId: "a", reason: "least risk" };

function tally(salt: string, runs: number, weights = DEFAULT_ARM_WEIGHTS): Record<Arm, number> {
  const counts: Record<Arm, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (let seq = 1; seq <= runs; seq += 1) counts[assignArm(salt, seq, weights).arm] += 1;
  return counts;
}

describe("AC1: the arm is a seeded function of (repoSalt, seq)", () => {
  test("the same salt and seq give the same arm and seed on every call", () => {
    const first = assignArm("salt-one", 7);
    for (let i = 0; i < 5; i += 1) expect(assignArm("salt-one", 7)).toEqual(first);
    expect(Number.isInteger(first.seed)).toBe(true);
    expect(ARMS).toContain(first.arm);
  });

  test("a different salt or a different seq gives a different seed", () => {
    expect(assignArm("salt-one", 7).seed).not.toBe(assignArm("salt-two", 7).seed);
    expect(assignArm("salt-one", 7).seed).not.toBe(assignArm("salt-one", 8).seed);
  });

  test("the whole sequence for a fixed salt is a fixed list of arms", () => {
    const run = (): string => Array.from({ length: 40 }, (_, i) => assignArm("fixed", i + 1).arm).join("");
    expect(run()).toBe(run());
    expect(run()).toMatch(/^[ABCD]{40}$/);
  });

  test("with the default weights the share is about 0.4, 0.2, 0.2, 0.2", () => {
    const runs = 4000;
    const counts = tally("share-check", runs);
    expect(counts.A / runs).toBeGreaterThan(0.36);
    expect(counts.A / runs).toBeLessThan(0.44);
    for (const arm of ["B", "C", "D"] as const) {
      expect(counts[arm] / runs).toBeGreaterThan(0.16);
      expect(counts[arm] / runs).toBeLessThan(0.24);
    }
  });

  test("pickArm walks A, B, C, D over the weights", () => {
    expect(pickArm(0)).toBe("A");
    expect(pickArm(0.39)).toBe("A");
    expect(pickArm(0.41)).toBe("B");
    expect(pickArm(0.61)).toBe("C");
    expect(pickArm(0.81)).toBe("D");
    expect(pickArm(0.999999)).toBe("D");
  });

  test("a weight of zero removes an arm; weights are normalised", () => {
    const only = { A: 0, B: 0, C: 3, D: 0 };
    expect(tally("zero", 200, only)).toEqual({ A: 0, B: 0, C: 200, D: 0 });
  });

  test("factors and the mode an old reader understands", () => {
    expect(ARM_FACTORS.A).toEqual({ order: "agent", mark: "shown", preselect: true });
    expect(ARM_FACTORS.B).toEqual({ order: "agent", mark: "shown", preselect: false });
    expect(ARM_FACTORS.C).toEqual({ order: "shuffled", mark: "shown", preselect: false });
    expect(ARM_FACTORS.D).toEqual({ order: "shuffled", mark: "hidden", preselect: false });
    expect(modeOfArm("A")).toBe("ordinary");
    expect(modeOfArm("D")).toBe("blind");
    expect(modeOfArm("B")).toBe("partial");
    expect(modeOfArm("C")).toBe("partial");
    expect(armOfMode("ordinary")).toBe("A");
    expect(armOfMode("blind")).toBe("D");
  });
});

describe("AC1: the weights come from decisions.config.json", () => {
  test("parseArmWeights keeps defaults for a missing key and falls back whole on bad input", () => {
    expect(parseArmWeights(undefined)).toEqual(DEFAULT_ARM_WEIGHTS);
    expect(parseArmWeights({ D: 0.5 })).toEqual({ A: 0.4, B: 0.2, C: 0.2, D: 0.5 });
    expect(parseArmWeights({ A: -1 })).toEqual(DEFAULT_ARM_WEIGHTS);
    expect(parseArmWeights({ A: "x" })).toEqual(DEFAULT_ARM_WEIGHTS);
    expect(parseArmWeights({ A: 0, B: 0, C: 0, D: 0 })).toEqual(DEFAULT_ARM_WEIGHTS);
  });

  test("loadArmWeights reads the arms key and defaults when there is no config", async () => {
    expect(await loadArmWeights(root)).toEqual(DEFAULT_ARM_WEIGHTS);
    await writeFile(path.join(root, ".metaproject", "decisions.config.json"), JSON.stringify({ arms: { A: 1, B: 0, C: 0, D: 0 } }), "utf8");
    expect(await loadArmWeights(root)).toEqual({ A: 1, B: 0, C: 0, D: 0 });
  });

  test("openDecision uses the configured weights", async () => {
    await writeFile(path.join(root, ".metaproject", "decisions.config.json"), JSON.stringify({ arms: { A: 0, B: 0, C: 0, D: 1 } }), "utf8");
    const opened = await openDecision({ cwd: root, question: "Which colour?", options: OPTIONS, recommendation: REC, salt: "s", seq: 1 });
    expect(opened.arm).toBe("D");
    expect(opened.mode).toBe("blind");
  });
});

describe("AC1: the repo salt", () => {
  test("is created once with mode 0600, read back unchanged, and never written to a record", async () => {
    const salt = await loadRepoSalt(root);
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(await loadRepoSalt(root)).toBe(salt);
    const file = seedFile(root);
    expect(file).toBe(path.join(root, ".metaproject", "data", "decisions", "seed"));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readFile(file, "utf8")).trim()).toBe(salt);

    await openDecision({ cwd: root, question: "Which colour?", options: OPTIONS, recommendation: REC });
    const [open] = await readRecords(root);
    expect(open).toBeDefined();
    expect(JSON.stringify(open)).not.toContain(salt);
    expect(typeof (open as OpenRecord | undefined)?.seed).toBe("number");
  });

  test("two opens in one journal use seq 1 and 2 and the stored seed matches assignArm", async () => {
    const salt = await loadRepoSalt(root);
    const one = await openDecision({ cwd: root, question: "First?", options: OPTIONS, recommendation: REC });
    const two = await openDecision({ cwd: root, question: "Second?", options: OPTIONS, recommendation: REC });
    expect(one.seed).toBe(assignArm(salt, 1).seed);
    expect(two.seed).toBe(assignArm(salt, 2).seed);
  });
});

describe("AC4: forced A", () => {
  test("chooseArm moves an irreversible question to A with forced true, whatever was drawn", () => {
    for (const arm of ARMS) {
      const chosen = chooseArm({ salt: "s", seq: 1, irreversible: true, hasRecommendation: true, force: arm });
      expect(chosen).toMatchObject({ arm: "A", forced: true, drawn: arm });
    }
  });

  test("every other A is forced false, and so is any other arm", () => {
    for (const arm of ARMS) {
      expect(chooseArm({ salt: "s", seq: 1, irreversible: false, hasRecommendation: true, force: arm })).toMatchObject({ arm, forced: false });
    }
  });

  test("a question without a recommendation is A and not forced", () => {
    expect(chooseArm({ salt: "s", seq: 1, irreversible: false, hasRecommendation: false, force: "D" })).toMatchObject({ arm: "A", forced: false });
  });

  test("an action tag, the irreversible flag and a blind.ts match each give A forced, even when the draw is D", async () => {
    const base = { cwd: root, options: OPTIONS, recommendation: REC, arm: "D" as const };
    const tagged = await openDecision({ ...base, question: "Which colour?", action: "release" });
    const flagged = await openDecision({ ...base, question: "Which colour?", irreversible: true });
    const matched = await openDecision({ ...base, question: "Delete the cache directory?" });
    for (const opened of [tagged, flagged, matched]) {
      expect(opened).toMatchObject({ arm: "A", forced: true, mode: "ordinary", showMark: true, blindRefused: true });
    }
    const records = (await readRecords(root)).filter((r) => r.kind === "open");
    expect(records).toHaveLength(3);
    for (const record of records) expect(record).toMatchObject({ arm: "A", forced: true });
  });

  test("an ordinary question in arm A has forced false on the record", async () => {
    const opened = await openDecision({ cwd: root, question: "Which colour?", options: OPTIONS, recommendation: REC, arm: "A" });
    expect(opened).toMatchObject({ arm: "A", forced: false, preselected: true });
    expect((await readRecords(root))[0]).toMatchObject({ arm: "A", forced: false });
  });

  test("the record carries the arm's factors: order, preselected, mode", async () => {
    const expectations: Record<Arm, { mode: string; preselected: boolean; showMark: boolean }> = {
      A: { mode: "ordinary", preselected: true, showMark: true },
      B: { mode: "partial", preselected: false, showMark: true },
      C: { mode: "partial", preselected: false, showMark: true },
      D: { mode: "blind", preselected: false, showMark: false },
    };
    for (const arm of ARMS) {
      const opened = await openDecision({ cwd: root, question: `Which colour (${arm})?`, options: OPTIONS, recommendation: REC, arm, random: () => 0 });
      expect(opened).toMatchObject({ arm, ...expectations[arm] });
      if (arm === "A" || arm === "B") expect(opened.order).toEqual(["a", "b", "c"]);
    }
  });
});
