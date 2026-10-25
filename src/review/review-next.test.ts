// Flow 458 AC12: `keryx review next` answers for the whole package at once, with retry-plan's logic per reviewer.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import { CONTINUE_LINE, renderNext, reviewNext } from "./review-next";
import { estimatePackage, planConfirmationFor, writePlanConfirmation } from "./estimate";
import { buildRunProfile, writeRunProfile } from "./run-profile";

const ORIGINAL_CWD = process.cwd();
const realError = console.error;
const realLog = console.log;
let root = "";
let pkg = "";
let logs: string[] = [];
let errors: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "gd-review-next-"));
  pkg = path.join(root, ".metaproject", "reviews", "r1");
  await mkdir(path.join(pkg, "raw"), { recursive: true });
  process.chdir(root);
  logs = [];
  errors = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  process.exitCode = 0;
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.exitCode = 0;
  process.chdir(ORIGINAL_CWD);
  await rm(root, { recursive: true, force: true });
});

function gitFile(filePath: string, count: number): string {
  const lines = Array.from({ length: count }, (_, n) => `+export const v${n} = ${n};`);
  return `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1,0 +1,${count} @@\n${lines.join("\n")}\n`;
}

/** A package with `files` sliced at `maxBytes`; returns the manifest's slice ids. */
async function slicePackage(files: Record<string, number>, maxBytes = 30000, waveBytes?: number): Promise<string[]> {
  await writeFile(path.join(root, "change.diff"), Object.entries(files).map(([name, count]) => gitFile(name, count)).join(""), "utf8");
  await reviewCommand(["slice", "--diff", "change.diff", "--max-bytes", String(maxBytes), ...(waveBytes === undefined ? [] : ["--wave-bytes", String(waveBytes)]), "--package", pkg]);
  expect(process.exitCode).toBe(0);
  logs = [];
  const manifest = JSON.parse(await readFile(path.join(pkg, "slices", "manifest.json"), "utf8")) as { slices: Array<{ id: string }> };
  return manifest.slices.map((s) => s.id);
}

const reply = (body: unknown, prose = "Review finished.") => `${prose}\n\nREVIEW_RESULT: ${JSON.stringify(body)}\n`;

test("slice --package writes one driver per reviewer x wave with absolute slice paths and slice ids", async () => {
  const ids = await slicePackage({ "src/m/a.ts": 40 });
  const drivers = (await readdir(path.join(pkg, "drivers"))).filter((name) => /-w\d+\.json$/.test(name));
  expect(drivers).toContain("review-logic-w1.json");
  const driver = JSON.parse(await readFile(path.join(pkg, "drivers", "review-logic-w1.json"), "utf8"));
  expect(driver).toMatchObject({ reviewer: "review-logic", wave: 1, slices: ids, result: "raw/review-logic-w1.txt" });
  expect(driver.slicePaths).toHaveLength(ids.length);
  for (const entry of driver.slicePaths as Array<{ id: string; path: string }>) {
    expect(path.isAbsolute(entry.path)).toBe(true);
    expect(existsSync(entry.path)).toBe(true);
  }
});

test("slice --package splits a reviewer's slices into waves, one driver each, and drivers of an older cut are replaced", async () => {
  await slicePackage({ "src/m/a.ts": 400, "src/m/b.ts": 400, "src/m/c.ts": 400 }, 4000, 4000);
  const first = (await readdir(path.join(pkg, "drivers"))).filter((name) => name.startsWith("review-logic-w"));
  expect(first.length).toBeGreaterThan(1);
  await writeFile(path.join(pkg, "drivers", "review-logic-w1.json"), JSON.stringify({ reviewer: "review-logic", model: "opus", slices: ["x"], result: "raw/review-logic-w1.txt" }));
  await writeFile(path.join(pkg, "drivers", "review-logic-w9.json"), JSON.stringify({ reviewer: "review-logic", slices: ["stale"] }));
  await slicePackage({ "src/m/a.ts": 40 });
  const after = (await readdir(path.join(pkg, "drivers"))).filter((name) => name.startsWith("review-logic-w"));
  expect(after).toEqual(["review-logic-w1.json"]);
  // The model the dispatcher recorded in the driver of the same name is kept.
  expect(JSON.parse(await readFile(path.join(pkg, "drivers", "review-logic-w1.json"), "utf8")).model).toBe("opus");
});

