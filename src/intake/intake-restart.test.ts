// AC13 (flow 403): a restart between accepting a press and finishing it never creates a second flow. A card left in
// `taking` adopts a flow that was made for it, or goes to `failed` with a reason, and a later press is idempotent.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decideIntakeCard, recoverIntakeTaking, type IntakeActionDeps } from "./actions";
import { OTHER_REPO, makeFakes, seedCard } from "./intake-actions.test-helpers";
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

  test("a project lookup that throws fails that card only; the cards after it are still recovered (F-002)", async () => {
    const first = await seedCard(env.root, { repo: OTHER_REPO });
    const second = await seedCard(env.root);
    for (const card of [first, second]) await appendIntakeIfState(env.root, card.id, INTAKE_OPEN_STATES, { state: "taking", choice: "take", decidedBy: "4242" });
    const fakes = makeFakes();
    const projectFor: NonNullable<IntakeActionDeps["projectFor"]> = (repo) => {
      if (repo === OTHER_REPO) throw new Error("registry unreadable");
      return fakes.deps.projectFor?.(repo);
    };
    expect(await recoverIntakeTaking(env.root, { deps: { ...fakes.deps, projectFor }, now: later })).toBe(2);
    const view = (await readIntakeCardView(env.root, first.id))!;
    expect(view.state).toBe("failed");
    expect(view.reason).toContain("interrupted");
    expect((await readIntakeCardView(env.root, second.id))?.state).toBe("failed");
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

  /** Resolves once `condition` holds; a condition that never holds fails the test instead of hanging it. */
  async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
    for (let i = 0; i < 400; i += 1) {
      if (await condition()) return;
      await Bun.sleep(5);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  function held(fakes: ReturnType<typeof makeFakes>): () => void {
    let open: () => void = () => undefined;
    fakes.flows.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    return () => open();
  }

  test("two presses queued behind slow flow inits are not recovered while they are alive, however old their claims look", async () => {
    const a = await seedCard(env.root);
    const b = await seedCard(env.root);
    const fakes = makeFakes();
    const release = held(fakes);
    const claimedAt = new Date();
    const pressA = decideIntakeCard(env.root, a.id, "take", { decidedBy: "tui", now: claimedAt, deps: fakes.deps });
    const pressB = decideIntakeCard(env.root, b.id, "take", { decidedBy: "tui", now: claimedAt, deps: fakes.deps });
    await until(() => fakes.flows.initCalls.length === 2, "both presses to reach flow init");
    // 160 s later (two ~80 s inits in a queue): older than the flat cutoff, yet both presses are running
    const recovered = await recoverIntakeTaking(env.root, { deps: fakes.deps, now: () => new Date(claimedAt.getTime() + INTAKE_LONGEST_PORT_TIMEOUT_MS + 10_000) });
    expect(recovered).toBe(0);
    expect((await readIntakeCardView(env.root, a.id))?.state).toBe("taking");
    expect((await readIntakeCardView(env.root, b.id))?.state).toBe("taking");

    release();
    const [ra, rb] = await Promise.all([pressA, pressB]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(ra.message).toContain("Взято в работу");
    expect((await readIntakeCardView(env.root, a.id))?.state).toBe("taken");
    expect((await readIntakeCardView(env.root, b.id))?.state).toBe("taken");
    // once the press is over, its claim is no longer protected: nothing is left to recover either
    expect(await recoverIntakeTaking(env.root, aged(fakes))).toBe(0);
  });

  test("a running press refreshes its claim, so a recovery pass in another process sees it alive", async () => {
    const card = await seedCard(env.root, { createdAt: new Date(Date.now() - 2 * 3_600_000) });
    const fakes = makeFakes();
    const release = held(fakes);
    const claimedAt = new Date(Date.now() - 3_600_000);
    const press = decideIntakeCard(env.root, card.id, "take", { decidedBy: "tui", now: claimedAt, deps: { ...fakes.deps, heartbeatMs: 10 } });
    await until(async () => (await readIntakeCardView(env.root, card.id))?.state === "taking", "the claim");
    await until(async () => Date.parse((await readIntakeCardView(env.root, card.id))!.updatedAt) > claimedAt.getTime() + 60_000, "a heartbeat on the claim");
    release();
    expect((await press).ok).toBe(true);
    expect((await readIntakeCardView(env.root, card.id))?.state).toBe("taken");
  });

  test("a press whose taking->taken move the ledger refuses does not announce a success; a second press adopts the flow", async () => {
    const card = await seedCard(env.root);
    const fakes = makeFakes();
    const release = held(fakes);
    const press = decideIntakeCard(env.root, card.id, "take", { decidedBy: "tui", deps: fakes.deps });
    await until(() => fakes.flows.initCalls.length === 1, "the press to reach flow init");
    // another process's recovery pass marks the card failed while the init is still running
    expect((await appendIntakeIfState(env.root, card.id, ["taking"], { state: "failed", reason: "interrupted by a restart; no flow found, check and press again" })).ok).toBe(true);
    release();
    const result = await press;
    expect(result.ok).toBe(false);
    expect(result.message).toContain("flow 412 создан");
    expect(result.message).toContain("failed");
    expect(result.statusLine).toBeUndefined();
    expect((await readIntakeCardView(env.root, card.id))?.state).toBe("failed");

    const second = await decideIntakeCard(env.root, card.id, "take", { decidedBy: "tui", deps: fakes.deps });
    expect(second).toMatchObject({ ok: true, flowId: "412" });
    expect(fakes.flows.initCalls).toHaveLength(1);
    expect((await readIntakeCardView(env.root, card.id))?.state).toBe("taken");
  });

  test("a ci-triage whose decided move is refused says so and still hands back the analysis", async () => {
    const card = await seedCard(env.root, { kind: "ci" });
    const fakes = makeFakes();
    let settle: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const run = fakes.ci.run.bind(fakes.ci);
    fakes.ci.run = async (project, input) => {
      await slow;
      return run(project, input);
    };
    const press = decideIntakeCard(env.root, card.id, "ci-triage", { decidedBy: "tui", deps: fakes.deps });
    await until(async () => (await readIntakeCardView(env.root, card.id))?.state === "taking", "the claim");
    await appendIntakeIfState(env.root, card.id, ["taking"], { state: "failed", reason: "interrupted" });
    settle();
    const result = await press;
    expect(result.ok).toBe(false);
    expect(result.message).toContain("failed");
    expect(result.detail).toContain("timeout");
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
