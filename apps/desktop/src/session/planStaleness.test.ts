import { expect, test } from "bun:test";
import type { PlanEntry } from "../acp/types";
import { PLAN_STALE_AFTER_MS, keryxPlanStatus, planStaleMinutes } from "./planStaleness";

/** An entry as keryx's acpPlanEntries sends it: folded ACP status, real status and id in _meta.keryx. */
const entry = (status: string, id = status): PlanEntry => ({
  content: id,
  priority: "medium",
  status: status === "in_progress" ? "in_progress" : status === "completed" || status === "skipped" ? "completed" : "pending",
  _meta: { keryx: { id, status } },
});
const minutes = (n: number) => n * 60_000;
const stale = (plan: PlanEntry[], updatedAt: number | null, now: number, turnStartedAt: number | null = null, busy = true) =>
  planStaleMinutes(plan, { updatedAt, turnStartedAt, busy, now });

test("a plan unchanged for the stale window while the agent works reports its whole minutes", () => {
  const open = [entry("completed"), entry("in_progress")];
  expect(stale(open, 0, PLAN_STALE_AFTER_MS - 1)).toBeNull();
  expect(stale(open, 0, PLAN_STALE_AFTER_MS)).toBe(3);
  expect(stale(open, 0, minutes(11) + 59_000)).toBe(11);
});

test("the quiet time starts at the turn: time between turns never counts", () => {
  const open = [entry("in_progress")];
  // Plan last changed at 0, the next turn started 10 minutes later: one minute into that turn it is not stale.
  expect(stale(open, 0, minutes(11), minutes(10))).toBeNull();
  expect(stale(open, 0, minutes(13), minutes(10))).toBe(3);
  // A plan written during the turn counts from the write.
  expect(stale(open, minutes(12), minutes(16), minutes(10))).toBe(4);
});

test("only keryx's pending and in_progress steps are open: proposed and blocked ones do not make a plan stale", () => {
  const late = minutes(60);
  expect(stale([entry("pending")], 0, late)).toBe(60);
  expect(stale([entry("in_progress")], 0, late)).toBe(60);
  expect(stale([entry("completed"), entry("proposed")], 0, late)).toBeNull();
  expect(stale([entry("skipped"), entry("blocked")], 0, late)).toBeNull();
  expect(keryxPlanStatus(entry("blocked"))).toBe("blocked");
  // An entry without _meta (an older keryx) falls back to its ACP status.
  expect(keryxPlanStatus({ content: "x", priority: "medium", status: "pending" })).toBe("pending");
});

test("an idle agent or a plan never seen is not called stale", () => {
  const late = minutes(60);
  expect(stale([entry("in_progress")], 0, late, null, false)).toBeNull();
  expect(stale([entry("in_progress")], null, late)).toBeNull();
});