test("with nothing returned every reviewer is owed its slices (missing), the model hint is echoed, and nothing is written", async () => {
  const ids = await slicePackage({ "src/m/a.ts": 40 });
  const driverPath = path.join(pkg, "drivers", "review-logic-w1.json");
  const driver = JSON.parse(await readFile(driverPath, "utf8"));
  await writeFile(driverPath, JSON.stringify({ ...driver, model: "sonnet" }));
  const before = await readdir(path.join(pkg, "slices"));
  const next = await reviewNext({ packageDir: pkg, reviewers: ["review-logic", "review-style"] });
  expect(next.done).toBe(false);
  const logic = next.dispatches.find((entry) => entry.reviewer === "review-logic")!;
  expect(logic).toMatchObject({ reason: "missing", wave: 1, slices: ids, model: "sonnet", result: "raw/review-logic-w1.txt", driver: "drivers/review-logic-w1.json" });
  expect(logic.paths.every((file) => path.isAbsolute(file) && existsSync(file))).toBe(true);
  expect(next.dispatches.find((entry) => entry.reviewer === "review-style")?.reason).toBe("missing");
  expect(await readdir(path.join(pkg, "slices"))).toEqual(before);
  expect(existsSync(path.join(pkg, "slices", "retry-state.json"))).toBe(false);
  expect(renderNext(next)).toContain("model: sonnet");
  expect(renderNext(next)).toContain("model: model not recorded");
});

test("done once every reviewer's finished result covers its slices, whatever shape the reply took", async () => {
  const ids = await slicePackage({ "src/m/a.ts": 40 });
  await writeFile(path.join(pkg, "raw", "review-logic-w1.txt"), reply({ reviewer: "review-logic", status: "DONE", slices: ids }));
  // A fenced block, a wrapper key and prose around it: the lenient reader.
  await writeFile(path.join(pkg, "raw", "review-style-w1.txt"), `All good.\n\`\`\`json\n${JSON.stringify({ result: { reviewer: "review-style", status: "DONE", slices: ids, findings: [] } })}\n\`\`\`\nBye.`);
  const next = await reviewNext({ packageDir: pkg, reviewers: ["review-logic", "review-style"] });
  expect(next).toMatchObject({ done: true, dispatches: [], notRun: [], blocked: [] });
  expect(renderNext(next)).toContain("done — nothing is left to dispatch");
});

test("a reviewer that finished only some of its waves is owed the rest; a list of per-wave results is merged", async () => {
  await slicePackage({ "src/m/a.ts": 400, "src/m/b.ts": 400, "src/m/c.ts": 400 }, 4000, 4000);
  const manifest = JSON.parse(await readFile(path.join(pkg, "slices", "manifest.json"), "utf8")) as { slices: Array<{ id: string }> };
  const ids = manifest.slices.map((s) => s.id);
  expect(ids.length).toBeGreaterThan(2);
  await writeFile(path.join(pkg, "raw", "review-logic-w1.txt"), reply({ reviewer: "review-logic", status: "DONE", slices: ids.slice(0, 1) }));
  const partial = await reviewNext({ packageDir: pkg, reviewers: ["review-logic"] });
  expect(partial.done).toBe(false);
  expect(partial.dispatches).toHaveLength(1);
  expect(partial.dispatches[0]!.slices).not.toContain(ids[0]);
  // The agent returns every wave at once as a list.
  const waves = ids.map((id) => ({ reviewer: "review-logic", status: "DONE", slices: [id] }));
  await writeFile(path.join(pkg, "raw", "review-logic-w1.txt"), JSON.stringify(waves));
  expect((await reviewNext({ packageDir: pkg, reviewers: ["review-logic"] })).done).toBe(true);
});

