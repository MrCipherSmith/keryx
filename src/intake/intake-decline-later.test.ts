// AC8 (flow 403): decline, skip, ignore and understood record the decision and do nothing else; «Позже» records the
// decision and a reminder time `laterHours` ahead that does not fall in quiet hours.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decideIntakeCard, remindAtFor } from "./actions";
import { inQuietHours } from "./config";
import { makeFakes, seedCard } from "./intake-actions.test-helpers";
import { local, setupIntakeEnv, testConfig, type IntakeTestEnv } from "./intake.test-helpers";
import { readIntakeCardView } from "./store";
import type { IntakeAction, IntakeEventKind } from "./types";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
});
afterEach(async () => {
  await env.teardown();
});

const CASES: readonly [IntakeEventKind, IntakeAction][] = [
  ["issue", "decline"],
  ["review", "skip"],
  ["ci", "ignore"],
  ["comment", "understood"],
  ["board", "understood"],
];

describe("decisions without an action (AC8)", () => {
  test.each(CASES)("%s / %s only records the decision", async (kind, action) => {
    const card = await seedCard(env.root, { kind });
    const fakes = makeFakes();
    const result = await decideIntakeCard(env.root, card.id, action, { decidedBy: "tui", now: local(10, 30), deps: fakes.deps });
    expect(result.ok).toBe(true);
    expect(result.statusLine).toBeDefined();
    expect(fakes.flows.initCalls).toEqual([]);
    expect(fakes.ci.calls).toEqual([]);
    const view = (await readIntakeCardView(env.root, card.id))!;
    expect(view).toMatchObject({ state: "decided", choice: action, decidedBy: "tui" });
    expect(view.flowId).toBeUndefined();
    expect(view.remindAt).toBeUndefined();
    expect(view.decidedAt).toBe(local(10, 30).toISOString());
    expect(view.timeToAnswerMs).toBe(30 * 60_000);
  });

  test("a decided card cannot be decided again", async () => {
    const card = await seedCard(env.root);
    const fakes = makeFakes();
    await decideIntakeCard(env.root, card.id, "decline", { decidedBy: "1", now: local(10, 42), deps: fakes.deps });
    const again = await decideIntakeCard(env.root, card.id, "take", { decidedBy: "1", now: local(10, 42), deps: fakes.deps });
    expect(again).toEqual({ ok: false, message: "уже решено" });
    expect(fakes.flows.initCalls).toEqual([]);
  });
});

describe("«Позже» (AC8)", () => {
  test("records the decision and a reminder laterHours ahead", async () => {
    const card = await seedCard(env.root);
    const fakes = makeFakes();
    const config = testConfig({ laterHours: 4 });
    const result = await decideIntakeCard(env.root, card.id, "later", { decidedBy: "1", now: local(10, 0), deps: { ...fakes.deps, config } });
    expect(result.ok).toBe(true);
    const view = (await readIntakeCardView(env.root, card.id))!;
    expect(view).toMatchObject({ state: "decided", choice: "later" });
    expect(view.remindAt).toBe(local(14, 0).toISOString());
    expect(fakes.flows.initCalls).toEqual([]);
  });

  test("a reminder that would land in quiet hours is moved to their end", async () => {
    const config = testConfig({ laterHours: 4, quietHours: { startHour: 22, endHour: 8 } });
    const at = new Date(remindAtFor(local(19, 0), config));
    expect(inQuietHours(at, config.quietHours)).toBe(false);
    expect(at.getTime()).toBeGreaterThanOrEqual(local(8, 0, 6).getTime());
    expect(at.getTime()).toBeLessThan(local(8, 30, 6).getTime());
  });

  test("a reminder outside quiet hours is not moved", () => {
    const config = testConfig({ laterHours: 4, quietHours: { startHour: 22, endHour: 8 } });
    expect(remindAtFor(local(12, 0), config)).toBe(local(16, 0).toISOString());
  });

  test("the config is read from the project when no override is injected", async () => {
    const card = await seedCard(env.root);
    const result = await decideIntakeCard(env.root, card.id, "later", { decidedBy: "1", now: local(12, 0), deps: makeFakes().deps });
    expect(result.ok).toBe(true);
    const at = new Date((await readIntakeCardView(env.root, card.id))!.remindAt!);
    expect(at.getTime()).toBeGreaterThan(local(12, 0).getTime());
  });
});
