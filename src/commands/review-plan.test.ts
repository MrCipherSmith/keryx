// Flow 458 AC8: `keryx review plan` runs the round's planning steps in order, writes plan.json and never dispatches.
// The steps are replaced by a fake that leaves the files the real ones leave; the plan's own reading of them is real.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RoundRecord } from "../review/round-record";
import { PLAN_FILE, PLAN_FLAGS, nextStepOf, packagePathOf, runPlan, slicesByKind, targetKindOf, type ReviewPlan, type StepResult } from "./review-plan";
import { printReviewHelpFor, reviewCommand } from "./review";
import { computeReadiness } from "../review/readiness";

const realLog = console.log;
let root = "";
let pkg = "";
let out: string[] = [];
let calls: string[][] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-review-plan-"));
  pkg = path.join(root, ".metaproject", "reviews", "r2");
  await mkdir(pkg, { recursive: true });
  out = [];
  calls = [];
  console.log = (...args: unknown[]) => void out.push(args.map(String).join(" "));
});

afterEach(async () => {
  console.log = realLog;
  await rm(root, { recursive: true, force: true });
});

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

const deltaRound = (over: Partial<RoundRecord> = {}): RoundRecord => ({
  v: 1,
  round: 2,
  source: "local-package",
  sourcesTried: [],
  previous: { reviewId: "r1", reviewedHead: BASE },
  mode: "delta",
  range: { base: BASE, head: HEAD },
  fixHunks: [{ file: "src/a/a.ts", startLine: 10, endLine: 10, findingIds: ["F1"] }],
  newHunks: [{ file: "src/c/c.ts", startLine: 1, endLine: 3 }],
  carried: [{ findingId: "F9", disposition: "closed" }],
  ...over,
});

const entry = (id: string, files: string[], extra: Record<string, unknown> = {}) => ({ id, path: `${id}.diff`, bytes: 100, files, domain: "src", split: "domain", ...extra });

type Fake = { round?: RoundRecord | undefined; slices?: unknown[]; failStep?: string; required?: string[] };

function fakeRun(fake: Fake): (args: string[]) => Promise<StepResult> {
  return async (args) => {
    calls.push(args);
    const step = args[0]!;
    if (step === fake.failStep) return { stdout: "", stderr: `${step} broke`, exitCode: 1 };
    if (step === "start") {
      if (fake.round !== undefined) await writeFile(path.join(pkg, "round.json"), `${JSON.stringify(fake.round)}\n`);
      return { stdout: `# managed review: r2\n\nmode: review-flow\npath: ${pkg}\n`, stderr: "", exitCode: 0 };
    }
    if (step === "scope") return { stdout: JSON.stringify({ files: ["src/a/a.ts", "src/c/c.ts"], counts: { changedLinesRetained: 40 } }), stderr: "", exitCode: 0 };
    if (step === "blast-radius") return { stdout: "", stderr: "graph is empty", exitCode: 1 };
    if (step === "slice") {
      await mkdir(path.join(pkg, "slices"), { recursive: true });
      const manifest = { schemaVersion: 1, maxBytes: 18000, waveBytes: 60000, source: "diff", slices: fake.slices ?? [], omissions: [], totals: { slices: 0, bytes: 0, files: 0, omittedFiles: 0, omittedBytes: 0, droppedBlocks: 0 } };
      await writeFile(path.join(pkg, "slices", "manifest.json"), `${JSON.stringify(manifest)}\n`);
      return { stdout: JSON.stringify(manifest), stderr: "", exitCode: 0 };
    }
    if (step === "required") return { stdout: JSON.stringify({ required: fake.required ?? ["review-logic", "review-regression", "review-style"] }), stderr: "", exitCode: 0 };
    throw new Error(`unexpected step ${step}`);
  };
}

const deps = (fake: Fake) => ({
  cwd: root,
  rejectUnknownFlags: (args: readonly string[], allowed: readonly string[]) => {
    const unknown = args.filter((a) => a.startsWith("--") && !allowed.includes(a.split("=")[0]!));
    if (unknown.length > 0) throw new Error(`Unknown option ${unknown.join(", ")}`);
  },
  run: fakeRun(fake),
});