test("polling again changes nothing: a stalled reviewer is re-cut once with --apply, and the same reply is not counted twice", async () => {
  const ids = await slicePackage({ "src/m/a.ts": 400 }, 4000, 4000);
  await writeFile(path.join(pkg, "raw", "review-logic-w1.txt"), reply({ reviewer: "review-logic", status: "INCOMPLETE", slices: [] }));
  const first = await reviewNext({ packageDir: pkg, reviewers: ["review-logic"] });
  const second = await reviewNext({ packageDir: pkg, reviewers: ["review-logic"] });
  expect(second).toEqual(first);
  expect(first.dispatches[0]).toMatchObject({ reviewer: "review-logic", reason: "stalled", needsApply: true });
  expect(first.dispatches[0]!.recut).toBeGreaterThan(0);
  expect(first.dispatches[0]!.slices.every((id) => !ids.includes(id))).toBe(true);
  expect(existsSync(path.join(pkg, "slices", "retry-state.json"))).toBe(false);

  const applied = await reviewNext({ packageDir: pkg, reviewers: ["review-logic"], apply: true });
  expect(applied.dispatches[0]).not.toHaveProperty("needsApply");
  for (const file of applied.dispatches[0]!.paths) expect(existsSync(file)).toBe(true);
  const state = JSON.parse(await readFile(path.join(pkg, "slices", "retry-state.json"), "utf8"));
  expect(state.reviewers["review-logic"].attempt).toBe(1);

  // Asking again does not spend another attempt on the reply it already counted.
  const again = await reviewNext({ packageDir: pkg, reviewers: ["review-logic"] });
  for (const id of applied.dispatches[0]!.slices) expect(again.dispatches[0]!.slices).toContain(id);
  expect(again.dispatches[0]!.reason).toBe("retry");
  const stateAfter = JSON.parse(await readFile(path.join(pkg, "slices", "retry-state.json"), "utf8"));
  expect(stateAfter.reviewers["review-logic"].attempt).toBe(1);
});

