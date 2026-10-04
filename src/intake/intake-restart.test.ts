// AC13 (flow 403): a restart between accepting a press and finishing it never creates a second flow. A card left in
// `taking` adopts a flow that was made for it, or goes to `failed` with a reason, and a later press is idempotent.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decideIntakeCard, recoverIntakeTaking } from "./actions";
import { makeFakes, seedCard } from "./intake-actions.test-helpers";
import { INTAKE_LONGEST_PORT_TIMEOUT_MS } from "./ports";
import { local, setupIntakeEnv, type IntakeTestEnv } from "./intake.test-helpers";
import { appendIntakeIfState, readIntakeCardView } from "./store";
import { INTAKE_OPEN_STATES } from "./types";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
});
afterEach(async () => {
  await env.teardown();
});

/** A clock past the longest port timeout: a claim made "now" has by then no live owner. */
const later = (): Date => new Date(Date.now() + 10 * 60_000);
const aged = (fakes: ReturnType<typeof makeFakes>) => ({ deps: fakes.deps, now: later });

/** What a process that died right after `flow init` leaves: the flow exists, the card says `taking`. */
async function crashAfterInit(card: Awaited<ReturnType<typeof seedCard>>, fakes = makeFakes()) {
  fakes.flows.dieAfterCreate = true;
  await appendIntakeIfState(env.root, card.id, INTAKE_OPEN_STATES, { state: "taking", choice: "take", decidedBy: "4242", decidedAt: local(10, 42).toISOString() });
  // The press path made the flow and then the process died before it wrote `taken`.
  await fakes.flows.init("/fake/projects/keryx", { issueUrl: card.content.url!, source: `${card.content.url} card ${card.id}` }).catch(() => undefined);
  fakes.flows.dieAfterCreate = false;
  return fakes;
}

describe("restart in `taking` (AC13)", () => {
  test("the flow that was made is adopted at start: taken, one flow, nothing repeated", async () => {
    const card = await seedCard(env.root);
    const fakes = await crashAfterInit(card);
    const before = fakes.flows.initCalls.length;
    expect(await recoverIntakeTaking(env.root, aged(fakes))).toBe(1);
    expect(fakes.flows.initCalls).toHaveLength(before);
    expect(fakes.flows.flows).toHaveLength(1);
    expect(await readIntakeCardView(env.root, card.id)).toMatchObject({ state: "taken", flowId: "412", choice: "take" });
  });

  test("a claim younger than the longest port timeout is left alone (its press may still be running); an older one is recovered", async () => {
    const card = await seedCard(env.root);
    const fakes = makeFakes();
    await appendIntakeIfState(env.root, card.id, INTAKE_OPEN_STATES, { state: "taking", choice: "take", decidedBy: "4242" });
    const at = (ms: number) => ({ deps: fakes.deps, now: () => new Date(Date.now() + ms) });
    expect(await recoverIntakeTaking(env.root, at(0))).toBe(0);
    expect(await recoverIntakeTaking(env.root, at(INTAKE_LONGEST_PORT_TIMEOUT_MS - 10_000))).toBe(0);
    expect((await readIntakeCardView(env.root, card.id))?.state).toBe("taking");
    expect(await recoverIntakeTaking(env.root, at(INTAKE_LONGEST_PORT_TIMEOUT_MS + 10_000))).toBe(1);
    expect((await readIntakeCardView(env.root, card.id))?.state).toBe("failed");
  });

  test("with no flow found the card goes to failed with a reason, and init is not run by the recovery", async () => {
    const card = await seedCard(env.root);
    const fakes = makeFakes();
    await appendIntakeIfState(env.root, card.id, INTAKE_OPEN_STATES, { state: "taking", choice: "take", decidedBy: "4242" });
    expect(await recoverIntakeTaking(env.root, aged(fakes))).toBe(1);
    expect(fakes.flows.initCalls).toEqual([]);
    const view = (await readIntakeCardView(env.root, card.id))!;
    expect(view.state).toBe("failed");
    expect(view.reason).toContain("interrupted");
  });

  test("a press after the restart does not make a second flow: it adopts the first", async () => {
    const card = await seedCard(env.root);
    const fakes = await crashAfterInit(card);
    await recoverIntakeTaking(env.root, aged(fakes));
    // `taken` is final, so a re-press is refused outright
    expect(await decideIntakeCard(env.root, card.id, "take", { decidedBy: "4242", deps: fakes.deps })).toEqual({ ok: false, message: "уже решено" });
    expect(fakes.flows.flows).toHaveLength(1);
  });

  test("a failed recovery followed by a press adopts the flow that did get made", async () => {
    const card = await seedCard(env.root);
    const fakes = makeFakes();
    await appendIntakeIfState(env.root, card.id, INTAKE_OPEN_STATES, { state: "taking", choice: "take", decidedBy: "4242" });
    await recoverIntakeTaking(env.root, aged(fakes));
    // the flow turns out to exist after all (the init was still running when the card was marked failed)
    await fakes.flows.init("/fake/projects/keryx", { issueUrl: card.content.url!, source: `${card.content.url} card ${card.id}` });
    const before = fakes.flows.initCalls.length;
    const result = await decideIntakeCard(env.root, card.id, "take", { decidedBy: "4242", now: local(11, 0), deps: fakes.deps });
    expect(result).toMatchObject({ ok: true, flowId: "412" });
    expect(fakes.flows.initCalls).toHaveLength(before);
    expect(fakes.flows.flows).toHaveLength(1);
    expect(await readIntakeCardView(env.root, card.id)).toMatchObject({ state: "taken", flowId: "412" });
  });

  test("a press that dies in the runner leaves a card that a second press completes with one flow", async () => {
    const card = await seedCard(env.root);
    const fakes = makeFakes();
    fakes.flows.dieAfterCreate = true;
    const first = await decideIntakeCard(env.root, card.id, "take", { decidedBy: "4242", deps: fakes.deps });
    expect(first.ok).toBe(false);
    fakes.flows.dieAfterCreate = false;
    const second = await decideIntakeCard(env.root, card.id, "take", { decidedBy: "4242", deps: fakes.deps });
    expect(second).toMatchObject({ ok: true, flowId: "412" });
    expect(fakes.flows.flows).toHaveLength(1);
    expect(fakes.flows.initCalls).toHaveLength(1);
  });

  test("a card that was `taking` for ci-triage is never adopted as a flow", async () => {
    const card = await seedCard(env.root, { kind: "ci" });
    const fakes = makeFakes();
    await appendIntakeIfState(env.root, card.id, INTAKE_OPEN_STATES, { state: "taking", choice: "ci-triage", decidedBy: "4242" });
    await recoverIntakeTaking(env.root, aged(fakes));
    expect((await readIntakeCardView(env.root, card.id))!.state).toBe("failed");
    expect(fakes.ci.calls).toEqual([]);
  });

  test("recovery leaves every other card alone", async () => {
    const card = await seedCard(env.root);
    const done = await seedCard(env.root);
    const fakes = makeFakes();
    await decideIntakeCard(env.root, done.id, "decline", { decidedBy: "1", deps: fakes.deps });
    expect(await recoverIntakeTaking(env.root, aged(fakes))).toBe(0);
    expect((await readIntakeCardView(env.root, card.id))!.state).toBe("sent");
    expect((await readIntakeCardView(env.root, done.id))!.state).toBe("decided");
  });
});
