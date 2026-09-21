import {
  EXECUTION_PLAN_STATUSES,
  getExecutionPlan,
  setExecutionPlan,
  updateExecutionPlan,
  type ExecutionPlanItem,
  type ExecutionPlanStatus,
} from "../../../session/execution-plan";
import type { InteractiveTool } from "./interactive-tools";

const statusSchema = { type: "string", enum: [...EXECUTION_PLAN_STATUSES] } as const;

function noSession(name: string): { output: string; isError: true } {
  return { output: `${name}: no active session in this run`, isError: true };
}

function failed(name: string, cause: unknown): { output: string; isError: true } {
  return { output: `${name} failed: ${cause instanceof Error ? cause.message : String(cause)}`, isError: true };
}

export function executionPlanTools(getSessionDir: () => string | undefined): InteractiveTool[] {
  const get: InteractiveTool = {
    definition: {
      name: "plan_get",
      description: "Read the current structured execution plan. Input: {}.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
    },
    invoke: async () => {
      const dir = getSessionDir();
      if (dir === undefined) return noSession("plan_get");
      try {
        return { output: JSON.stringify((await getExecutionPlan(dir)) ?? null, null, 2), isError: false };
      } catch (cause) {
        return failed("plan_get", cause);
      }
    },
  };

  const set: InteractiveTool = {
    definition: {
      name: "plan_set",
      description: "Replace the structured execution plan using optimistic revision control.",
      inputSchema: {
        type: "object",
        properties: {
          expectedRevision: { type: "integer", minimum: 0 },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, status: statusSchema },
              required: ["id", "title", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["expectedRevision", "items"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const dir = getSessionDir();
      if (dir === undefined) return noSession("plan_set");
      try {
        const plan = await setExecutionPlan(dir, {
          expectedRevision: input.expectedRevision as number,
          items: input.items as ExecutionPlanItem[],
        });
        return { output: JSON.stringify(plan, null, 2), isError: false };
      } catch (cause) {
        return failed("plan_set", cause);
      }
    },
  };

  const update: InteractiveTool = {
    definition: {
      name: "plan_update",
      description: "Update one execution-plan item's status using optimistic revision control.",
      inputSchema: {
        type: "object",
        properties: {
          expectedRevision: { type: "integer", minimum: 0 },
          itemId: { type: "string", minLength: 1 },
          status: statusSchema,
        },
        required: ["expectedRevision", "itemId", "status"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const dir = getSessionDir();
      if (dir === undefined) return noSession("plan_update");
      try {
        const plan = await updateExecutionPlan(dir, {
          expectedRevision: input.expectedRevision as number,
          itemId: input.itemId as string,
          status: input.status as ExecutionPlanStatus,
        });
        return { output: JSON.stringify(plan, null, 2), isError: false };
      } catch (cause) {
        return failed("plan_update", cause);
      }
    },
  };
  return [set, update, get];
}