test("a major finding on a light slice re-opens it deep: the core roles that did not own it are owed it (escalated)", async () => {
  const ids = await slicePackage({ "docs/guide.md": 30 });
  const manifestPath = path.join(pkg, "slices", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { slices: Array<{ id: string; depth?: string; roles?: string[] }> };
  expect(manifest.slices[0]!.depth).toBe("light");
  expect(manifest.slices[0]!.roles).not.toContain("review-architecture");
  await writeFile(path.join(pkg, "raw", "review-logic-w1.txt"), reply({ reviewer: "review-logic", status: "DONE", slices: ids, findings: [{ id: "F-1", severity: "major", file: "docs/guide.md" }] }));
  await writeFile(path.join(pkg, "raw", "review-architecture-w1.txt"), reply({ reviewer: "review-architecture", status: "DONE", slices: [] }));
  const next = await reviewNext({ packageDir: pkg, reviewers: ["review-logic", "review-architecture"] });
  expect(next.escalated).toEqual([{ slice: ids[0]!, finding: "F-1", by: "review-logic" }]);
  const architecture = next.dispatches.find((entry) => entry.reviewer === "review-architecture")!;
  expect(architecture).toMatchObject({ reason: "escalated", slices: ids });
  expect(next.dispatches.some((entry) => entry.reviewer === "review-logic")).toBe(false);
  // Read-only: the manifest still says light until --apply.
  expect((JSON.parse(await readFile(manifestPath, "utf8")) as typeof manifest).slices[0]!.depth).toBe("light");
  await reviewNext({ packageDir: pkg, reviewers: ["review-logic", "review-architecture"], apply: true });
  expect((JSON.parse(await readFile(manifestPath, "utf8")) as typeof manifest).slices[0]!.depth).toBe("deep");
});

test("a reviewer retry-plan marked Not run is listed, not dispatched again", async () => {
  await slicePackage({ "src/m/a.ts": 400 }, 4000, 4000);
  const logicReply = path.join(pkg, "raw", "review-logic-w1.txt");
  const run = async (): Promise<void> => {
    await reviewCommand(["retry-plan", "--manifest", path.join(pkg, "slices", "manifest.json"), "--result", logicReply, "--reviewer", "review-logic", "--json"]);
    logs = [];
  };
  await writeFile(logicReply, reply({ reviewer: "review-logic", status: "BLOCKED", slices: [] }));
  await run();
  await writeFile(logicReply, reply({ reviewer: "review-logic", status: "BLOCKED", slices: [], summary: "again" }));
  await run();
  const next = await reviewNext({ packageDir: pkg, reviewers: ["review-logic"] });
  expect(next.notRun).toHaveLength(1);
  expect(next.dispatches).toEqual([]);
  expect(renderNext(next)).toContain("**Not run:** review-logic");
});

test("the command prints JSON, refuses a package without slices, and a reply it cannot attribute is ignored", async () => {
  await reviewCommand(["next", "--package", pkg]);
  expect(process.exitCode).not.toBe(0);
  expect(errors.join("\n")).toContain("review slice --package");
  process.exitCode = 0;
  logs = [];
  await slicePackage({ "src/m/a.ts": 40 });
  await writeFile(path.join(pkg, "raw", "mystery.txt"), "no result here");
  await reviewCommand(["next", "--package", pkg, "--reviewers", "review-logic", "--json"]);
  const out = JSON.parse(logs.join("\n"));
  expect(out).toMatchObject({ done: false, applied: false });
  expect(out.dispatches[0]).toMatchObject({ reviewer: "review-logic", reason: "missing" });
});

/** Stamps the package as gated (flow 457) and lowers the plan threshold so any plan is over it. */
async function gatePackage(maxDispatches = 1): Promise<void> {
  await writeFile(path.join(pkg, "manifest.json"), JSON.stringify({ operatorGate: 1 }), "utf8");
  await writeRunProfile(pkg, buildRunProfile({ host: "claude-code" }));
  await writeFile(path.join(root, "routing.config.json"), JSON.stringify({ reviewPlan: { maxDispatches } }), "utf8");
}

async function confirmPlan(): Promise<void> {
  await writePlanConfirmation(pkg, planConfirmationFor(await estimatePackage(pkg), "go ahead", "terminal"));
}

test("planAuthorized follows packagePlanGate: confirmed, over the threshold without a card, under it, and a package the gate does not cover", async () => {
  await slicePackage({ "src/m/a.ts": 40 });
  expect(await reviewNext({ packageDir: pkg })).toMatchObject({ planAuthorized: true, continue: true });

  await gatePackage();
  const refused = await reviewNext({ packageDir: pkg });
  expect(refused).toMatchObject({ planAuthorized: false, continue: false });
  expect(refused.dispatches.length).toBeGreaterThan(0);

  await confirmPlan();
  expect(await reviewNext({ packageDir: pkg })).toMatchObject({ planAuthorized: true, continue: true });

  await gatePackage(10_000);
  await rm(path.join(pkg, "plan-confirmation.json"));
  expect(await reviewNext({ packageDir: pkg })).toMatchObject({ planAuthorized: true, continue: true });
});

test("continue needs something to dispatch: a finished package is authorized but does not continue", async () => {
  const ids = await slicePackage({ "src/m/a.ts": 40 });
  const reviewers = ["review-logic"];
  await writeFile(path.join(pkg, "raw", "review-logic-w1.txt"), reply({ reviewer: "review-logic", status: "DONE", slices: ids }));
  const next = await reviewNext({ packageDir: pkg, reviewers });
  expect(next).toMatchObject({ done: true, planAuthorized: true, continue: false });
  expect(renderNext(next)).not.toContain(CONTINUE_LINE);
});

test("continuation line: printed right after the first line only while the plan is authorized and slices are open", async () => {
  await slicePackage({ "src/m/a.ts": 40 });
  const open = renderNext(await reviewNext({ packageDir: pkg })).split("\n");
  expect(open[0]).toStartWith("review next:");
  expect(open[1]).toBe(CONTINUE_LINE);

  await gatePackage();
  expect(renderNext(await reviewNext({ packageDir: pkg }))).not.toContain(CONTINUE_LINE);
  await confirmPlan();
  expect(renderNext(await reviewNext({ packageDir: pkg })).split("\n")[1]).toBe(CONTINUE_LINE);
});

test("continuation line: --json carries the fields and keeps every existing one", async () => {
  await slicePackage({ "src/m/a.ts": 40 });
  await reviewCommand(["next", "--package", pkg, "--reviewers", "review-logic", "--json"]);
  const out = JSON.parse(logs.join("\n"));
  expect(out).toMatchObject({ planAuthorized: true, continue: true, done: false, applied: false, package: pkg });
  for (const key of ["dispatches", "notRun", "blocked", "escalated"]) expect(Array.isArray(out[key])).toBe(true);
  expect(logs.join("\n")).not.toContain(CONTINUE_LINE);
});

test("planAuthorized: plan growth after a major finding on a light slice is not covered by the earlier confirmation", async () => {
  const ids = await slicePackage({ "docs/guide.md": 30 });
  await gatePackage(2);
  await confirmPlan();
  const before = await reviewNext({ packageDir: pkg, reviewers: ["review-logic", "review-architecture"] });
  expect(before.planAuthorized).toBe(true);
  await writeFile(path.join(pkg, "raw", "review-logic-w1.txt"), reply({ reviewer: "review-logic", status: "DONE", slices: ids, findings: [{ id: "F-1", severity: "major", file: "docs/guide.md" }] }));
  await writeFile(path.join(pkg, "raw", "review-architecture-w1.txt"), reply({ reviewer: "review-architecture", status: "DONE", slices: [] }));
  const grown = await reviewNext({ packageDir: pkg, reviewers: ["review-logic", "review-architecture"] });
  expect(grown.escalated).toHaveLength(1);
  expect(grown).toMatchObject({ planAuthorized: false, continue: false });
});

test("gate failure: a gate that cannot be evaluated gives planAuthorized null and does not throw; a malformed confirmation does not fail next", async () => {
  await slicePackage({ "src/m/a.ts": 40 });
  const clean = await reviewNext({ packageDir: pkg });
  await gatePackage();
  await writeFile(path.join(pkg, "plan-confirmation.json"), "{ not json", "utf8");
  const malformed = await reviewNext({ packageDir: pkg });
  expect(malformed.planAuthorized).toBe(false);
  expect(malformed.dispatches).toEqual(clean.dispatches);

  // A manifest the estimate refuses (no wave budget) throws inside the gate: unknown, not refused. The dispatches are decided before the gate runs.
  await rm(path.join(pkg, "plan-confirmation.json"));
  const manifestPath = path.join(pkg, "slices", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const { maxBytes: _max, waveBytes: _wave, ...withoutBudget } = manifest;
  await writeFile(manifestPath, JSON.stringify(withoutBudget), "utf8");
  const broken = await reviewNext({ packageDir: pkg });
  expect(broken.planAuthorized).toBeNull();
  expect(broken.continue).toBe(false);
  expect(broken.package).toBe(pkg);
});

/** Writes a raw reply and stamps its mtime, in seconds from a fixed origin, so a test can make file time disagree with wave order. */
async function writeRaw(name: string, body: unknown, mtimeSeconds: number): Promise<void> {
  const file = path.join(pkg, "raw", name);
  await writeFile(file, typeof body === "string" ? body : reply(body));
  await utimes(file, 1_700_000_000 + mtimeSeconds, 1_700_000_000 + mtimeSeconds);
}

async function driverSlices(reviewer: string): Promise<Array<{ wave: number; slices: string[] }>> {
  const names = (await readdir(path.join(pkg, "drivers"))).filter((name) => name.startsWith(`${reviewer}-w`) && name.endsWith(".json"));
  const drivers = await Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(pkg, "drivers", name), "utf8")) as { wave: number; slices: string[] }));
  return drivers.sort((a, b) => a.wave - b.wave).map(({ wave, slices }) => ({ wave, slices }));
}

