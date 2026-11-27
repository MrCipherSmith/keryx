import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentTurn } from "./agent";
import { callRound, collectingIo, makeDeps, okReply, scriptedProvider, type Script } from "./agent.test-helpers";
import { builtinReadOnlyTools } from "../harness/tool/builtin/interactive-tools";
import { executionPlanTools } from "../harness/tool/builtin/execution-plan-tool";
import { EXECUTION_PLAN_STALE_NOTE, EXECUTION_PLAN_STALE_ROUNDS, getExecutionPlan, setExecutionPlan } from "../session/execution-plan";
import type { SlateSessionRef } from "../session/slate-lifecycle";

/** A session dir holding an open two-step plan and `count` small files to read, one per round. */
async function planSession(count: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-plan-staleness-"));
  for (let i = 0; i < count; i++) await writeFile(path.join(dir, `f${i}.txt`), `file ${i}\n`);
  await setExecutionPlan(dir, {
    expectedRevision: 0,
    items: [
      { id: "implement", title: "Implement it", status: "in_progress" },
      { id: "verify", title: "Verify it", status: "pending" },
    ],
  });
  return dir;
}

const readRound = (i: number): Script => callRound(`r${i}`, "read_file", JSON.stringify({ path: `f${i}.txt` }));

async function run(dir: string, scripts: Script[]) {
  const { provider, requests } = scriptedProvider(scripts, { exhausted: "empty" });
  const deps = makeDeps(provider, { tools: [...builtinReadOnlyTools(dir), ...executionPlanTools(() => dir)], maxRounds: 30 });
  const slateSession: SlateSessionRef = { dir, cwd: dir, opened: true };
  await runAgentTurn(collectingIo().io, deps, [], "work", { slateSession });
  return requests.map((request) => request.systemInstruction ?? "");
}

test("an open plan the model leaves unchanged for the stale window gets the fixed catch-up note, and only from then on", async () => {
  const rounds = EXECUTION_PLAN_STALE_ROUNDS + 2;
  const dir = await planSession(rounds);
  const systems = await run(dir, [...Array.from({ length: rounds }, (_, i) => readRound(i)), okReply]);

  // Round 1 takes the baseline; round 1 + STALE_ROUNDS is the first with no change for the whole window.
  const firstStale = EXECUTION_PLAN_STALE_ROUNDS; // request index of round STALE_ROUNDS + 1
  for (const system of systems.slice(0, firstStale)) {
    expect(system).toContain("Current execution plan (revision 1)");
    expect(system).not.toContain(EXECUTION_PLAN_STALE_NOTE);
  }
  // The note is fixed text: every later round carries the same system instruction, so the prompt cache holds.
  const stale = systems.slice(firstStale);
  expect(stale.length).toBeGreaterThan(1);
  expect(stale.every((system) => system.endsWith(EXECUTION_PLAN_STALE_NOTE))).toBe(true);
  expect(new Set(stale).size).toBe(1);
});

test("a plan_update with several items moves the plan in one revision and restarts the stale count", async () => {
  const before = 4;
  const after = EXECUTION_PLAN_STALE_ROUNDS + 1;
  const dir = await planSession(before + after);
  const update = callRound("u", "plan_update", JSON.stringify({
    expectedRevision: 1,
    updates: [{ itemId: "implement", status: "completed" }, { itemId: "verify", status: "in_progress" }],
  }));
  const scripts = [
    ...Array.from({ length: before }, (_, i) => readRound(i)),
    update,
    ...Array.from({ length: after }, (_, i) => readRound(before + i)),
    okReply,
  ];
  const systems = await run(dir, scripts);

  const plan = await getExecutionPlan(dir);
  expect(plan?.revision).toBe(2);
  expect(plan?.items.map((item) => item.status)).toEqual(["completed", "in_progress"]);
  // Up to the update the plan was never stale (rounds 1..5); the round after it reads revision 2 and starts a new count.
  const updatedAt = before + 1; // request index of the first round that sees revision 2
  expect(systems.slice(0, updatedAt).some((system) => system.includes(EXECUTION_PLAN_STALE_NOTE))).toBe(false);
  expect(systems[updatedAt]).toContain("Current execution plan (revision 2)");
  const window = systems.slice(updatedAt, updatedAt + EXECUTION_PLAN_STALE_ROUNDS);
  expect(window.some((system) => system.includes(EXECUTION_PLAN_STALE_NOTE))).toBe(false);
  expect(systems[updatedAt + EXECUTION_PLAN_STALE_ROUNDS]).toContain(EXECUTION_PLAN_STALE_NOTE);
});

test("a plan with no open step is never called stale", async () => {
  const rounds = EXECUTION_PLAN_STALE_ROUNDS + 2;
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-plan-staleness-done-"));
  for (let i = 0; i < rounds; i++) await writeFile(path.join(dir, `f${i}.txt`), `file ${i}\n`);
  await setExecutionPlan(dir, { expectedRevision: 0, items: [{ id: "only", title: "Only step", status: "completed" }] });
  const systems = await run(dir, [...Array.from({ length: rounds }, (_, i) => readRound(i)), okReply]);
  expect(systems.length).toBe(rounds + 1);
  expect(systems.some((system) => system.includes(EXECUTION_PLAN_STALE_NOTE))).toBe(false);
});
