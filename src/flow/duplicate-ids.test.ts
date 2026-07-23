import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTaskManagerFlowPort } from "../harness/flow/managed-flow-port";
import { createFlowService } from "./service";
import { duplicateFlowIds, resolveFlowDir } from "./store";
import type { FlowServiceDeps, FlowState } from "./types";

// Flow 116 / AC3, AC5-AC7: once two flows share a number, nothing may resolve
// that number silently — the CLI, the gate and the repair path all have to be
// explicit about the collision.

const ROOTS: string[] = [];

afterAll(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

function makeDeps(): FlowServiceDeps {
  return {
    tracker: null,
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-07-22T10:00:00Z"),
  };
}

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-flow-dup-"));
  ROOTS.push(root);
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  return root;
}

// Reproduce a post-merge collision: two flows created independently, then given
// the same number — what a merge of two branches produces on main.
async function collidingPair(root: string): Promise<{ kept: string; clashing: string }> {
  const service = createFlowService(makeDeps());
  const first = await service.init({ cwd: root, title: "Alpha side" });
  const second = await service.init({ cwd: root, title: "Beta side" });

  const flows = path.join(root, ".metaproject", "flows");
  const firstDir = path.basename(first.dir);
  const secondDir = path.basename(second.dir);
  const clashing = `${first.flow.id}-${secondDir.slice(4)}`;
  await rename(path.join(flows, secondDir), path.join(flows, clashing));
  const file = path.join(flows, clashing, "flow.json");
  const flow = JSON.parse(await readFile(file, "utf8")) as FlowState;
  flow.id = first.flow.id;
  await writeFile(file, `${JSON.stringify(flow, null, 2)}\n`, "utf8");

  return { kept: firstDir, clashing };
}

test("a bare id matching two flows fails with both candidates named", async () => {
  const root = await freshRoot();
  const { kept, clashing } = await collidingPair(root);

  const error = await resolveFlowDir(root, "001").then(
    () => null,
    (caught: unknown) => caught as Error,
  );

  expect(error).toBeInstanceOf(Error);
  expect(error?.message).toContain(kept);
  expect(error?.message).toContain(clashing);
  expect(error?.message.toLowerCase()).toContain("ambiguous");
});

test("exact directory names and unique slugs still resolve while a collision exists", async () => {
  const root = await freshRoot();
  const { kept, clashing } = await collidingPair(root);

  expect(await resolveFlowDir(root, kept)).toBe(kept);
  expect(await resolveFlowDir(root, clashing)).toBe(clashing);
  expect(await resolveFlowDir(root, "alpha-side")).toBe(kept);
});

test("flow commands refuse an ambiguous id instead of picking the first match", async () => {
  const root = await freshRoot();
  await collidingPair(root);
  const service = createFlowService(makeDeps());

  await expect(service.get({ cwd: root, id: "001" })).rejects.toThrow(/ambiguous/i);
  await expect(service.start({ cwd: root, id: "001" })).rejects.toThrow(/ambiguous/i);
});

test("the harness flow port fails closed on an ambiguous id and writes nothing", async () => {
  const root = await freshRoot();
  const { kept, clashing } = await collidingPair(root);
  const service = createFlowService(makeDeps());
  const port = createTaskManagerFlowPort(service);

  const flows = path.join(root, ".metaproject", "flows");
  const before = await Promise.all(
    [kept, clashing].map((dir) => readFile(path.join(flows, dir, "flow.json"), "utf8")),
  );

  await expect(
    port.completeFromGate({
      cwd: root,
      flowId: "001",
      taskId: "T1",
      gate: {
        schemaVersion: 1,
        gateId: "gate-1",
        runId: "run-1",
        status: "pass",
        checks: [],
        evaluatedAt: "2026-07-22T10:00:00.000Z",
        evidenceRefs: [],
        unresolvedBlockerIds: [],
      },
      evidenceRefs: ["evidence://run-1"],
      runLink: { runId: "run-1", sessionId: "session-1", attempt: 1 },
    }),
  ).rejects.toThrow(/ambiguous/i);

  // Neither candidate may absorb the run's evidence.
  const after = await Promise.all(
    [kept, clashing].map((dir) => readFile(path.join(flows, dir, "flow.json"), "utf8")),
  );
  expect(after).toEqual(before);
});