const SPLIT = [
  entry("slice-01", ["src/a/a.ts"], { roles: ["review-logic", "review-regression", "review-security-code"], depth: "deep", kind: "fix", findingIds: ["F1"] }),
  entry("slice-02", ["src/c/c.ts"], { roles: ["review-logic", "review-style"], depth: "light", kind: "new" }),
];

const readPlan = async (): Promise<ReviewPlan> => JSON.parse(await readFile(path.join(pkg, PLAN_FILE), "utf8"));

test("a delta round: the steps run in order, plan.json carries the round, both slice kinds, the roster and the estimate, and nothing is dispatched", async () => {
  await runPlan(["--target", "https://github.com/o/r/pull/7", "--head", HEAD, "--host", "claude-code", "--json"], deps({ round: deltaRound(), slices: SPLIT }));
  expect(calls.map((call) => call[0])).toEqual(["start", "scope", "blast-radius", "slice", "required"]);
  expect(calls[0]).toEqual(["start", "--target", "pr", "--ref", "https://github.com/o/r/pull/7", "--head", HEAD, "--host", "claude-code"]);
  // A delta round is scoped and sliced over the previous reviewed head, whatever --ref said; slice reads the range from round.json.
  // --head pins the scope too: the diff ends at that commit, not at the working tree.
  expect(calls[1]).toEqual(["scope", "--json", "--ref", BASE, "--head", HEAD]);
  expect(calls[3]).toEqual(["slice", "--package", pkg, "--head", HEAD, "--host", "claude-code", "--json"]);
  expect(calls[4]).toEqual(["required", "--depth", "auto", "--scope", path.join(pkg, "scope.json"), "--package", pkg, "--json"]);

  const plan = await readPlan();
  expect(plan).toMatchObject({ v: 1, package: pkg, target: { kind: "pr", base: BASE, head: HEAD }, round: { number: 2, mode: "delta", previous: "r1", fixHunks: 1, newHunks: 1, carried: 1 }, next: "dispatch", overThreshold: false });
  expect(plan.slices.fix.map((s) => s.id)).toEqual(["slice-01"]);
  expect(plan.slices.fix[0]).toMatchObject({ findingIds: ["F1"], roles: ["review-logic", "review-regression", "review-security-code"] });
  expect(plan.slices.new.map((s) => s.id)).toEqual(["slice-02"]);
  expect(plan.roster).toEqual(["review-logic", "review-regression", "review-style"]);
  expect(plan.dispatches).toBeGreaterThan(0);
  expect(plan.minutes.max).toBeGreaterThanOrEqual(plan.minutes.min);
  expect(plan.split?.fix.slices).toBe(1);
  expect(plan.split?.new.slices).toBe(1);
  expect(plan.warnings[0]).toContain("blast radius not computed");
  expect(JSON.parse(out.join("\n")).planKey).toBe(plan.planKey);
  expect(existsSync(path.join(pkg, "scope-files.json"))).toBe(true);
});

test("a first round: --ref is the base for scope and slice, no kinds, and the human summary is short", async () => {
  await runPlan(["--target", "feature/x", "--ref", "origin/main"], deps({ round: deltaRound({ mode: "first", round: 1, previous: null, range: { base: "c".repeat(40), head: HEAD }, fixHunks: [], newHunks: [] }), slices: [entry("slice-01", ["src/a/a.ts"], { roles: ["review-logic"], depth: "deep" })] }));
  // --ref is also the base `review start` reads the merge-base from (a merged PR's merge-base with origin/main is its head).
  expect(calls[0]).toEqual(["start", "--target", "branch", "--ref", "feature/x", "--base", "origin/main"]);
  expect(calls[1]).toEqual(["scope", "--json", "--ref", "origin/main"]);
  expect(calls[3]).toEqual(["slice", "--package", pkg, "--ref", "origin/main", "--json"]);
  const plan = await readPlan();
  expect(plan.round.mode).toBe("first");
  expect(plan.slices.fix).toEqual([]);
  expect(plan.slices.new.length).toBe(1);
  expect(plan.split).toBeUndefined();
  const text = out.join("\n");
  expect(text).toContain("slices: fix 0, new 1");
  expect(text).toContain("next: dispatch");
  expect(text.split("\n").length).toBeLessThan(14);
});

