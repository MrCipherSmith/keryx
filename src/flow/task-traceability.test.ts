import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "./service";
import type { FlowServiceDeps } from "./types";

/**
 * A task can say which criterion it satisfies, and what proves it.
 *
 * `acRefs` and `evidenceRefs` have been in the task schema since v2. Until
 * this change nothing wrote `acRefs` anywhere — not the service, not the CLI,
 * not the harness — and `evidenceRefs` was writable only through the service,
 * which the command line did not expose. Measured across the eight flows of
 * the agent-first-core programme: 97 tasks, every one of them carrying two
 * empty arrays.
 *
 * That is the defect this programme keeps finding in its own subject matter —
 * a capability whose only caller is its own test — sitting in the machinery
 * that governs the programme itself. Every flow's final criterion asks for
 * explicit evidence, and the machine-readable record had no way to carry any,
 * so "explicit evidence" could only ever mean a narrative in a journal.
 */
function deps(): FlowServiceDeps {
  return {
    tracker: {
      id: "none",
      detect: async () => false,
      parseRef: () => null,
      fetchIssue: async () => ({ title: "", body: "" }),
      prStatus: async () => ({ exists: false, isDraft: false, checksGreen: false, headSha: "" }),
      comment: async () => true,
    },
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-08T12:00:00Z"),
  };
}

async function withFlow<T>(run: (cwd: string, id: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-flow-trace-"));
  try {
    const service = createFlowService(deps());
    const { flow } = await service.init({ cwd, title: "trace probe" });
    return await run(cwd, flow.id);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function taskOf(cwd: string, id: string, taskId: string): Record<string, unknown> {
  const dir = path.join(cwd, ".metaproject", "flows");
  const entries = readFileSync(path.join(dir, findFlowDir(dir, id), "flow.json"), "utf8");
  const parsed = JSON.parse(entries) as { tasks: Array<Record<string, unknown>> };
  const task = parsed.tasks.find((item) => item["id"] === taskId);
  expect(task).toBeDefined();
  return task as Record<string, unknown>;
}

function findFlowDir(dir: string, id: string): string {
  const match = readdirSync(dir).find((entry) => entry.startsWith(`${id}-`));
  expect(match).toBeDefined();
  return match as string;
}

describe("a task records which criterion it addresses", () => {
  test("acRefs and evidenceRefs round-trip to disk", async () => {
    await withFlow(async (cwd, id) => {
      const service = createFlowService(deps());
      await service.taskDone({
        cwd,
        id,
        taskId: "T1",
        acRefs: ["AC1", "AC3"],
        evidenceRefs: ["docs/verification/proof.md", "sha256:abc123"],
      });
      const task = taskOf(cwd, id, "T1");
      expect(task["acRefs"]).toEqual(["AC1", "AC3"]);
      expect(task["evidenceRefs"]).toEqual(["docs/verification/proof.md", "sha256:abc123"]);
    });
  });

  test("omitting the fields leaves an existing value alone", async () => {
    // The distinction that makes the field usable: a later `taskDone` that
    // only changes a disposition must not silently erase the trace recorded
    // earlier. Before this, every write set both to whatever the caller
    // happened to pass, which for the command line was always nothing.
    await withFlow(async (cwd, id) => {
      const service = createFlowService(deps());
      await service.taskDone({ cwd, id, taskId: "T1", acRefs: ["AC2"], evidenceRefs: ["e1"] });
      await service.taskDone({ cwd, id, taskId: "T1", disposition: "completed" });
      const task = taskOf(cwd, id, "T1");
      expect(task["acRefs"]).toEqual(["AC2"]);
      expect(task["evidenceRefs"]).toEqual(["e1"]);
    });
  });

  test("an explicit empty list clears the trace, and is not the same as omitting it", async () => {
    // Recorded-then-retracted must be expressible. Collapsing "unset" and
    // "omitted" into one value would make a wrong reference impossible to
    // remove, which is how a stale claim survives.
    await withFlow(async (cwd, id) => {
      const service = createFlowService(deps());
      await service.taskDone({ cwd, id, taskId: "T1", acRefs: ["AC9"] });
      await service.taskDone({ cwd, id, taskId: "T1", acRefs: [] });
      expect(taskOf(cwd, id, "T1")["acRefs"]).toEqual([]);
    });
  });
});