test("flow check reports duplicate ids as a hard failure naming both directories", async () => {
  const root = await freshRoot();
  const { kept, clashing } = await collidingPair(root);
  const service = createFlowService(makeDeps());

  const result = await service.check({ cwd: root });
  const duplicates = result.issues.filter((issue) => issue.kind === "duplicate-id");

  expect(result.ok).toBe(false);
  expect(duplicates).toHaveLength(2);
  expect(duplicates.map((issue) => issue.flow).sort()).toEqual([kept, clashing].sort());
  expect(duplicates[0]?.message).toContain("001");
});

test("flow list marks exactly the ids that are shared", () => {
  // The listing is where a collision usually gets noticed — it must say so.
  expect(duplicateFlowIds(["001", "002", "003"]).size).toBe(0);
  expect([...duplicateFlowIds(["001", "002", "001", "003", "003"])].sort()).toEqual(["001", "003"]);
});

test("renumber moves the package, rewrites the id, and records the mapping", async () => {
  const root = await freshRoot();
  const { kept, clashing } = await collidingPair(root);
  const service = createFlowService(makeDeps());

  const result = await service.renumber({
    cwd: root,
    ref: clashing,
    to: "007",
    reason: "duplicate of 001 created on a parallel branch",
  });

  const flows = path.join(root, ".metaproject", "flows");
  expect(result.from).toBe("001");
  expect(result.toDir).toBe(`007-${clashing.slice(4)}`);
  expect(await Bun.file(path.join(flows, clashing, "flow.json")).exists()).toBe(false);

  const moved = JSON.parse(
    await readFile(path.join(flows, result.toDir, "flow.json"), "utf8"),
  ) as FlowState;
  expect(moved.id).toBe("007");
  expect(moved.history.some((event) => event.event === "renumbered")).toBe(true);

  const map = JSON.parse(await readFile(path.join(flows, "id-map.json"), "utf8")) as Array<{
    from: string;
    to: string;
    fromDir: string;
    toDir: string;
    reason: string;
  }>;
  expect(map).toHaveLength(1);
  expect(map[0]).toMatchObject({
    from: "001",
    to: "007",
    fromDir: clashing,
    toDir: result.toDir,
    reason: "duplicate of 001 created on a parallel branch",
  });

  // The collision is gone and the surviving flow keeps its number.
  expect(await resolveFlowDir(root, "001")).toBe(kept);
  const check = await service.check({ cwd: root });
  expect(check.issues.filter((issue) => issue.kind === "duplicate-id")).toHaveLength(0);
});

test("renumber refuses a taken, malformed, or already-used target id", async () => {
  const root = await freshRoot();
  const { kept, clashing } = await collidingPair(root);
  const service = createFlowService(makeDeps());

  await expect(
    service.renumber({ cwd: root, ref: clashing, to: "001", reason: "x" }),
  ).rejects.toThrow(/already/i);
  await expect(
    service.renumber({ cwd: root, ref: clashing, to: "7", reason: "x" }),
  ).rejects.toThrow(/three digits/i);
  await expect(
    service.renumber({ cwd: root, ref: kept, to: "007", reason: "" }),
  ).rejects.toThrow(/reason/i);

  await service.renumber({ cwd: root, ref: clashing, to: "007", reason: "first move" });
  // 007 is taken now; the freed number stays retired as well.
  await expect(
    service.renumber({ cwd: root, ref: kept, to: "007", reason: "second move" }),
  ).rejects.toThrow(/already/i);
});

test("an ambiguous ref cannot be renumbered by number alone", async () => {
  const root = await freshRoot();
  await collidingPair(root);
  const service = createFlowService(makeDeps());

  await expect(
    service.renumber({ cwd: root, ref: "001", to: "007", reason: "which one?" }),
  ).rejects.toThrow(/ambiguous/i);
});
