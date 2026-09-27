import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isNotFound, withFileLock, writeFileAtomic } from "../lib/fs";
import { readSlate } from "./slate";

/**
 * `proposed` is the status this vocabulary was missing (report item 1): a plan
 * PUBLISHED FOR THE OPERATOR'S APPROVAL. Without it, "here is my plan, your
 * call" was indistinguishable from "I am executing this", both for the operator
 * reading the sidebar and for the continuation nudge below — which is why
 * "make a plan and stop" was inexpressible.
 */
export const EXECUTION_PLAN_STATUSES = ["proposed", "pending", "in_progress", "completed", "blocked", "skipped"] as const;
export type ExecutionPlanStatus = (typeof EXECUTION_PLAN_STATUSES)[number];

export type ExecutionPlanItem = {
  id: string;
  title: string;
  status: ExecutionPlanStatus;
};

export type ExecutionPlan = {
  revision: number;
  items: ExecutionPlanItem[];
};

type PlanListener = (dir: string, plan: ExecutionPlan) => void;
const listeners = new Set<PlanListener>();

export class ExecutionPlanConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`execution plan revision conflict: expected ${expected}, current ${actual}`);
    this.name = "ExecutionPlanConflictError";
  }
}

export class ExecutionPlanValidationError extends Error {
  constructor(message: string) {
    super(`invalid execution plan: ${message}`);
    this.name = "ExecutionPlanValidationError";
  }
}

function clonePlan(plan: ExecutionPlan): ExecutionPlan {
  return { revision: plan.revision, items: plan.items.map((item) => ({ ...item })) };
}

function validateItems(items: readonly ExecutionPlanItem[]): ExecutionPlanItem[] {
  const ids = new Set<string>();
  let active = 0;
  return items.map((item) => {
    const id = item.id.trim();
    const title = item.title.trim();
    if (id.length === 0) throw new ExecutionPlanValidationError("item id must be non-empty");
    if (ids.has(id)) throw new ExecutionPlanValidationError(`duplicate item id: ${id}`);
    ids.add(id);
    if (title.length === 0) throw new ExecutionPlanValidationError(`item ${id} has an empty title`);
    if (!(EXECUTION_PLAN_STATUSES as readonly string[]).includes(item.status)) {
      throw new ExecutionPlanValidationError(`item ${id} has unknown status ${JSON.stringify(item.status)}`);
    }
    if (item.status === "in_progress" && ++active > 1) {
      throw new ExecutionPlanValidationError("at most one item may be in_progress");
    }
    return { id, title, status: item.status };
  });
}

function notify(dir: string, plan: ExecutionPlan): void {
  for (const listener of listeners) {
    try {
      listener(dir, clonePlan(plan));
    } catch {
      // Persistence already succeeded. A faulty observer must neither prevent
      // later observers from running nor turn the completed mutation into a
      // rejected promise.
    }
  }
}

