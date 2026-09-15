// `flow renumber` must take the flow's review record with it.
//
// Flow 256, finding R4-001: renumbering `252-…` to `256-…` moved the managed
// review packages along with the directory, and every one of them went on saying
// `flow: 252`, with six artifact paths into a directory that no longer existed.
// Nothing failed — the review gate lists the directory, so it still found the
// rounds — which is exactly why it went unnoticed until the rounds were
// re-ingested for an unrelated reason.
//
// Driven through `flowCommand` and `reviewCommand` for the reason
// `review-gate.e2e.test.ts` gives: the package under test is the one the real
// ingest writes, not a fixture that already has the right shape.

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { flowCommand, flowServiceDeps } from "../commands/flow";
import { reviewCommand } from "../commands/review";
import { readFlowReviewRounds } from "../review/loop";
import { reviewNotesDir } from "../review/review-notes";
import type { ManagedReviewManifest, StructuredReviewFinding } from "../review/types";
import { readReviewRounds, runReviewGate } from "./review-gate";
import { createFlowService } from "./service";
import { readFlow } from "./store";

const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
const realError = console.error;
const FLOWS = path.join(".metaproject", "flows");

let ROOT = "";
let logs: string[] = [];

function output(): string {
  return logs.join("\n").replace(/\[[0-9;]*m/g, "");
}

async function enter(): Promise<string> {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-renumber-reviews-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  process.chdir(ROOT);
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  return ROOT;
}

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

async function onlyFlowDir(): Promise<string> {
  const dirs = (await readdir(path.join(ROOT, FLOWS), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const [dir] = dirs;
  if (dir === undefined || dirs.length !== 1) {
    throw new Error(`expected one flow package, found: ${dirs.join(", ")}`);
  }
  return dir;
}

/** One round, attached with `--flow 001`, holding one finding about a file in the flow itself. */
async function ingestRound(fromDir: string, flowId = "001", reviewId = "round-1"): Promise<void> {
  const planPath = `.metaproject/flows/${fromDir}/plan.md`;
  const results = [
    {
      status: "DONE_WITH_CONCERNS",
      reviewer: "review-logic",
      summary: "one minor in the plan",
      findings: [
        {
          id: "F-001",
          severity: "minor",
          file: planPath,
          line: 3,
          problem: "the plan names no rollback step",
          impact: "a failed rollout has no written way back",
          suggested_fix: "add a rollback step to the plan",
          evidence: `read ${planPath} end to end; no step mentions rollback`,
          confidence: "medium",
        },
      ],
      stats: { blocker: 0, major: 0, minor: 1, info: 0 },
    },
  ];
  await writeFile(
    path.join(ROOT, "round.md"),
    ["# Round 1", "", "```json keryx:findings", JSON.stringify(results, null, 2), "```", ""].join("\n"),
    "utf8",
  );
  await reviewCommand([
    "ingest",
    "--report",
    "round.md",
    "--ref",
    "round.md",
    "--flow",
    flowId,
    "--review-id",
    reviewId,
    "--reviewers",
    "review-logic",
  ]);
}

async function readManifest(flowDir: string, reviewId = "round-1"): Promise<ManagedReviewManifest> {
  return JSON.parse(
    await readFile(path.join(ROOT, FLOWS, flowDir, "reviews", reviewId, "manifest.json"), "utf8"),
  ) as ManagedReviewManifest;
}

/** What `flow renumber` did before it rewrote review records: move the directory, record the move, nothing else. */
async function legacyRenumber(fromDir: string, to: string): Promise<string> {
  const toDir = `${to}${fromDir.slice(3)}`;
  await rename(path.join(ROOT, FLOWS, fromDir), path.join(ROOT, FLOWS, toDir));
  const mapFile = path.join(ROOT, FLOWS, "id-map.json");
  const entries = (await Bun.file(mapFile).exists()) ? (JSON.parse(await readFile(mapFile, "utf8")) as unknown[]) : [];
  entries.push({ from: fromDir.slice(0, 3), to, fromDir, toDir, at: new Date().toISOString(), reason: "legacy move" });
  await writeFile(mapFile, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  return toDir;
}

test("renumber re-points an ingested round at the new id, and the gate and `keryx review` still read it", async () => {
  await enter();
  await flowCommand(["init", "--title", "renumber probe"]);
  const fromDir = await onlyFlowDir();
  const oldPlan = `.metaproject/flows/${fromDir}/plan.md`;
  await ingestRound(fromDir);
  expect((await readManifest(fromDir)).flow).toEqual({ id: "001", path: `.metaproject/flows/${fromDir}` });

  // A review note pointing back at the round. Hand-written because producing
  // one needs an attested `dismissed-incorrect`; the shape is `renderReviewNote`'s.
  const note = path.join(reviewNotesDir(ROOT), "round-1__F-001.md");
  await mkdir(path.dirname(note), { recursive: true });
  await writeFile(
    note,
    `- Location: \`${oldPlan}\`:3\n- Link: .metaproject/flows/${fromDir}/reviews/round-1\n`,
    "utf8",
  );

  await flowCommand(["renumber", fromDir, "--to", "007", "--reason", "collided with a parallel branch"]);
  const toDir = `007${fromDir.slice(3)}`;
  const pkg = path.join(ROOT, FLOWS, toDir, "reviews", "round-1");
  expect(await Bun.file(path.join(ROOT, FLOWS, fromDir, "flow.json")).exists()).toBe(false);
  expect(output()).toContain("review record(s) re-pointed at flow 007");
  expect(output()).toContain(path.relative(ROOT, note));

  // The records name the new id, and every path they hold resolves.
  const manifest = await readManifest(toDir);
  expect(manifest.flow).toEqual({ id: "007", path: `.metaproject/flows/${toDir}` });
  for (const artifact of Object.values(manifest.artifacts)) {
    expect(artifact.startsWith(`.metaproject/flows/${toDir}/reviews/round-1/`)).toBe(true);
    expect(await Bun.file(path.join(ROOT, artifact)).exists()).toBe(true);
  }
  const scope = await readFile(path.join(pkg, "scope.md"), "utf8");
  expect(scope).toMatch(/^flow: 007 \(explicit-flow-id\)$/m);
  expect(scope).not.toMatch(/^flow: 001/m);
  const [finding] = JSON.parse(await readFile(path.join(pkg, "findings.json"), "utf8")) as StructuredReviewFinding[];
  expect(finding?.file).toBe(`.metaproject/flows/${toDir}/plan.md`);
  // A path quoted inside prose is what the reviewer saw, not a record of where the flow lives.
  expect(finding?.evidence).toContain(oldPlan);
  expect(await readFile(note, "utf8")).toBe(
    `- Location: \`.metaproject/flows/${toDir}/plan.md\`:3\n- Link: .metaproject/flows/${toDir}/reviews/round-1\n`,
  );

  // The review gate finds and reads the round under the new id.
  const flow = await readFlow(ROOT, toDir);
  expect(flow.id).toBe("007");
  const [round] = await readReviewRounds(ROOT, toDir);
  expect(round?.ingested).toBe(true);
  expect(round?.findings[0]?.file).toBe(`.metaproject/flows/${toDir}/plan.md`);
  const verdict = await runReviewGate({ cwd: ROOT, flowDir: toDir, flow, tracker: null });
  expect(verdict.roundsSeen).toBe(1);
  expect(verdict.ingestedRounds).toBe(1);
  const ingested = verdict.conditions.find((condition) => condition.id === "ingested-round");
  expect(ingested?.status).toBe("pass");
  expect(ingested?.detail).toContain("round-1");
  expect(verdict.conditions.find((condition) => condition.id === "terminal-dispositions")?.detail).toContain(
    "round-1#F-001",
  );

  // `keryx review` finds it by review id and by flow id.
  logs = [];
  await reviewCommand(["status", "round-1"]);
  expect(output()).toContain("# managed review: round-1");
  expect(output()).toContain("flow: 007");
  expect((await readFlowReviewRounds(ROOT, "007")).map((item) => item.label)).toEqual(["round-1"]);
  logs = [];
  // The loop detector reports counts rather than labels; `rounds_seen: 1` is it
  // having resolved flow 007 and read the round that used to be flow 001's.
  await reviewCommand(["loop", "--flow", "007"]);
  expect(output()).toContain("rounds_seen: 1");
});

test("a renumber whose move fails leaves every review record as it was", async () => {
  await enter();
  await flowCommand(["init", "--title", "renumber probe"]);
  const fromDir = await onlyFlowDir();
  await ingestRound(fromDir);
  const pkg = path.join(ROOT, FLOWS, fromDir, "reviews", "round-1");
  const files = ["manifest.json", "scope.md", "findings.json"];
  const before = await Promise.all(files.map((file) => readFile(path.join(pkg, file), "utf8")));

  // A FILE where the directory would go: invisible to the taken-id check, which
  // lists directories only, and fatal to the rename — after the records were
  // already rewritten for the new id.
  await writeFile(path.join(ROOT, FLOWS, `007${fromDir.slice(3)}`), "in the way\n", "utf8");
  await expect(
    createFlowService(flowServiceDeps()).renumber({ cwd: ROOT, ref: fromDir, to: "007", reason: "blocked move" }),
  ).rejects.toThrow();

  expect(await Promise.all(files.map((file) => readFile(path.join(pkg, file), "utf8")))).toEqual(before);
  expect((await readFlow(ROOT, fromDir)).id).toBe("001");
});

// Flows renumbered before the rewrite existed still hold the old id. In this
// repository: flow 223's rounds said 222, flow 224's said 202.
test("repair-reviews re-points rounds left behind by renumbers that predate the rewrite, across a chain of moves", async () => {
  await enter();
  await flowCommand(["init", "--title", "renumber probe"]);
  const firstDir = await onlyFlowDir();
  const oldPlan = `.metaproject/flows/${firstDir}/plan.md`;
  await ingestRound(firstDir);
  const note = path.join(reviewNotesDir(ROOT), "round-1__F-001.md");
  await mkdir(path.dirname(note), { recursive: true });
  await writeFile(note, `- Link: .metaproject/flows/${firstDir}/reviews/round-1\n`, "utf8");

  const middleDir = await legacyRenumber(firstDir, "007");
  const finalDir = await legacyRenumber(middleDir, "009");
  // The state the repair exists for: still flow 001, pointing at a directory that is gone.
  expect((await readManifest(finalDir)).flow).toEqual({ id: "001", path: `.metaproject/flows/${firstDir}` });

  await flowCommand(["repair-reviews"]);
  expect(output()).toContain("review record(s) re-pointed at their flow's current id");

  const manifest = await readManifest(finalDir);
  expect(manifest.flow).toEqual({ id: "009", path: `.metaproject/flows/${finalDir}` });
  for (const artifact of Object.values(manifest.artifacts)) {
    expect(await Bun.file(path.join(ROOT, artifact)).exists()).toBe(true);
  }
  const pkg = path.join(ROOT, FLOWS, finalDir, "reviews", "round-1");
  expect(await readFile(path.join(pkg, "scope.md"), "utf8")).toMatch(/^flow: 009 \(explicit-flow-id\)$/m);
  const [finding] = JSON.parse(await readFile(path.join(pkg, "findings.json"), "utf8")) as StructuredReviewFinding[];
  expect(finding?.file).toBe(`.metaproject/flows/${finalDir}/plan.md`);
  expect(finding?.evidence).toContain(oldPlan);
  expect(await readFile(note, "utf8")).toBe(`- Link: .metaproject/flows/${finalDir}/reviews/round-1\n`);

  logs = [];
  await flowCommand(["repair-reviews"]);
  expect(output()).toContain("already name its current id");
});

test("repair-reviews follows each flow by directory when one number left twice", async () => {
  await enter();
  await flowCommand(["init", "--title", "first probe"]);
  const aDir = await onlyFlowDir();
  await ingestRound(aDir, "001", "round-a");
  await flowCommand(["init", "--title", "second probe"]);
  const bDir = (await readdir(path.join(ROOT, FLOWS), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== aDir)
    .map((entry) => entry.name)[0];
  if (bDir === undefined) {
    throw new Error("second flow package missing");
  }
  await ingestRound(bDir, bDir.slice(0, 3), "round-b");

  const aFinal = await legacyRenumber(aDir, "005");
  // Flow B takes the number flow A left, then moves on: `001` leaves twice, for two different flows.
  const bMiddle = await legacyRenumber(bDir, "001");
  const bFinal = await legacyRenumber(bMiddle, "006");

  await flowCommand(["repair-reviews"]);
  expect((await readManifest(aFinal, "round-a")).flow).toEqual({ id: "005", path: `.metaproject/flows/${aFinal}` });
  expect((await readManifest(bFinal, "round-b")).flow).toEqual({ id: "006", path: `.metaproject/flows/${bFinal}` });
});
