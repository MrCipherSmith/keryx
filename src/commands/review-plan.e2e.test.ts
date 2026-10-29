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
import { DEFAULT_MAX_DISPATCHES } from "../review/estimate";
import { commitFiles, git, initRepo } from "../review/git-fixture.test-helpers";
import { computeReadiness } from "../review/readiness";

/** A child dispatch of `review plan` runs real git in a real repository: a minute is the ceiling, not the expectation. */
const E2E_TIMEOUT_MS = 60_000;

describe("plan → ingest with an unplaceable quote → fix commit → plan", () => {
  const ORIGINAL_CWD = process.cwd();
  const realLog = console.log;
  const realError = console.error;
  const realXdg = process.env.XDG_DATA_HOME;
  let repo = "";

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
    initRepo(repo);
    commitFiles(repo, { "src/a.ts": Array.from({ length: 12 }, (_, i) => `export const base${i} = ${i};`).join("\n") + "\n" }, "base");
    git(repo, "checkout", "-q", "-b", "feature");
    commitFiles(repo, { "src/a.ts": source(false) }, "add total");
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

    commitFiles(repo, { "src/a.ts": source(true) }, "fix F-1: seed the reduce");

    const second = await plan();
    expect(second.package).not.toBe(first.package);
    expect(second.round).toMatchObject({ number: 2, mode: "delta", previous: firstId });
    expect(second.round.fixHunks).toBeGreaterThan(0);
    expect(second.slices.fix.length).toBeGreaterThan(0);
    const fix = second.slices.fix.find((slice) => slice.findingIds?.includes("F-1"));
    expect(fix?.files).toContain("src/a.ts");
    expect(fix?.roles).toEqual(expect.arrayContaining(["review-logic", "review-regression"]));
  }, E2E_TIMEOUT_MS);

  /** Round 1 over `source(false)` + 40 unchanged lines, F-1 recorded on the reduce; returns once the round is ingested. */
  const PADDING = `${Array.from({ length: 40 }, (_, i) => `export const pad${i} = ${i};`).join("\n")}\n`;
  const recordRoundOne = async (): Promise<ReviewPlan> => {
    commitFiles(repo, { "src/a.ts": `${source(false)}${PADDING}` }, "pad the module");
    const first = await plan();
    const report = ["# Round 1", "", "```json keryx:findings", JSON.stringify([finding("F-1", "  return items.reduce((sum, item) => sum + item);")]), "```", ""].join("\n");
    await writeFile(path.join(repo, "report.md"), report);
    await writeFile(path.join(repo, "research.json"), JSON.stringify({ version: 1, scopeReviewed: true, rawReconciled: true, obligations: [] }));
    await reviewCommand(["ingest", "--target", "branch", "--ref", "feature", "--review-id", path.basename(first.package), "--report", "report.md", "--research", "research.json"]);
    expect(process.exitCode ?? 0).toBe(0);
    return first;
  };
  /** The driver files `review slice --package` wrote, by role. */
  const driverRolesOf = async (packageDir: string): Promise<{ files: string[]; roles: Set<string> }> => {
    const files = (await readdir(path.join(packageDir, "drivers"))).filter((name) => /-w\d+\.json$/.test(name));
    return { files, roles: new Set(files.map((name) => name.replace(/-w\d+\.json$/, ""))) };
  };

  test("flow 460 L6: a fix of F-1 and an unrelated new function in the same file plan as one fix slice with the fix roster and one new slice with round-1 roles", async () => {
    await recordRoundOne();
    commitFiles(repo, { "src/a.ts": `${source(true)}${PADDING}` }, "fix F-1: seed the reduce");
    // Forty unchanged lines below the fix, in its own commit that names no finding: new code.
    commitFiles(repo, { "src/a.ts": `${source(true)}${PADDING}export function run(cmd: string[]) { return Bun.spawn(cmd); }\n` }, "add a runner");

    const second = await plan();
    expect(second.round).toMatchObject({ number: 2, mode: "delta" });
    expect(second.slices.fix).toHaveLength(1);
    // The fix roster: logic and regression (F-1's author is review-logic) plus the degradation reviewer, which any
    // source-code fix region owes (flow 479); the deep round-1 roster of the file is not owed.
    expect(second.slices.fix[0]).toMatchObject({ files: ["src/a.ts"], findingIds: ["F-1"], roles: ["review-degradation", "review-logic", "review-regression"] });
    // The runner, in the same file, is a new slice routed as in round 1: spawning a process brings security-code.
    const fresh = second.slices.new.filter((slice) => slice.files.includes("src/a.ts"));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.roles).toEqual(expect.arrayContaining(["review-logic", "review-security-code"]));
    // The fix slice's roster joins the round; the deep round-1 roster of its file does not.
    expect(second.split?.fix).toMatchObject({ slices: 1, dispatches: 3 });
    expect(second.dispatches).toBeLessThanOrEqual(DEFAULT_MAX_DISPATCHES);
    // The drivers `review slice --package` wrote are exactly the dispatches the plan counts, all for roster roles: the new
    // slice's deep routing names review-backend and review-frontend, which this roster never runs.
    const drivers = await driverRolesOf(second.package);
    expect(drivers.files).toHaveLength(second.dispatches);
    const rosterRoles = new Set([...second.roster, ...second.slices.fix.flatMap((slice) => slice.roles ?? [])]);
    expect([...drivers.roles].filter((role) => !rosterRoles.has(role))).toEqual([]);
  }, E2E_TIMEOUT_MS);

  test("flow 458 M3: a fix whose own line spawns a process keeps review-security-code on the fix slice and in the drivers", async () => {
    await recordRoundOne();
    const spawning = source(true).replace("  return items.reduce((sum, item) => sum + item, 0);", "  return Bun.spawnSync([\"true\"]).exitCode + items.reduce((sum, item) => sum + item, 0);");
    commitFiles(repo, { "src/a.ts": `${spawning}${PADDING}` }, "fix F-1: seed the reduce");

    const second = await plan();
    expect(second.slices.fix).toHaveLength(1);
    // F-1 is a logic finding: the security reviewer is there only because the fix line spawns a process.
    expect(second.slices.fix[0]!.roles).toEqual(expect.arrayContaining(["review-logic", "review-regression", "review-security-code"]));
    const drivers = await driverRolesOf(second.package);
    expect(drivers.roles.has("review-security-code")).toBe(true);
    expect(drivers.files).toHaveLength(second.dispatches);
  }, E2E_TIMEOUT_MS);
});
