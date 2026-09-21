import { readSlate, writeSlate } from "./slate";

export const EXECUTION_PLAN_STATUSES = ["pending", "in_progress", "completed", "blocked", "skipped"] as const;
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
  for (const listener of listeners) listener(dir, clonePlan(plan));
}

export function subscribeExecutionPlans(listener: PlanListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function getExecutionPlan(dir: string): Promise<ExecutionPlan | undefined> {
  const plan = (await readSlate(dir))?.executionPlan;
  return plan === undefined ? undefined : clonePlan(plan);
}

export async function setExecutionPlan(
  dir: string,
  input: { expectedRevision: number; items: readonly ExecutionPlanItem[] },
): Promise<ExecutionPlan> {
  const items = validateItems(input.items);
  let result: ExecutionPlan | undefined;
  await writeSlate(dir, (prev) => {
    if (prev === undefined) throw new ExecutionPlanValidationError("no open Slate");
    const actual = prev.executionPlan?.revision ?? 0;
    if (input.expectedRevision !== actual) throw new ExecutionPlanConflictError(input.expectedRevision, actual);
    result = { revision: actual + 1, items };
    return { ...prev, executionPlan: result };
  });
  const plan = clonePlan(result as ExecutionPlan);
  notify(dir, plan);
  return plan;
}

export async function updateExecutionPlan(
  dir: string,
  input: { expectedRevision: number; itemId: string; status: ExecutionPlanStatus },
): Promise<ExecutionPlan> {
  let result: ExecutionPlan | undefined;
  await writeSlate(dir, (prev) => {
    if (prev === undefined) throw new ExecutionPlanValidationError("no open Slate");
    const current = prev.executionPlan;
    const actual = current?.revision ?? 0;
    if (input.expectedRevision !== actual) throw new ExecutionPlanConflictError(input.expectedRevision, actual);
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
    result = { revision: actual + 1, items };
    return { ...prev, executionPlan: result };
  });
  const plan = clonePlan(result as ExecutionPlan);
  notify(dir, plan);
  return plan;
}

export function hasActionableExecutionPlanItems(plan: ExecutionPlan | undefined): boolean {
  return plan?.items.some((item) => item.status === "pending" || item.status === "in_progress") ?? false;
}

export function renderExecutionPlanSnapshot(plan: ExecutionPlan | undefined, maxItems = 7): string | undefined {
  if (plan === undefined || plan.items.length === 0) return undefined;
  const rows = plan.items.slice(0, Math.max(0, maxItems)).map((item) => {
    const title = item.title.length > 120 ? `${item.title.slice(0, 119)}…` : item.title;
    return `- ${item.id} [${item.status}]: ${title}`;
  });
  if (plan.items.length > rows.length) rows.push(`- … ${plan.items.length - rows.length} more item(s)`);
  return `Current execution plan (revision ${plan.revision}):\n${rows.join("\n")}`;
}