test("wave order: every wave's reply counts, whatever its mtime, so a covered slice is not dispatched again", async () => {
  await slicePackage({ "src/m/a.ts": 400, "src/m/b.ts": 400, "src/m/c.ts": 400 }, 4000, 4000);
  const waves = await driverSlices("review-logic");
  expect(waves.length).toBeGreaterThan(1);
  // The first wave is the newest file on disk; the later waves are older. Only the newest used to be read.
  for (const [index, wave] of waves.entries()) {
    await writeRaw(`review-logic-w${wave.wave}.txt`, { reviewer: "review-logic", status: "DONE", slices: wave.slices }, index === 0 ? 1000 : index);
  }
  const next = await reviewNext({ packageDir: pkg, reviewers: ["review-logic"] });
  expect(next).toMatchObject({ done: true, dispatches: [], notRun: [], blocked: [], rejected: [] });
});

test("wave order: only the waves that were not answered are owed, and a reply with no wave number is ordered by mtime", async () => {
  await slicePackage({ "src/m/a.ts": 400, "src/m/b.ts": 400, "src/m/c.ts": 400 }, 4000, 4000);
  const waves = await driverSlices("review-logic");
  expect(waves.length).toBeGreaterThan(2);
  await writeRaw("review-logic-w2.txt", { reviewer: "review-logic", status: "DONE", slices: waves[1]!.slices }, 1000);
  await writeRaw("review-logic-w1.txt", { reviewer: "review-logic", status: "DONE", slices: waves[0]!.slices }, 10);
  const next = await reviewNext({ packageDir: pkg, reviewers: ["review-logic"] });
  const owed = next.dispatches.flatMap((entry) => entry.slices);
  for (const covered of [...waves[0]!.slices, ...waves[1]!.slices]) expect(owed).not.toContain(covered);
  expect(owed.length).toBeGreaterThan(0);
});