test("over the operator threshold the next step is the plan confirmation, until it is recorded", async () => {
  await writeFile(path.join(root, "routing.config.json"), `${JSON.stringify({ reviewPlan: { maxDispatches: 1 } })}\n`);
  await runPlan(["--target", "feature/x", "--ref", "origin/main"], deps({ slices: SPLIT.map((s) => ({ ...(s as object), kind: undefined, findingIds: undefined })) }));
  const plan = await readPlan();
  expect(plan.overThreshold).toBe(true);
  expect(plan.next).toBe("confirm plan (card review_confirm_plan / keryx review confirm-plan)");
  expect(nextStepOf({ overThreshold: true }, true)).toBe("dispatch");
  expect(nextStepOf({ overThreshold: false }, false)).toBe("dispatch");
});

test("a failing step stops the plan with the step named; nothing is written and nothing later runs", async () => {
  await expect(runPlan(["--target", "feature/x"], deps({ failStep: "scope" }))).rejects.toThrow(/`review scope` failed \(exit 1\).*scope broke/s);
  expect(calls.map((call) => call[0])).toEqual(["start", "scope"]);
  expect(existsSync(path.join(pkg, PLAN_FILE))).toBe(false);
  calls = [];
  await expect(runPlan(["--target", "feature/x"], deps({ failStep: "start" }))).rejects.toThrow(/`review start` failed/);
});

test("--memory-query and --unattended reach `review start` as given (start keeps its own terminal gate for --unattended)", async () => {
  await runPlan(["--target", "feature/x", "--ref", "origin/main", "--memory-query", "review rounds", "--unattended"], deps({ slices: [] }));
  expect(calls[0]).toEqual(["start", "--target", "branch", "--ref", "feature/x", "--base", "origin/main", "--memory-query", "review rounds", "--unattended"]);
  expect(PLAN_FLAGS).toEqual(expect.arrayContaining(["--memory-query", "--unattended"]));
});

test("--target is required, unknown flags are refused, --help prints usage and runs nothing", async () => {
  await expect(runPlan([], deps({}))).rejects.toThrow(/needs --target/);
  await expect(runPlan(["--target", "x", "--bogus"], deps({}))).rejects.toThrow(/Unknown option/);
  await runPlan(["--help"], deps({}));
  expect(out.join("\n")).toContain("keryx review plan --target <pr-url|branch>");
  expect(calls).toEqual([]);
  expect(PLAN_FLAGS).toContain("--head");
});

test("small readers: target kind, the package path of start's output, slices by kind", () => {
  expect(targetKindOf("https://github.com/o/r/pull/12")).toBe("pr");
  expect(targetKindOf("o/r#12")).toBe("pr");
  expect(targetKindOf("12")).toBe("pr");
  expect(targetKindOf("feat/review-delta-rounds")).toBe("branch");
  expect(packagePathOf("a\npath: .metaproject/reviews/r2\nb", root)).toBe(path.join(root, ".metaproject/reviews/r2"));
  expect(packagePathOf("nothing", root)).toBeUndefined();
  expect(slicesByKind({ slices: SPLIT as never }).fix.length).toBe(1);
  expect(slicesByKind({ slices: [{ ...(SPLIT[1] as object), retryOf: ["slice-02"] }] as never })).toEqual({ fix: [], new: [] });
});

test("review plan has its own help entry", () => {
  printReviewHelpFor(["plan"]);
  expect(out.join("\n")).toContain("keryx review plan --target");
});

