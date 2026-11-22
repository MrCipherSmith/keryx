import { expect, test } from "bun:test";
import { ProjectedDecision } from "./telegram-decision";

const isChoice = (value: unknown): value is "a" | "b" => value === "a" || value === "b";

test("first valid current projection wins and closes both projections once", async () => {
  const closed: string[] = [];
  let telegramCurrent = false;
  const decision = new ProjectedDecision({ deadline: 200, now: () => 100, current: (source) => source === "desktop" || telegramCurrent,
    validate: isChoice, onSettled: (outcome) => closed.push(outcome.kind) });
  expect(decision.claim("telegram", "a")).toBe(false);
  telegramCurrent = true;
  expect(decision.claim("telegram", "invalid")).toBe(false);
  expect(decision.claim("telegram", "b")).toBe(true);
  expect(decision.claim("desktop", "a")).toBe(false);
  decision.cancel();
  expect(await decision.result).toEqual({ kind: "answered", source: "telegram", value: "b" });
  expect(closed).toEqual(["answered"]);
});

test("deadline and cancellation deny all later answers", async () => {
  let now = 10;
  const expired = new ProjectedDecision({ deadline: 20, now: () => now, current: () => true, validate: isChoice, onSettled: () => {} });
  now = 20;
  expect(expired.claim("desktop", "a")).toBe(false);
  expect(await expired.result).toEqual({ kind: "expired" });
  const cancelled = new ProjectedDecision({ deadline: 100, now: () => now, current: () => true, validate: isChoice, onSettled: () => {} });
  cancelled.cancel();
  expect(cancelled.claim("telegram", "b")).toBe(false);
  expect(await cancelled.result).toEqual({ kind: "cancelled" });
});