test("wave order: several finished waves landing together are not a stall, and the wave still owed is dispatched, not Not run", async () => {
  await slicePackage({ "src/m/a.ts": 400, "src/m/b.ts": 400, "src/m/c.ts": 400, "src/m/d.ts": 400 }, 4000, 4000);
  const waves = await driverSlices("review-logic");
  expect(waves.length).toBeGreaterThan(3);
  for (const [index, wave] of waves.slice(0, 3).entries()) {
    await writeRaw(`review-logic-w${wave.wave}.txt`, { reviewer: "review-logic", status: "DONE", slices: wave.slices }, index + 1);
  }
  const next = await reviewNext({ packageDir: pkg, reviewers: ["review-logic"] });
  expect(next.notRun).toEqual([]);
  const owed = next.dispatches.flatMap((entry) => entry.slices);
  expect(owed).toEqual(expect.arrayContaining(waves[3]!.slices));
  for (const wave of waves.slice(0, 3)) for (const id of wave.slices) expect(owed).not.toContain(id);
  await reviewNext({ packageDir: pkg, reviewers: ["review-logic"], apply: true });
  const state = JSON.parse(await readFile(path.join(pkg, "slices", "retry-state.json"), "utf8"));
  expect(state.reviewers["review-logic"].stalls).toBe(0);
});

test("idempotent: a repeated next prints the same text and JSON, read-only and after --apply", async () => {
  await slicePackage({ "src/m/a.ts": 400 }, 4000, 4000);
  await writeRaw("review-logic-w1.txt", { reviewer: "review-logic", status: "INCOMPLETE", slices: [] }, 1);
  const first = await reviewNext({ packageDir: pkg, reviewers: ["review-logic"] });
  const second = await reviewNext({ packageDir: pkg, reviewers: ["review-logic"] });
  expect(renderNext(second)).toBe(renderNext(first));
  expect(second).toEqual(first);

  await reviewNext({ packageDir: pkg, reviewers: ["review-logic"], apply: true });
  const afterApply = await reviewNext({ packageDir: pkg, reviewers: ["review-logic"] });
  const again = await reviewNext({ packageDir: pkg, reviewers: ["review-logic"] });
  expect(renderNext(again)).toBe(renderNext(afterApply));
  expect(JSON.stringify(again)).toBe(JSON.stringify(afterApply));
  const state = JSON.parse(await readFile(path.join(pkg, "slices", "retry-state.json"), "utf8"));
  expect(state.reviewers["review-logic"].attempt).toBe(1);
});

test("prev files: a newer X.prev.txt does not take the place of X.txt", async () => {
  const ids = await slicePackage({ "src/m/a.ts": 40 });
  await writeRaw("review-logic-w1.txt", { reviewer: "review-logic", status: "DONE", slices: ids }, 1);
  await writeRaw("review-logic-w1.prev.txt", { reviewer: "review-logic", status: "BLOCKED", slices: [] }, 1000);
  await writeRaw("review-logic-w1.prev2.txt", { reviewer: "review-logic", status: "INCOMPLETE", slices: [] }, 2000);
  const next = await reviewNext({ packageDir: pkg, reviewers: ["review-logic"] });
  expect(next).toMatchObject({ done: true, dispatches: [], notRun: [], rejected: [] });
});

