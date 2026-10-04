// AC11 (flow 403): the guards on a press. A repeat press is "уже решено", a press after the buttons expired is
// "истекло", two presses at once run the action once, and a press whose message is not the card's own is ignored and
// journaled by id and time only.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { decideIntakeCard } from "./actions";
import { intakeDataDir } from "./config";
import { CHAT_ID, FakePressHub, makeFakes, pressFor, seedCard } from "./intake-actions.test-helpers";
import { local, setupIntakeEnv, type IntakeTestEnv } from "./intake.test-helpers";
import { INTAKE_REJECTED_PRESSES_FILE, createIntakePressHandler } from "./press";
import { readIntakeCardView, readIntakeLedger } from "./store";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
});
afterEach(async () => {
  await env.teardown();
});

function handlerFor(fakes = makeFakes(), at = local(10, 42)) {
  const hub = new FakePressHub();
  return { hub, fakes, handler: createIntakePressHandler({ hub, roots: () => [env.root], actionDeps: fakes.deps, now: () => at }) };
}

describe("repeat and expired presses (AC11)", () => {
  test("a second press on a decided card says already decided and does nothing", async () => {
    const card = await seedCard(env.root);
    const { handler, fakes, hub } = handlerFor();
    expect((await handler(pressFor(card, "take")))?.text).toContain("flow 412");
    expect(await handler(pressFor(card, "take", { updateId: 2 }))).toEqual({ text: "уже решено" });
    expect(await handler(pressFor(card, "decline", { updateId: 3 }))).toEqual({ text: "уже решено" });
    expect(fakes.flows.initCalls).toHaveLength(1);
    expect(hub.edits).toHaveLength(1);
  });

  test("a press after the buttons expired says expired, marks the card expired and does nothing", async () => {
    const card = await seedCard(env.root, { ttlHours: 24 });
    const { handler, fakes } = handlerFor(makeFakes(), local(10, 0, 7));
    expect(await handler(pressFor(card, "take"))).toEqual({ text: "истекло" });
    expect(fakes.flows.initCalls).toEqual([]);
    expect((await readIntakeCardView(env.root, card.id))!.state).toBe("expired");
    expect(await handler(pressFor(card, "take", { updateId: 2 }))).toEqual({ text: "истекло" });
  });

  test("an unknown card and unreadable data get a short answer and change nothing", async () => {
    const { handler, fakes } = handlerFor();
    expect((await handler({ ...pressFor(await seedCard(env.root), "take"), data: "in:cdeadbeef000:t" }))?.text).toBe("Карточка не найдена");
    expect((await handler({ ...pressFor(await seedCard(env.root), "take"), data: "in:garbage" }))?.text).toBe("Кнопка не распознана");
    expect(fakes.flows.initCalls).toEqual([]);
  });
});

describe("concurrent presses (AC11)", () => {
  test("two takes at once run flow init once; the second is refused", async () => {
    const card = await seedCard(env.root);
    const fakes = makeFakes();
    let open!: () => void;
    fakes.flows.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { handler } = handlerFor(fakes);
    const first = handler(pressFor(card, "take"));
    const second = handler(pressFor(card, "take", { updateId: 2 }));
    await Bun.sleep(20);
    open();
    const replies = (await Promise.all([first, second])).map((r) => r?.text);
    expect(fakes.flows.initCalls).toHaveLength(1);
    expect(fakes.flows.flows).toHaveLength(1);
    expect(replies.filter((t) => t?.includes("flow 412"))).toHaveLength(1);
    // whether the second press read the card in `taking` or already `taken` depends on scheduling; both refuse
    expect(replies.filter((t) => t === "уже выполняется" || t === "уже решено")).toHaveLength(1);
  });

  test("a take and a decline at once: exactly one wins", async () => {
    const card = await seedCard(env.root);
    const fakes = makeFakes();
    const results = await Promise.all([
      decideIntakeCard(env.root, card.id, "take", { decidedBy: "1", deps: fakes.deps }),
      decideIntakeCard(env.root, card.id, "decline", { decidedBy: "2", deps: fakes.deps }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const final = (await readIntakeCardView(env.root, card.id))!;
    expect(final.choice).toBe(results[0]!.ok ? "take" : "decline");
    expect(fakes.flows.flows).toHaveLength(results[0]!.ok ? 1 : 0);
  });

  test("the ledger holds one decision record per accepted press", async () => {
    const card = await seedCard(env.root);
    const fakes = makeFakes();
    await Promise.all([1, 2, 3, 4].map((n) => decideIntakeCard(env.root, card.id, "decline", { decidedBy: String(n), deps: fakes.deps })));
    const decided = (await readIntakeLedger(env.root)).filter((r) => r.cardId === card.id && r.state === "decided");
    expect(decided).toHaveLength(1);
  });
});

describe("a press that does not match the card (AC11)", () => {
  async function journal(): Promise<string> {
    return readFile(path.join(intakeDataDir(env.root), INTAKE_REJECTED_PRESSES_FILE), "utf8");
  }

  test("another message id is ignored: no reply, no decision, no edit, and the journal has ids and time only", async () => {
    const card = await seedCard(env.root, { title: "Secret ticket title", assessment: "Secret assessment" });
    const { handler, fakes, hub } = handlerFor(makeFakes(), local(10, 42));
    const reply = await handler(pressFor(card, "take", { messageId: card.messageId + 1, updateId: 31 }));
    expect(reply).toBeUndefined();
    expect(fakes.flows.initCalls).toEqual([]);
    expect(hub.edits).toEqual([]);
    expect((await readIntakeCardView(env.root, card.id))!.state).toBe("sent");
    const line = JSON.parse((await journal()).trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ at: local(10, 42).toISOString(), updateId: 31, cardId: card.id });
    const raw = await journal();
    expect(raw).not.toContain("Secret");
    expect(raw).not.toContain(String(card.content.title));
  });

  test("another chat is ignored the same way", async () => {
    const card = await seedCard(env.root);
    const { handler, fakes } = handlerFor();
    expect(await handler(pressFor(card, "take", { chatId: CHAT_ID - 1 }))).toBeUndefined();
    expect(fakes.flows.initCalls).toEqual([]);
    expect(await journal()).toContain(card.id);
  });

  test("a card still waiting in the durable queue is not decidable yet", async () => {
    const card = await seedCard(env.root, { delivered: false });
    const { handler } = handlerFor();
    expect((await handler(pressFor(card, "take")))?.text).toBe("карточка ещё не доставлена");
    expect((await readIntakeCardView(env.root, card.id))!.state).toBe("queued");
  });

  test("a card delivered later by the queue learns its ids from the first press, keeping the send time", async () => {
    const card = await seedCard(env.root, { withoutIds: true });
    const { handler, hub } = handlerFor(makeFakes(), local(10, 42));
    expect((await handler(pressFor(card, "take")))?.text).toContain("flow 412");
    const view = (await readIntakeCardView(env.root, card.id))!;
    expect(view).toMatchObject({ state: "taken", chatId: String(CHAT_ID), messageId: String(card.messageId) });
    expect(view.timeToAnswerMs).toBe(42 * 60_000);
    expect(hub.edits).toHaveLength(1);
  });
});