export function subscribeExecutionPlans(listener: PlanListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The plan's OWN file in the session dir — a sibling of `slate.json`, not a
 * field inside it.
 *
 * It used to be `slate.json`'s `executionPlan`, which made the whole feature
 * hostage to the Slate lifecycle: the reader was `readSlate(dir)?.executionPlan`,
 * BOTH writers threw `no open Slate` when no `slate.json` existed, and
 * `closeSlateOnFlowDone` archives that file the moment the Flow reports `done` —
 * so a session's plan (and the sidebar rendering it) VANISHED mid-session, and
 * `plan_set` failed outright afterwards. A published plan is not a Flow
 * artifact: it is the operator-visible state of work in progress, and that is
 * exactly what has to outlive a slate close. Reported symptom: the sidebar froze
 * at one revision and the plan tools looked broken.
 */
export function executionPlanPath(dir: string): string {
  return path.join(dir, "plan.json");
}

/** Lock path for the plan's own read-modify-write (same non-reentrant lock shape as `slateLockPath`). */
export function executionPlanLockPath(dir: string): string {
  return `${executionPlanPath(dir)}.lock`;
}

/**
 * Plain read of `plan.json`; `undefined` when absent. A malformed or
 * wrongly-shaped file is ALSO `undefined` rather than a throw: a plan is
 * session-local, ephemeral metadata, and a corrupt one must not wedge every tool
 * call that touches it (contrast `readSlate`, whose failure modes carry Seeds a
 * human wrote by hand).
 */
async function readPlanFile(dir: string): Promise<ExecutionPlan | undefined> {
  let raw: string;
  try {
    raw = await readFile(executionPlanPath(dir), "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as ExecutionPlan;
    if (!Array.isArray(parsed.items)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * The plan's current value: `plan.json` when it exists, else the LEGACY
 * `slate.json#executionPlan` a pre-decoupling session wrote — still honoured so
 * an in-flight session keeps its plan, and migrated to `plan.json` by the next
 * write (the legacy revision is carried over, so a caller's `expectedRevision`
 * keeps working across the change).
 */
/**
 * The plan as a pre-decoupling session stored it. Read STRUCTURALLY rather than
 * through the `Slate` type: the field is gone from `Slate` (that removal is the
 * point of this change), but a `slate.json` written before it still carries the
 * key, and silently dropping a live session's plan on upgrade would be a worse
 * regression than the one being fixed.
 */
async function readLegacyPlan(dir: string): Promise<ExecutionPlan | undefined> {
  const slate = (await readSlate(dir)) as { executionPlan?: ExecutionPlan } | undefined;
  return slate?.executionPlan;
}

export async function getExecutionPlan(dir: string): Promise<ExecutionPlan | undefined> {
  const own = await readPlanFile(dir);
  if (own !== undefined) return clonePlan(own);
  const legacy = await readLegacyPlan(dir);
  return legacy === undefined ? undefined : clonePlan(legacy);
}

/**
 * Shared read-modify-write for both writers: ONE `withFileLock` hold over
 * `plan.json` (its own lock path, never the slate's), so two same-turn writers
 * cannot lose each other's update — and neither needs a slate to exist.
 */
async function writePlan(
  dir: string,
  expectedRevision: number,
  build: (current: ExecutionPlan | undefined) => ExecutionPlan,
): Promise<ExecutionPlan> {
  await mkdir(dir, { recursive: true });
  let result: ExecutionPlan | undefined;
  await withFileLock(executionPlanLockPath(dir), async () => {
    const own = await readPlanFile(dir);
    const current = own ?? (await readLegacyPlan(dir));
    const actual = current?.revision ?? 0;
    if (expectedRevision !== actual) throw new ExecutionPlanConflictError(expectedRevision, actual);
    result = build(current);
    await writeFileAtomic(executionPlanPath(dir), `${JSON.stringify(result, null, 2)}\n`);
  });
  const plan = clonePlan(result as ExecutionPlan);
  notify(dir, plan);
  return plan;
}

export async function setExecutionPlan(
  dir: string,
  input: { expectedRevision: number; items: readonly ExecutionPlanItem[] },
): Promise<ExecutionPlan> {
  const items = validateItems(input.items);
  return writePlan(dir, input.expectedRevision, () => ({ revision: input.expectedRevision + 1, items }));
}

export async function updateExecutionPlan(
  dir: string,
  input: { expectedRevision: number; itemId: string; status: ExecutionPlanStatus },
): Promise<ExecutionPlan> {
  return writePlan(dir, input.expectedRevision, (current) => {
    if (current === undefined) throw new ExecutionPlanValidationError("no execution plan exists");
    if (!(EXECUTION_PLAN_STATUSES as readonly string[]).includes(input.status)) {
      throw new ExecutionPlanValidationError(`unknown status ${JSON.stringify(input.status)}`);
    }
    if (!current.items.some((item) => item.id === input.itemId)) {
      throw new ExecutionPlanValidationError(`unknown item id: ${input.itemId}`);
    }
    const items = validateItems(
      current.items.map((item) => (item.id === input.itemId ? { ...item, status: input.status } : item)),
    );
    return { revision: current.revision + 1, items };
  });
}

/**
 * Work the agent still owes. `proposed` is deliberately NOT actionable: an item
 * awaiting the operator's approval is not work the agent may simply continue,
 * and counting it here is exactly what made "publish a plan, then stop and let
 * the human decide" impossible — the shell's own continuation nudge fired on
 * any `pending`, and a plan that had just been published necessarily had some.
 */
export function hasActionableExecutionPlanItems(plan: ExecutionPlan | undefined): boolean {
  return plan?.items.some((item) => item.status === "pending" || item.status === "in_progress") ?? false;
}

/** Items published for operator approval (never work in progress). */
export function executionPlanApprovalItems(plan: ExecutionPlan | undefined): ExecutionPlanItem[] {
  return plan?.items.filter((item) => item.status === "proposed") ?? [];
}

/**
 * Flow 347 T5 (AC3): the previous implementation showed `items.slice(0, 7)`
 * in plain insertion order, so an 18-item plan always showed finished steps
 * 0-6 and hid the `in_progress` item further down — the exact failure mode
 * item 3 in `description.md` names. The item the model/operator most needs to
 * see is whatever is ACTIVE or blocking progress, so the non-finished items
 * are surfaced first, ordered by how much they demand attention:
 * `in_progress` (the one thing actually happening right now), then
 * `blocked` (needs unsticking), then `pending` (queued, actionable), then
 * `proposed` (queued, awaiting approval) — stable within a status (original
 * plan order preserved via a stable sort). Finished work
 * (`completed`/`skipped`) is folded into a single trailing count line instead
 * of eating a row for a status nobody needs to act on. `maxItems` still caps
 * only the listed (non-finished) rows, same contract as before.
 */
const SNAPSHOT_STATUS_RANK: Record<ExecutionPlanStatus, number> = {
  in_progress: 0,
  blocked: 1,
  pending: 2,
  proposed: 3,
  completed: 4,
  skipped: 4,
};

export function renderExecutionPlanSnapshot(plan: ExecutionPlan | undefined, maxItems = 7): string | undefined {
  if (plan === undefined || plan.items.length === 0) return undefined;
  const finished = plan.items.filter((item) => item.status === "completed" || item.status === "skipped");
  const active = plan.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status !== "completed" && item.status !== "skipped")
    .sort((a, b) => SNAPSHOT_STATUS_RANK[a.item.status] - SNAPSHOT_STATUS_RANK[b.item.status] || a.index - b.index)
    .map(({ item }) => item);

  const cap = Math.max(0, maxItems);
  const shown = active.slice(0, cap);
  const rows = shown.map((item) => {
    const title = item.title.length > 120 ? `${item.title.slice(0, 119)}…` : item.title;
    return `- ${item.id} [${item.status}]: ${title}`;
  });
  if (active.length > shown.length) rows.push(`- … ${active.length - shown.length} more item(s)`);
  if (finished.length > 0) rows.push(`- ${finished.length} completed/skipped item(s) (folded)`);
  return `Current execution plan (revision ${plan.revision}):\n${rows.join("\n")}`;
}