test("without slices: a finished reply that names no slices is rejected with a reason and its slices stay open", async () => {
  const ids = await slicePackage({ "src/m/a.ts": 40 });
  await writeRaw("review-logic-w1.txt", { reviewer: "review-logic", status: "DONE", summary: "looks fine" }, 1);
  const next = await reviewNext({ packageDir: pkg, reviewers: ["review-logic"] });
  expect(next.done).toBe(false);
  expect(next.rejected).toHaveLength(1);
  expect(next.rejected[0]).toMatchObject({ reviewer: "review-logic", file: "raw/review-logic-w1.txt" });
  expect(next.rejected[0]!.reason).toContain("slices");
  expect(next.dispatches[0]).toMatchObject({ reviewer: "review-logic", slices: ids });
  expect(renderNext(next)).toContain("rejected");
  expect(JSON.parse(JSON.stringify(next)).rejected).toHaveLength(1);

  // A list that is present, even empty, is not rejected: it is an honest "covered nothing".
  await writeRaw("review-logic-w1.txt", { reviewer: "review-logic", status: "DONE", slices: [] }, 2);
  const empty = await reviewNext({ packageDir: pkg, reviewers: ["review-logic"] });
  expect(empty.rejected).toEqual([]);
});

test("without slices: DONE_WITH_CONCERNS is treated the same, and a reply that asks for context is not called rejected", async () => {
  await slicePackage({ "src/m/a.ts": 40 });
  await writeRaw("review-logic-w1.txt", { reviewer: "review-logic", status: "DONE_WITH_CONCERNS" }, 1);
  await writeRaw("review-style-w1.txt", { reviewer: "review-style", status: "NEEDS_CONTEXT", needs_context: ["which branch?"] }, 1);
  const next = await reviewNext({ packageDir: pkg, reviewers: ["review-logic", "review-style"] });
  expect(next.rejected.map((entry) => entry.reviewer)).toEqual(["review-logic"]);
});

test("escalations from every reply: a major finding in an older wave still escalates when a newer reply has none", async () => {
  const ids = await slicePackage({ "docs/guide.md": 30 });
  await writeRaw("review-logic-w1.txt", { reviewer: "review-logic", status: "DONE", slices: ids, findings: [{ id: "F-1", severity: "major", file: "docs/guide.md" }] }, 1);
  await writeRaw("review-logic-w2.txt", { reviewer: "review-logic", status: "DONE", slices: [], findings: [] }, 1000);
  await writeRaw("review-architecture-w1.txt", { reviewer: "review-architecture", status: "DONE", slices: [] }, 1);
  const next = await reviewNext({ packageDir: pkg, reviewers: ["review-logic", "review-architecture"] });
  expect(next.escalated).toEqual([{ slice: ids[0]!, finding: "F-1", by: "review-logic" }]);
  expect(next.dispatches.find((entry) => entry.reviewer === "review-architecture")).toMatchObject({ reason: "escalated", slices: ids });
});

test("old-format state: a retry-state.json from an older build is read, and a reviewer whose slices are covered is not Not run", async () => {
  const ids = await slicePackage({ "src/m/a.ts": 40 });
  await writeFile(path.join(pkg, "slices", "retry-state.json"), JSON.stringify({
    reviewers: {
      "review-logic": { attempt: 2, status: "INCOMPLETE", notRun: true },
      "review-style": "gone",
      "review-security-code": { attempt: "many", covered: "slice-01", processed: [1, null], stalls: -3 },
      "review-backend": null,
    },
  }));
  await writeRaw("review-logic-w1.txt", { reviewer: "review-logic", status: "DONE", slices: ids }, 1);
  await writeRaw("review-security-code-w1.txt", { reviewer: "review-security-code", status: "DONE", slices: ids }, 1);
  const next = await reviewNext({ packageDir: pkg, reviewers: ["review-logic", "review-security-code", "review-style"] });
  expect(next.notRun).toEqual([]);
  expect(next.dispatches.map((entry) => entry.reviewer)).toEqual(["review-style"]);
  expect(await readFile(path.join(pkg, "slices", "retry-state.json"), "utf8")).toContain("review-backend");
});
