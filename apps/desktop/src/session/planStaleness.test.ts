import { expect, test } from "bun:test";
import type { PlanEntry } from "../acp/types";
import { PLAN_STALE_AFTER_MS, planStaleMinutes } from "./planStaleness";

const entry = (status: PlanEntry["status"]): PlanEntry => ({ content: status, priority: "medium", status });
const open = [entry("completed"), entry("in_progress"), entry("pending")];

test("a plan unchanged for the stale window while the agent works reports its whole minutes", () => {
  expect(planStaleMinutes(open, 0, true, PLAN_STALE_AFTER_MS - 1)).toBeNull();
  expect(planStaleMinutes(open, 0, true, PLAN_STALE_AFTER_MS)).toBe(3);
  expect(planStaleMinutes(open, 0, true, 11 * 60_000 + 59_000)).toBe(11);
});

test("an idle agent, a finished plan or a plan never seen is not called stale", () => {
  const late = 60 * 60_000;
  expect(planStaleMinutes(open, 0, false, late)).toBeNull();
  expect(planStaleMinutes([entry("completed"), entry("completed")], 0, true, late)).toBeNull();
  expect(planStaleMinutes(open, null, true, late)).toBeNull();
});
