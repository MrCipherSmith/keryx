// Flow 400 (AC1, AC4): the four arms. The assignment is a pure function of (salt, seq),
// so every test here is exact: no clock, no real randomness, no network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ARMS,
  ARM_FACTORS,
  DEFAULT_ARM_WEIGHTS,
  DEFAULT_PER_ARM_THRESHOLD,
  armOfMode,
  assignArm,
  chooseArm,
  loadArmWeights,
  loadDecisionsSettings,
  loadRepoSalt,
  modeOfArm,
  parseArmWeights,
  pickArm,
  readSettings,
  saltFile,
  seedFile,
  type Arm,
} from "./arms";
import { openDecision } from "./journal";
import { renderReport } from "./report";
import { loadReport } from "./service";
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

  test("golden values: fixed (salt, seq) pairs give fixed arms and seeds, so a change of hash, PRNG or weights fails here", () => {
    const golden: Array<[string, number, Arm, number]> = [
      ["golden-salt", 1, "B", 4019443924],
      ["golden-salt", 2, "D", 2761754493],
      ["golden-salt", 3, "D", 1891882281],
      ["golden-salt", 4, "B", 1878995061],
      ["golden-salt", 5, "A", 2549695323],
      ["golden-salt", 6, "A", 3569336769],
      ["golden-salt", 16, "C", 296563100],
      ["golden-salt", 18, "C", 864226196],
      ["other-salt", 1, "B", 4256560751],
      ["other-salt", 2, "A", 846608942],
    ];
    for (const [salt, seq, arm, seed] of golden) expect(assignArm(salt, seq)).toEqual({ arm, seed });
    // every arm is covered, so a weights change cannot slip through unnoticed
    expect(new Set(golden.map(([, , arm]) => arm))).toEqual(new Set(ARMS));
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

const configPath = (): string => path.join(root, ".metaproject", "decisions.config.json");

describe("AC19: arm weights and the per-arm threshold from .metaproject/decisions.config.json", () => {
  test("the defaults are A 0.4, B 0.2, C 0.2, D 0.2 and a threshold of 150, with nothing configured", async () => {
    expect(DEFAULT_ARM_WEIGHTS).toEqual({ A: 0.4, B: 0.2, C: 0.2, D: 0.2 });
    expect(DEFAULT_PER_ARM_THRESHOLD).toBe(150);
    expect(await loadDecisionsSettings(root)).toEqual({ weights: DEFAULT_ARM_WEIGHTS, perArmThreshold: 150, configured: false, invalid: [] });
  });

  test("a configured file sets the weights and the threshold, and the report shows them", async () => {
    await writeFile(configPath(), JSON.stringify({ arms: { A: 0.7, B: 0.1, C: 0.1, D: 0.1 }, perArmThreshold: 40 }), "utf8");
    const settings = await loadDecisionsSettings(root);
    expect(settings).toEqual({ weights: { A: 0.7, B: 0.1, C: 0.1, D: 0.1 }, perArmThreshold: 40, configured: true, invalid: [] });
    await openDecision({ cwd: root, question: "Which colour?", options: OPTIONS, recommendation: REC, salt: "s", seq: 1 });
    const report = await loadReport(root);
    expect(report.settings).toEqual(settings);
    expect(report.progress.perArm.threshold).toBe(40);
    const text = renderReport(report);
    expect(text).toContain("Arm weights: A 0.7, B 0.1, C 0.1, D 0.1 (from .metaproject/decisions.config.json).");
    expect(text).not.toContain("not fully usable");
  });

  test("an invalid config falls back to the defaults and the report says so", async () => {
    for (const bad of [{ arms: { A: -1 } }, { arms: { A: "x" } }, { arms: { A: 0, B: 0, C: 0, D: 0 } }, { arms: [1, 2] }]) {
      await writeFile(configPath(), JSON.stringify(bad), "utf8");
      const settings = await loadDecisionsSettings(root);
      expect(settings.weights).toEqual(DEFAULT_ARM_WEIGHTS);
      expect(settings.invalid).toHaveLength(1);
    }
    await writeFile(configPath(), JSON.stringify({ arms: { A: -1 }, perArmThreshold: 0 }), "utf8");
    await openDecision({ cwd: root, question: "Which colour?", options: OPTIONS, recommendation: REC, salt: "s", seq: 1 });
    const report = await loadReport(root);
    expect(report.settings).toMatchObject({ weights: DEFAULT_ARM_WEIGHTS, perArmThreshold: 150, configured: true });
    expect(report.settings.invalid).toHaveLength(2);
    const text = renderReport(report);
    expect(text).toContain("Arm weights: A 0.4, B 0.2, C 0.2, D 0.2 (defaults).");
    expect(text).toMatch(/Config: \.metaproject\/decisions\.config\.json is not fully usable \(.*arms\.A.*perArmThreshold.*\)/);
  });

  test("a file that is not JSON, or not an object, is named too, in an empty journal as well", async () => {
    await writeFile(configPath(), "{ not json", "utf8");
    expect((await loadDecisionsSettings(root)).invalid).toEqual(["the file is not valid JSON"]);
    expect(renderReport(await loadReport(root))).toContain("not fully usable (the file is not valid JSON)");
    expect(readSettings(null).invalid).toEqual(["the file is not a JSON object"]);
    expect(readSettings([]).invalid).toEqual(["the file is not a JSON object"]);
  });

  test("perArmThreshold must be a positive whole number", () => {
    expect(readSettings({ perArmThreshold: 25 })).toMatchObject({ perArmThreshold: 25, invalid: [] });
    for (const bad of [0, -3, 1.5, "10", null]) {
      const settings = readSettings({ perArmThreshold: bad });
      expect(settings.perArmThreshold).toBe(150);
      expect(settings.invalid).toEqual(["perArmThreshold must be a positive whole number"]);
    }
  });

  test("assignment stays deterministic: the same (salt, seq, weights) is the same arm, whatever the config says elsewhere", async () => {
    await writeFile(configPath(), JSON.stringify({ arms: { A: 0.4, B: 0.2, C: 0.2, D: 0.2 }, perArmThreshold: 5 }), "utf8");
    const weights = await loadArmWeights(root);
    expect(weights).toEqual(DEFAULT_ARM_WEIGHTS);
    // the golden pairs of AC1 do not move
    expect(assignArm("golden-salt", 1, weights)).toEqual({ arm: "B", seed: 4019443924 });
    expect(assignArm("golden-salt", 5, weights)).toEqual({ arm: "A", seed: 2549695323 });
    expect(assignArm("other-salt", 2, weights)).toEqual({ arm: "A", seed: 846608942 });
    // and an invalid config leaves them where they were
    await writeFile(configPath(), "[]", "utf8");
    const fallback = await loadArmWeights(root);
    for (let seq = 1; seq <= 30; seq += 1) expect(assignArm("golden-salt", seq, fallback)).toEqual(assignArm("golden-salt", seq));
    const first = await openDecision({ cwd: root, id: "x", question: "Which colour?", options: OPTIONS, recommendation: REC, salt: "golden-salt", seq: 1 });
    expect(first.arm).toBe("B");
  });

  test("the configured weights change who is drawn, and the share follows them", async () => {
    const heavy = { A: 0.1, B: 0.1, C: 0.1, D: 0.7 };
    const runs = 3000;
    const counts = tally("share-check", runs, heavy);
    expect(counts.D / runs).toBeGreaterThan(0.65);
    expect(counts.D / runs).toBeLessThan(0.75);
    expect(tally("share-check", runs, heavy)).toEqual(counts);
  });
});

describe("AC1: the repo salt", () => {
  let config: string;

  beforeEach(async () => {
    config = await mkdtemp(path.join(tmpdir(), "keryx-arms-config-"));
  });

  afterEach(async () => {
    await rm(config, { recursive: true, force: true });
  });

  test("is created once outside the repository with mode 0600 (directory 0700), read back unchanged, and never written to a record", async () => {
    const salt = await loadRepoSalt(root, { configDir: config });
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(await loadRepoSalt(root, { configDir: config })).toBe(salt);
    const file = await saltFile(root, { configDir: config });
    expect(path.dirname(file)).toBe(path.join(config, "decisions"));
    expect(path.basename(file)).toMatch(/^[0-9a-f]{16}\.seed$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect((await readFile(file, "utf8")).trim()).toBe(salt);
    // nothing of it is left in the repository
    await expect(stat(seedFile(root))).rejects.toThrow();

    await openDecision({ cwd: root, question: "Which colour?", options: OPTIONS, recommendation: REC, salt });
    const [open] = await readRecords(root);
    expect(open).toBeDefined();
    expect(JSON.stringify(open)).not.toContain(salt);
    expect(typeof (open as OpenRecord | undefined)?.seed).toBe("number");
  });

  test("the default location is <XDG_CONFIG_HOME>/keryx/decisions, and KERYX_CONFIG_DIR replaces <XDG_CONFIG_HOME>/keryx", async () => {
    const saved = { xdg: process.env["XDG_CONFIG_HOME"], dir: process.env["KERYX_CONFIG_DIR"] };
    try {
      delete process.env["KERYX_CONFIG_DIR"];
      process.env["XDG_CONFIG_HOME"] = config;
      expect(path.dirname(await saltFile(root))).toBe(path.join(config, "keryx", "decisions"));
      process.env["KERYX_CONFIG_DIR"] = path.join(config, "other");
      expect(path.dirname(await saltFile(root))).toBe(path.join(config, "other", "decisions"));
    } finally {
      for (const [key, value] of [["XDG_CONFIG_HOME", saved.xdg], ["KERYX_CONFIG_DIR", saved.dir]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("two repositories get two salt files, and every worktree of one repository shares one", async () => {
    const other = await mkdtemp(path.join(tmpdir(), "keryx-arms-other-"));
    try {
      const run = (cwd: string, ...args: string[]): void => {
        const done = Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
        if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
      };
      run(other, "init", "-q");
      expect(await saltFile(root, { configDir: config })).not.toBe(await saltFile(other, { configDir: config }));
      run(other, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
      const linked = path.join(other, "..", `${path.basename(other)}-linked`);
      run(other, "worktree", "add", "-q", linked, "-b", "linked");
      try {
        expect(await saltFile(linked, { configDir: config })).toBe(await saltFile(other, { configDir: config }));
      } finally {
        await rm(linked, { recursive: true, force: true });
      }
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  test("an empty, blank or too-short salt file is replaced, not an error forever", async () => {
    const file = await saltFile(root, { configDir: config });
    await mkdir(path.dirname(file), { recursive: true });
    for (const bad of ["", "  \n\t\n", "short\n"]) {
      await writeFile(file, bad, { encoding: "utf8", mode: 0o600 });
      const salt = await loadRepoSalt(root, { configDir: config });
      expect(salt).toMatch(/^[0-9a-f]{64}$/);
      expect((await readFile(file, "utf8")).trim()).toBe(salt);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await loadRepoSalt(root, { configDir: config })).toBe(salt);
      // the temp file of the replacement is gone
      expect((await readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    }
  });

  test("an existing salt file readable by others is tightened to 0600 and its salt kept", async () => {
    const file = await saltFile(root, { configDir: config });
    await mkdir(path.dirname(file), { recursive: true });
    const given = "a".repeat(64);
    await writeFile(file, `${given}\n`, { encoding: "utf8", mode: 0o644 });
    await chmod(file, 0o644);
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    expect(await loadRepoSalt(root, { configDir: config })).toBe(given);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("migration: an in-repo seed is copied to the new place when none exists, then deleted; arms stay reproducible", async () => {
    const old = seedFile(root);
    const given = "b".repeat(64);
    await mkdir(path.dirname(old), { recursive: true });
    await writeFile(old, `${given}\n`, { encoding: "utf8", mode: 0o600 });
    expect(await loadRepoSalt(root, { configDir: config })).toBe(given);
    const file = await saltFile(root, { configDir: config });
    expect((await readFile(file, "utf8")).trim()).toBe(given);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(stat(old)).rejects.toThrow();
    expect(await loadRepoSalt(root, { configDir: config })).toBe(given);
  });

  test("migration: a salt already in the new place wins over a stale in-repo seed, which is still removed", async () => {
    const given = "c".repeat(64);
    const fresh = await loadRepoSalt(root, { configDir: config });
    const old = seedFile(root);
    await mkdir(path.dirname(old), { recursive: true });
    await writeFile(old, `${given}\n`, { encoding: "utf8", mode: 0o600 });
    expect(await loadRepoSalt(root, { configDir: config })).toBe(fresh);
    await expect(stat(old)).rejects.toThrow();
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
    const tagged = await openDecision({ ...base, question: "Which colour, tagged?", action: "release" });
    const flagged = await openDecision({ ...base, question: "Which colour, flagged?", irreversible: true });
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
