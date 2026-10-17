// Flow 460 (G, AC6): one quote the locator cannot place used to refuse the whole round, so no round was recorded and the
// next `review plan` found no previous round. Real steps end to end, in a real git repository (hence the e2e tier, apart
// from review-plan.test.ts, whose steps are faked): plan → ingest with an unplaceable quote → fix commit → plan. The
// ambiguous-quote branch is pinned at the ingest level (src/review/ingest-locator-sha.test.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PLAN_FILE, type ReviewPlan } from "./review-plan";
import { reviewCommand } from "./review";
import { computeReadiness } from "../review/readiness";

describe("plan → ingest with an unplaceable quote → fix commit → plan", () => {
  const ORIGINAL_CWD = process.cwd();
  const EMAIL = "200531777+MrCipherSmith@users.noreply.github.com";
  const realLog = console.log;
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

  /** Runs `review plan` and returns the plan of the newest round (the highest round number among packages with a plan). */
  const plan = async (): Promise<ReviewPlan> => {
    await reviewCommand(["plan", "--target", "feature", "--ref", "main", "--json"]);
    expect(process.exitCode ?? 0).toBe(0);
    const reviewsDir = path.join(repo, ".metaproject", "reviews");
    const planned = (await readdir(reviewsDir)).filter((name) => existsSync(path.join(reviewsDir, name, PLAN_FILE)));
    const plans = await Promise.all(planned.map(async (name) => JSON.parse(await readFile(path.join(reviewsDir, name, PLAN_FILE), "utf8")) as ReviewPlan));
    return plans.reduce((newest, candidate) => (candidate.round.number > newest.round.number ? candidate : newest));
  };

  test("the round with the unplaced quote is recorded, and the plan after the fix is a delta round with a fix slice for the finding", async () => {
    const first = await plan();
    expect(first.round.mode).toBe("first");
    // `plan --ref main` starts the round with `--base main`, which the target records: the coverage gate's light recheck
    // diffs against it before any default branch.
    expect(JSON.parse(await readFile(path.join(first.package, "manifest.json"), "utf8")).target.base).toBe("main");
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

  test("flow 460 L6: a fix of F-1 and an unrelated new function in the same file plan as one fix slice with the fix roster and one new slice with round-1 roles", async () => {
    const first = await plan();
    const firstId = path.basename(first.package);
    const report = ["# Round 1", "", "```json keryx:findings", JSON.stringify([finding("F-1", "  return items.reduce((sum, item) => sum + item);")]), "```", ""].join("\n");
    await writeFile(path.join(repo, "report.md"), report);
    await writeFile(path.join(repo, "research.json"), JSON.stringify({ version: 1, scopeReviewed: true, rawReconciled: true, obligations: [] }));
    await reviewCommand(["ingest", "--target", "branch", "--ref", "feature", "--review-id", firstId, "--report", "report.md", "--research", "research.json"]);
    expect(process.exitCode ?? 0).toBe(0);

    await writeFile(path.join(repo, "src", "a.ts"), source(true));
    git("add", "src/a.ts");
    git("commit", "-q", "-m", "fix F-1: seed the reduce");
    // Far below the fix, in its own commit that names no finding: new code.
    const padding = Array.from({ length: 40 }, (_, i) => `export const pad${i} = ${i};`).join("\n");
    await writeFile(path.join(repo, "src", "a.ts"), `${source(true)}${padding}\nexport function run(cmd: string[]) { return Bun.spawn(cmd); }\n`);
    git("add", "src/a.ts");
    git("commit", "-q", "-m", "add a runner");

    const second = await plan();
    expect(second.round).toMatchObject({ number: 2, mode: "delta" });
    expect(second.slices.fix).toHaveLength(1);
    // Exactly the fix roster: logic and regression (F-1's author is review-logic); nothing the fix's content would route.
    expect(second.slices.fix[0]).toMatchObject({ files: ["src/a.ts"], findingIds: ["F-1"], roles: ["review-logic", "review-regression"] });
    // The runner, in the same file, is a new slice routed as in round 1: spawning a process brings security-code.
    const fresh = second.slices.new.filter((slice) => slice.files.includes("src/a.ts"));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.roles).toEqual(expect.arrayContaining(["review-logic", "review-security-code"]));
    // The fix slice's roster joins the round; nothing its content routes does (no union with round-1 routing).
    expect(second.split?.fix).toMatchObject({ slices: 1, dispatches: 2 });
    expect(second.dispatches).toBeLessThanOrEqual(40);
  }, 60_000);
});
