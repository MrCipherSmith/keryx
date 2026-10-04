// AC16 (flow 403): the work-repository rule is applied when a button is PRESSED, not only when the card is made. A card
// sent while the repository was personal, or before `allowTakeInWork` was switched off, must not start a flow in a
// clone under the work root; and «Открыть ревью-flow» is held to the same rule as «Взять в работу».

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decideIntakeCard, type IntakeActionDeps } from "./actions";
import { FakePressHub, OWNER, PROJECT, makeFakes, pressFor, seedCard } from "./intake-actions.test-helpers";
import { setupIntakeEnv, testConfig, type IntakeTestEnv } from "./intake.test-helpers";
import { createIntakePressHandler } from "./press";
import { readIntakeCardView } from "./store";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
});
afterEach(async () => {
  await env.teardown();
});

const WORK_ROOT = "/fake/projects";

function inWork(allowTakeInWork: boolean): { fakes: ReturnType<typeof makeFakes>; deps: IntakeActionDeps } {
  const fakes = makeFakes();
  return { fakes, deps: { ...fakes.deps, env: { GH_WORK_ROOT: WORK_ROOT }, config: testConfig({ allowTakeInWork }) } };
}

describe("the work-repository rule at press time (AC16)", () => {
  test("take on a card made as personal is refused once its project is under the work root", async () => {
    const card = await seedCard(env.root, { account: "personal", takeAllowed: true });
    const { fakes, deps } = inWork(false);
    const result = await decideIntakeCard(env.root, card.id, "take", { decidedBy: String(OWNER), deps });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("отключено для рабочих репозиториев");
    expect(fakes.flows.initCalls).toEqual([]);
    expect((await readIntakeCardView(env.root, card.id))?.state).toBe("sent");
  });

  test("review-flow is refused the same way, and the card stays open", async () => {
    const card = await seedCard(env.root, { kind: "review", account: "personal" });
    const { fakes, deps } = inWork(false);
    const result = await decideIntakeCard(env.root, card.id, "review-flow", { decidedBy: String(OWNER), deps });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("отключено для рабочих репозиториев");
    expect(fakes.flows.initCalls).toEqual([]);
    expect((await readIntakeCardView(env.root, card.id))?.state).toBe("sent");
  });

  test("with allowTakeInWork on, both go through in the same project", async () => {
    const issue = await seedCard(env.root, { account: "personal" });
    const review = await seedCard(env.root, { kind: "review", account: "personal" });
    const { fakes, deps } = inWork(true);
    expect((await decideIntakeCard(env.root, issue.id, "take", { decidedBy: String(OWNER), deps })).ok).toBe(true);
    expect((await decideIntakeCard(env.root, review.id, "review-flow", { decidedBy: String(OWNER), deps })).ok).toBe(true);
    expect(fakes.flows.initCalls.map((c) => c.project)).toEqual([PROJECT, PROJECT]);
  });

  test("outside the work root the same press is accepted", async () => {
    const card = await seedCard(env.root, { account: "personal" });
    const fakes = makeFakes();
    const deps: IntakeActionDeps = { ...fakes.deps, env: { GH_WORK_ROOT: "/somewhere/else" }, config: testConfig({ allowTakeInWork: false }) };
    expect((await decideIntakeCard(env.root, card.id, "take", { decidedBy: String(OWNER), deps })).ok).toBe(true);
    expect(fakes.flows.initCalls).toHaveLength(1);
  });

  test("a Telegram press on such a card answers with the refusal and starts nothing", async () => {
    const card = await seedCard(env.root, { kind: "review", account: "personal" });
    const { fakes, deps } = inWork(false);
    const hub = new FakePressHub();
    const handler = createIntakePressHandler({ hub, roots: () => [env.root], actionDeps: deps });
    const reply = await handler(pressFor(card, "review-flow"));
    expect(reply?.text).toContain("отключено для рабочих репозиториев");
    expect(fakes.flows.initCalls).toEqual([]);
  });
});
