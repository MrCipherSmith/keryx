// Tests for worktree isolation of parallel mutators (flow 096, Phase 6b).
import { describe, expect, test } from "bun:test";
import {
  mergeWorktrees,
  needsWorktree,
  planWorktrees,
  provisionWorktrees,
  resolveChildCwd,
  worktreeIdFor,
  type IsolationPolicy,
  type WorktreePort,
  type WorktreeTask,
} from "./worktree";

function pol(isolation: IsolationPolicy["requiredControls"]["isolation"]): IsolationPolicy {
  return { requiredControls: { isolation, redactionFailure: "deny", networkBrokerFailure: "deny" } };
}

const ISO = pol("required-fail-closed");
const OPEN = pol("not-required");

function makeFakePort(): { port: WorktreePort; calls: string[] } {
  const calls: string[] = [];
  const port: WorktreePort = {
    async create(id) {
      calls.push(`create:${id}`);
      return { worktreeId: id, path: `/wt/${id}` };
    },
    async remove(id) {
      calls.push(`remove:${id}`);
    },
    async merge(id, into) {
      calls.push(`merge:${id}->${into}`);
      return { worktreeId: id, ok: true };
    },
  };
  return { port, calls };
}

describe("needsWorktree (AC1)", () => {
  test("isolation-required + write or git => true", () => {
    expect(needsWorktree(ISO, ["read", "write"])).toBe(true);
    expect(needsWorktree(ISO, ["git"])).toBe(true);
  });

  test("isolation-required but read-only => false", () => {
    expect(needsWorktree(ISO, ["read"])).toBe(false);
  });

  test("not-isolated even if mutating => false", () => {
    expect(needsWorktree(OPEN, ["write", "git"])).toBe(false);
  });
});

describe("planWorktrees (AC2/AC3)", () => {
  const tasks: WorktreeTask[] = [
    { taskId: "a", policy: ISO, allowedActions: ["write"] },
    { taskId: "b", policy: OPEN, allowedActions: ["read"] },
    { taskId: "c", policy: ISO, allowedActions: ["git"] },
  ];

  test("mutators get unique worktree ids; read-only gets shared; input order preserved", () => {
    const plan = planWorktrees(tasks);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.assignments).toEqual([
      { taskId: "a", mode: "worktree", worktreeId: worktreeIdFor("a") },
      { taskId: "b", mode: "shared" },
      { taskId: "c", mode: "worktree", worktreeId: worktreeIdFor("c") },
    ]);
  });

  test("deterministic: identical input yields a deep-equal plan", () => {
    expect(planWorktrees(tasks)).toEqual(planWorktrees(tasks));
  });

  test("fail-closed: an isolation-required mutator with an empty taskId is denied", () => {
    const r = planWorktrees([{ taskId: "", policy: ISO, allowedActions: ["write"] }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("empty taskId");
  });

  test("fail-closed: duplicate taskIds among mutators are denied (worktree id collision)", () => {
    const r = planWorktrees([
      { taskId: "dup", policy: ISO, allowedActions: ["write"] },
      { taskId: "dup", policy: ISO, allowedActions: ["git"] },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("duplicate taskId");
  });

  test("a read-only task with a duplicate id is fine (shared, no worktree)", () => {
    const r = planWorktrees([
      { taskId: "x", policy: OPEN, allowedActions: ["read"] },
      { taskId: "x", policy: OPEN, allowedActions: ["read"] },
    ]);
    expect(r.ok).toBe(true);
  });
});

describe("lifecycle via fake WorktreePort (AC4)", () => {
  const tasks: WorktreeTask[] = [
    { taskId: "c", policy: ISO, allowedActions: ["write"] },
    { taskId: "a", policy: ISO, allowedActions: ["git"] },
    { taskId: "b", policy: OPEN, allowedActions: ["read"] },
  ];

  test("create → cwd resolution → merge in a stable (taskId) order", async () => {
    const plan = planWorktrees(tasks);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.reason);

    const { port, calls } = makeFakePort();
    const paths = await provisionWorktrees(plan.assignments, port);

    // provisioned only the two worktree tasks, in stable taskId order (a before c)
    expect(calls).toEqual([`create:${worktreeIdFor("a")}`, `create:${worktreeIdFor("c")}`]);
    expect(paths.get(worktreeIdFor("a"))).toBe(`/wt/${worktreeIdFor("a")}`);

    // resolveChildCwd feeds ContainedCommand.cwd: worktree path for mutators, shared for read-only
    const byId = Object.fromEntries(plan.assignments.map((a) => [a.taskId, a]));
    expect(resolveChildCwd(byId.a!, "/repo", paths)).toBe(`/wt/${worktreeIdFor("a")}`);
    expect(resolveChildCwd(byId.b!, "/repo", paths)).toBe("/repo");

    const merges = await mergeWorktrees(plan.assignments, "main", port);
    expect(merges.every((m) => m.ok)).toBe(true);
    // merge order is stable by taskId (a before c), appended after the creates
    expect(calls.slice(2)).toEqual([`merge:${worktreeIdFor("a")}->main`, `merge:${worktreeIdFor("c")}->main`]);
  });

  test("resolveChildCwd fail-closed: an unprovisioned worktree throws (no shared fallback)", () => {
    const assignment = { taskId: "z", mode: "worktree", worktreeId: worktreeIdFor("z") } as const;
    expect(() => resolveChildCwd(assignment, "/repo", new Map())).toThrow();
  });
});
