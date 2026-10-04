// AC7 (flow 403): a take that cannot finish leaves no partial flow. With no matching project, or when `flow init`
// fails, the card goes to `failed` with the reason and the human may press again.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decideIntakeCard } from "./actions";
import { FakePressHub, OTHER_REPO, makeFakes, pressFor, seedCard } from "./intake-actions.test-helpers";
import { local, setupIntakeEnv, type IntakeTestEnv } from "./intake.test-helpers";
import { createIntakePressHandler } from "./press";
import { readIntakeCardView } from "./store";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
});
afterEach(async () => {
  await env.teardown();
});

describe("take that fails (AC7)", () => {
  test("no project has a clone of the repository: failed with the reason, no flow, init never called", async () => {
    const card = await seedCard(env.root, { repo: OTHER_REPO });
    const fakes = makeFakes();
    const result = await decideIntakeCard(env.root, card.id, "take", { decidedBy: "1", deps: fakes.deps });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(OTHER_REPO);
    expect(fakes.flows.initCalls).toEqual([]);
    expect(fakes.flows.flows).toEqual([]);
    const view = (await readIntakeCardView(env.root, card.id))!;
    expect(view.state).toBe("failed");
    expect(view.reason).toContain(OTHER_REPO);
    expect(view.flowId).toBeUndefined();
  });

  test("flow init fails: failed with the reason, no partial flow remains, and a second press works", async () => {
    const card = await seedCard(env.root);
    const fakes = makeFakes();
    fakes.flows.failWith = "flow init failed: gh: not logged in";
    const first = await decideIntakeCard(env.root, card.id, "take", { decidedBy: "1", deps: fakes.deps });
    expect(first.ok).toBe(false);
    expect(first.message).toContain("Можно нажать ещё раз");
    expect(fakes.flows.flows).toEqual([]);
    expect(await readIntakeCardView(env.root, card.id)).toMatchObject({ state: "failed", reason: "flow init failed: gh: not logged in" });

    fakes.flows.failWith = undefined;
    const second = await decideIntakeCard(env.root, card.id, "take", { decidedBy: "1", now: local(11, 0), deps: fakes.deps });
    expect(second).toMatchObject({ ok: true, flowId: "412" });
    expect(fakes.flows.flows).toHaveLength(1);
    expect(await readIntakeCardView(env.root, card.id)).toMatchObject({ state: "taken", flowId: "412" });
  });

  test("a runner that throws is a failure too, not a stuck `taking`", async () => {
    const card = await seedCard(env.root);
    const fakes = makeFakes();
    fakes.flows.dieAfterCreate = true;
    const result = await decideIntakeCard(env.root, card.id, "take", { decidedBy: "1", deps: fakes.deps });
    expect(result.ok).toBe(false);
    expect((await readIntakeCardView(env.root, card.id))!.state).toBe("failed");
  });

  test("a failure reason is redacted and short", async () => {
    const card = await seedCard(env.root);
    const fakes = makeFakes();
    fakes.flows.failWith = `boom ghp_abcdefghijklmnopqrstuvwxyz0123456789 ${"x".repeat(500)}`;
    const result = await decideIntakeCard(env.root, card.id, "take", { decidedBy: "1", deps: fakes.deps });
    const view = (await readIntakeCardView(env.root, card.id))!;
    expect(view.reason!.length).toBeLessThanOrEqual(200);
    expect(view.reason).not.toContain("ghp_");
    expect(result.message).not.toContain("ghp_");
  });

  test("through the button: the toast tells the failure, the card is not edited and keeps its buttons", async () => {
    const card = await seedCard(env.root);
    const fakes = makeFakes();
    fakes.flows.failWith = "flow init failed: exit 1";
    const hub = new FakePressHub();
    const handler = createIntakePressHandler({ hub, roots: () => [env.root], actionDeps: fakes.deps });
    const reply = await handler(pressFor(card, "take"));
    expect(reply?.text).toContain("не вышло");
    expect(hub.edits).toEqual([]);
  });
});
