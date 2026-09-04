import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "./service";
import type { FlowServiceDeps } from "./types";

// `flow check` reports three unsatisfiable `dependsOn` shapes — unknown
// dependency, self dependency, cycle — and until now nothing could repair any
// of them. `task add --depends` writes the field once at creation and no path
// rewrote it, so the only remedy was editing flow.json by hand, which this
// project forbids. Flow 178 carried a self-dependent T10 for two weeks for
// exactly that reason: the check was right, and the operator had nowhere to go.

function deps(): FlowServiceDeps {
  return {
    tracker: null,
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-04T04:00:00Z"),
  };
}

async function flowWithTasks(root: string, count: number): Promise<string> {
  const service = createFlowService(deps());
  const created = await service.init({ cwd: root, title: "Dependency fixture" });
  const dir = path.basename(created.dir);
  for (let i = 0; i < count; i += 1) {
    await service.taskAdd({ cwd: root, id: dir, title: `extra ${i}` });
  }
  return dir;
}

/**
 * Break a task's dependsOn directly. The whole point of the command under test
 * is that flow.json cannot be repaired by hand through the CLI — so producing
 * the broken state has to bypass it, exactly as the real damage did.
 */
async function forceDependsOn(root: string, dir: string, taskId: string, dependsOn: string[]): Promise<void> {
  const file = path.join(root, ".metaproject", "flows", dir, "flow.json");
  const state = JSON.parse(await readFile(file, "utf8")) as {
    tasks: { id: string; dependsOn?: string[] }[];
  };
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`fixture error: no ${taskId}`);
  task.dependsOn = dependsOn;
  await writeFile(file, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function issues(root: string, dir: string): Promise<string[]> {
  const service = createFlowService(deps());
  const report = await service.check({ cwd: root });
  return report.issues.filter((issue) => issue.flow === dir).map((issue) => issue.message);
}

describe("flow task depends", () => {
  test("repairs a self-dependency — the shape flow 178 was stuck in", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-depends-"));
    try {
      const service = createFlowService(deps());
      const dir = await flowWithTasks(root, 0);
      // T4 depending on T2 and itself: satisfiable but for the self edge.
      await forceDependsOn(root, dir, "T4", ["T2", "T4"]);
      expect(await issues(root, dir)).toEqual(
        expect.arrayContaining([expect.stringContaining("T4 depends on itself")]),
      );

      const flow = await service.taskDepends({
        cwd: root,
        id: dir,
        taskId: "T4",
        dependsOn: ["T2"],
        reason: "T4 listed itself; the real prerequisite is T2 alone",
      });

      expect(flow.tasks.find((t) => t.id === "T4")?.dependsOn).toEqual(["T2"]);
      expect(await issues(root, dir)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("clears the field when asked for nothing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-depends-clear-"));
    try {
      const service = createFlowService(deps());
      const dir = await flowWithTasks(root, 0);
      await forceDependsOn(root, dir, "T3", ["T1", "T3"]);

      const flow = await service.taskDepends({
        cwd: root,
        id: dir,
        taskId: "T3",
        dependsOn: [],
        reason: "T3 has no real prerequisites",
      });

      expect(flow.tasks.find((t) => t.id === "T3")?.dependsOn).toEqual([]);
      expect(await issues(root, dir)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a dependency on a task that does not exist, and names what does", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-depends-unknown-"));
    try {
      const service = createFlowService(deps());
      const dir = await flowWithTasks(root, 0);

      await expect(
        service.taskDepends({ cwd: root, id: dir, taskId: "T2", dependsOn: ["T99"], reason: "typo" }),
      ).rejects.toThrow(/T99 is not a task in this flow.*T1/s);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses to introduce a self-dependency — the repair cannot create the damage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-depends-self-"));
    try {
      const service = createFlowService(deps());
      const dir = await flowWithTasks(root, 0);

      await expect(
        service.taskDepends({ cwd: root, id: dir, taskId: "T2", dependsOn: ["T2"], reason: "oops" }),
      ).rejects.toThrow(/refusing.*depends on itself/s);

      // And the record is left exactly as it was found, not half-applied.
      const flow = await service.get({ cwd: root, id: dir });
      expect(flow.tasks.find((t) => t.id === "T2")?.dependsOn).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses to introduce a cycle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-depends-cycle-"));
    try {
      const service = createFlowService(deps());
      const dir = await flowWithTasks(root, 0);
      await service.taskDepends({ cwd: root, id: dir, taskId: "T2", dependsOn: ["T1"], reason: "order" });

      // T1 -> T2 would close the loop with T2 -> T1.
      await expect(
        service.taskDepends({ cwd: root, id: dir, taskId: "T1", dependsOn: ["T2"], reason: "closing a loop" }),
      ).rejects.toThrow(/refusing.*cycle/s);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("repairs one task without demanding the whole graph be clean first", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-depends-partial-"));
    try {
      const service = createFlowService(deps());
      const dir = await flowWithTasks(root, 0);
      // TWO broken tasks. Requiring a clean result would make the first repair
      // impossible, and a repair command that cannot be used first is not one.
      await forceDependsOn(root, dir, "T3", ["T3"]);
      await forceDependsOn(root, dir, "T4", ["T4"]);

      await service.taskDepends({
        cwd: root,
        id: dir,
        taskId: "T3",
        dependsOn: ["T1"],
        reason: "repairing T3 while T4 is still broken",
      });

      const remaining = await issues(root, dir);
      expect(remaining).toEqual([expect.stringContaining("T4 depends on itself")]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires a reason and normalises case and duplicates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-depends-reason-"));
    try {
      const service = createFlowService(deps());
      const dir = await flowWithTasks(root, 0);

      await expect(
        service.taskDepends({ cwd: root, id: dir, taskId: "T2", dependsOn: ["T1"], reason: "   " }),
      ).rejects.toThrow(/requires --reason/);

      const flow = await service.taskDepends({
        cwd: root,
        id: dir,
        taskId: "T2",
        dependsOn: ["t1", "T1", " t1 "],
        reason: "same edge written three ways",
      });
      expect(flow.tasks.find((t) => t.id === "T2")?.dependsOn).toEqual(["T1"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