// Flow 460 (G, AC6): one quote the locator cannot place used to refuse the whole round, so no round was recorded and the
// next `review plan` found no previous round. Real steps end to end: plan → ingest with an unplaceable quote → fix → plan.
describe("plan → ingest with an unplaceable quote → fix commit → plan", () => {
  const ORIGINAL_CWD = process.cwd();
  const EMAIL = "200531777+MrCipherSmith@users.noreply.github.com";
  const realError = console.error;
  const realXdg = process.env.XDG_DATA_HOME;
  let repo = "";

  const git = (...args: string[]): string => {
    const run = Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: EMAIL, GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: EMAIL } });
    if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
    return run.stdout.toString().trim();
  };
  const source = (fixed: boolean): string =>
    [
      ...Array.from({ length: 12 }, (_, i) => `export const base${i} = ${i};`),
      "export function total(items: number[]): number {",
      fixed ? "  return items.reduce((sum, item) => sum + item, 0);" : "  return items.reduce((sum, item) => sum + item);",
      "}",
      "",
    ].join("\n");
  const finding = (id: string, quote: string) => ({ id, reviewer: "review-logic", severity: "minor", file: "src/a.ts", line: 14, quote, problem: `problem ${id}`, impact: "wrong total", suggested_fix: "seed the reduce", evidence: "read the function", confidence: "high" });

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "keryx-plan-e2e-"));
    process.env.XDG_DATA_HOME = path.join(repo, ".xdg");
    await mkdir(path.join(repo, ".metaproject"), { recursive: true });
    await mkdir(path.join(repo, "src"), { recursive: true });
    git("init", "-q", "-b", "main");
    await writeFile(path.join(repo, "src", "a.ts"), Array.from({ length: 12 }, (_, i) => `export const base${i} = ${i};`).join("\n") + "\n");
    git("add", "src/a.ts");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    await writeFile(path.join(repo, "src", "a.ts"), source(false));
    git("add", "src/a.ts");
    git("commit", "-q", "-m", "add total");
    process.chdir(repo);
    console.log = () => {};
    console.error = () => {};
    process.exitCode = 0;
  });
  afterEach(async () => {
    console.log = realLog;
    console.error = realError;
    process.exitCode = 0;
    process.chdir(ORIGINAL_CWD);
    if (realXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = realXdg;
    await rm(repo, { recursive: true, force: true });
  });

  const plan = async (): Promise<ReviewPlan> => {
    await reviewCommand(["plan", "--target", "feature", "--ref", "main", "--json"]);
    expect(process.exitCode ?? 0).toBe(0);
    const latest = (await readdir(path.join(repo, ".metaproject", "reviews"))).filter((name) => existsSync(path.join(repo, ".metaproject", "reviews", name, PLAN_FILE))).sort();
    const found = await Promise.all(latest.map(async (name) => JSON.parse(await readFile(path.join(repo, ".metaproject", "reviews", name, PLAN_FILE), "utf8")) as ReviewPlan));
    return found.sort((a, b) => a.round.number - b.round.number)[found.length - 1]!;
  };

  test("the round with the unplaced quote is recorded, and the plan after the fix is a delta round with a fix slice for the finding", async () => {
    const first = await plan();
    expect(first.round.mode).toBe("first");
    const firstId = path.basename(first.package);

    const report = ["# Round 1", "", "```json keryx:findings", JSON.stringify([finding("F-1", "  return items.reduce((sum, item) => sum + item);"), finding("F-2", "  return items.total();")]), "```", ""].join("\n");
    await writeFile(path.join(repo, "report.md"), report);
    await writeFile(path.join(repo, "research.json"), JSON.stringify({ version: 1, scopeReviewed: true, rawReconciled: true, obligations: [] }));
    await reviewCommand(["ingest", "--target", "branch", "--ref", "feature", "--review-id", firstId, "--report", "report.md", "--research", "research.json"]);
    expect(process.exitCode ?? 0).toBe(0);
    const recorded = JSON.parse(await readFile(path.join(first.package, "findings.json"), "utf8")) as Array<Record<string, unknown>>;
    const byId = Object.fromEntries(recorded.map((entry) => [entry.id, entry]));
    expect(byId["F-1"]).toMatchObject({ line: 14, locator: { state: "derived" } });
    expect(byId["F-2"]).toMatchObject({ line: null, quote_unlocated: { reason: "absent" } });
    expect(await readFile(path.join(first.package, "scope.md"), "utf8")).toContain("## Quotes not located at the reviewed head");
    expect((await computeReadiness(first.package)).items.find((item) => item.id === "quotes-located")).toMatchObject({ status: "fail" });

    await writeFile(path.join(repo, "src", "a.ts"), source(true));
    git("add", "src/a.ts");
    git("commit", "-q", "-m", "fix F-1: seed the reduce");

    const second = await plan();
    expect(second.package).not.toBe(first.package);
    expect(second.round).toMatchObject({ number: 2, mode: "delta", previous: firstId });
    expect(second.round.fixHunks).toBeGreaterThan(0);
    expect(second.slices.fix.length).toBeGreaterThan(0);
    const fix = second.slices.fix.find((slice) => slice.findingIds?.includes("F-1"));
    expect(fix?.files).toContain("src/a.ts");
    expect(fix?.roles).toEqual(expect.arrayContaining(["review-logic", "review-regression"]));
  }, 60_000);
});
