import { expect, test } from "bun:test";
import type { JobRegistry } from "../harness/tool/builtin/background-job-registry";
import { runTasksCommand } from "./tasks-command";

function fixture() {
  const reads: [string, number][] = [];
  const kills: [string, string | undefined][] = [];
  let status = "running";
  const registry = {
    list: () => [{ jobId: "task-1", status, phase: "background", command: "printf test" }],
    get: () => ({ status }),
    readOutputSince: (id: string, cursor: number) => {
      reads.push([id, cursor]);
      return { ok: true, output: "STEP", nextCursor: 5, missed: 0, status };
    },
    kill: async (id: string, reason?: string) => { kills.push([id, reason]); status = "killed"; return { ok: true }; },
  } as unknown as JobRegistry;
  return { registry, reads, kills };
}
test("tasks lists, reads explicit cursors without consuming, and stops as operator", async () => {
  const f = fixture();
  expect(await runTasksCommand("", f.registry)).toContain("task-1 · running");
  expect(await runTasksCommand("output task-1 3", f.registry)).toContain("next_cursor=5");
  await runTasksCommand("output task-1 3", f.registry);
  expect(f.reads).toEqual([["task-1", 3], ["task-1", 3]]);
  expect(await runTasksCommand("kill task-1", f.registry)).toContain("killed");
  expect(f.kills).toEqual([["task-1", "operator"]]);
});
test("tasks rejects malformed arguments before reading or stopping", async () => {
  const f = fixture();
  for (const args of ["output task-1 -1", "output task-1 1.5", "output task-1 9007199254740992", "kill", "kill task-1 extra", "unknown task-1"]) {
    expect(await runTasksCommand(args, f.registry)).toContain("Usage:");
  }
  expect(f.reads).toEqual([]); expect(f.kills).toEqual([]);
  expect(await runTasksCommand("", undefined)).toContain("no shell tasks");
});
