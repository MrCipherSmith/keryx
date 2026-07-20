// Worktree isolation for parallel mutating subagents (flow 096, multi-agent
// engine Phase 6b).
//
// `planWaves` can run read-only children concurrently, but children that WRITE or
// run `git` collide in the shared working tree. This module assigns each isolation-
// required mutator its own git worktree so a wave of writers runs in parallel
// safely; read-only children keep the shared cwd. The PLANNER is pure and
// deterministic; the git lifecycle is behind an injected `WorktreePort` (faked in
// tests, a thin real adapter at runtime). Fail-closed: an isolation-required
// mutator that cannot be given a unique worktree is DENIED — never silently run in
// the shared tree.
//
// No clock/RNG/network/fs in the planner (ids derive from `taskId`); the port is
// the only impure seam. Merge happens as an explicit, stable-ordered post-wave step.
import type { PolicyProfile } from "../policy/types";

/** The minimal policy view the isolation decision needs. */
export type IsolationPolicy = Pick<PolicyProfile, "requiredControls">;

/**
 * A child needs an isolated worktree exactly when its policy requires isolation
 * (`required-fail-closed`) AND it may mutate the tree (`write` or `git` in its
 * allowed actions). Read-only or non-isolated children keep the shared cwd. Pure.
 */
export function needsWorktree(policy: IsolationPolicy, allowedActions: readonly string[]): boolean {
  const isolationRequired = policy.requiredControls.isolation === "required-fail-closed";
  const mutates = allowedActions.includes("write") || allowedActions.includes("git");
  return isolationRequired && mutates;
}

/** A task the planner assigns a worktree (or the shared cwd) to. */
export interface WorktreeTask {
  taskId: string;
  policy: IsolationPolicy;
  allowedActions: readonly string[];
}

/** One task's placement: its own worktree, or the shared working tree. */
export type WorktreeAssignment =
  | { taskId: string; mode: "worktree"; worktreeId: string }
  | { taskId: string; mode: "shared" };

/** Result of {@link planWorktrees}: a full assignment plan or a fail-closed denial. */
export type PlanWorktreesResult =
  | { ok: true; assignments: WorktreeAssignment[] }
  | { ok: false; reason: string };

/** Stable, unique worktree id derived from a task id (no RNG). */
export function worktreeIdFor(taskId: string): string {
  return `wt-${taskId}`;
}

/**
 * Plan worktree placement for a set of tasks. Isolation-required mutators each get
 * a unique, stable worktree id (from `taskId`); every other task maps to the
 * shared cwd. Deterministic — identical input yields a deep-equal plan, in input
 * order. Fail-closed: a task that {@link needsWorktree} but has an empty `taskId`,
 * or a duplicate `taskId` among worktree-needing tasks (which would collide on a
 * shared worktree), DENIES the whole plan — never a silent shared-cwd fallback for
 * an isolation-required mutator.
 */
export function planWorktrees(tasks: readonly WorktreeTask[]): PlanWorktreesResult {
  const assignments: WorktreeAssignment[] = [];
  const seenWorktreeIds = new Set<string>();

  for (const task of tasks) {
    if (!needsWorktree(task.policy, task.allowedActions)) {
      assignments.push({ taskId: task.taskId, mode: "shared" });
      continue;
    }
    if (task.taskId.length === 0) {
      return { ok: false, reason: "isolation-required task has an empty taskId; cannot assign a worktree" };
    }
    const worktreeId = worktreeIdFor(task.taskId);
    if (seenWorktreeIds.has(worktreeId)) {
      return {
        ok: false,
        reason: `duplicate taskId "${task.taskId}" among isolation-required tasks; worktree ids would collide`,
      };
    }
    seenWorktreeIds.add(worktreeId);
    assignments.push({ taskId: task.taskId, mode: "worktree", worktreeId });
  }

  return { ok: true, assignments };
}

/** A created worktree: its id and the absolute path a child runs in. */
export interface CreatedWorktree {
  worktreeId: string;
  path: string;
}

/** Result of merging one worktree back into the base. */
export interface WorktreeMergeResult {
  worktreeId: string;
  ok: boolean;
  conflicts?: string[];
}

/**
 * The impure git lifecycle seam. A fake implements it in tests; a thin real
 * adapter (`git worktree add/remove` + merge) drives it at runtime.
 */
export interface WorktreePort {
  create(worktreeId: string): Promise<CreatedWorktree>;
  remove(worktreeId: string): Promise<void>;
  merge(worktreeId: string, into: string): Promise<WorktreeMergeResult>;
}

/**
 * Create a worktree for every `worktree`-mode assignment, in a stable order
 * (sorted by `taskId`), returning a map of `worktreeId -> path`. Shared-mode
 * assignments are skipped. The only impure step (delegated to `port`).
 */
export async function provisionWorktrees(
  assignments: readonly WorktreeAssignment[],
  port: WorktreePort,
): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  const ordered = [...assignments]
    .filter((a): a is Extract<WorktreeAssignment, { mode: "worktree" }> => a.mode === "worktree")
    .sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  for (const assignment of ordered) {
    const created = await port.create(assignment.worktreeId);
    paths.set(created.worktreeId, created.path);
  }
  return paths;
}

/**
 * Resolve the cwd a child runs in (feeds `ContainedCommand.cwd`): the created
 * worktree path for a `worktree` assignment, or `sharedCwd` for a `shared` one.
 * Fail-closed: a `worktree` assignment whose path was not provisioned throws
 * rather than silently falling back to the shared tree.
 */
export function resolveChildCwd(
  assignment: WorktreeAssignment,
  sharedCwd: string,
  worktreePaths: ReadonlyMap<string, string>,
): string {
  if (assignment.mode === "shared") return sharedCwd;
  const path = worktreePaths.get(assignment.worktreeId);
  if (path === undefined) {
    throw new Error(
      `worktree "${assignment.worktreeId}" for task "${assignment.taskId}" was not provisioned; refusing shared-cwd fallback`,
    );
  }
  return path;
}

/**
 * Merge every `worktree`-mode assignment back into `into`, in a stable order
 * (sorted by `taskId`), returning each merge result. The explicit post-wave step;
 * the only impure part is delegated to `port`.
 */
export async function mergeWorktrees(
  assignments: readonly WorktreeAssignment[],
  into: string,
  port: WorktreePort,
): Promise<WorktreeMergeResult[]> {
  const ordered = [...assignments]
    .filter((a): a is Extract<WorktreeAssignment, { mode: "worktree" }> => a.mode === "worktree")
    .sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  const results: WorktreeMergeResult[] = [];
  for (const assignment of ordered) {
    results.push(await port.merge(assignment.worktreeId, into));
  }
  return results;
}
