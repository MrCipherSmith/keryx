// Flow 403: what the stores and the delivery promise when things go wrong halfway.
//   L4  a card put back in `queued` or `sent` is a NEW message: the old message ids and decision go
//   L5  the ledger line is written before the registry entry, and either half-card is healed by the next call
//   L6  the buttons live from the moment the card goes out, not from the moment it was made
//   L7  an overflow card learns its new count, a decision from another surface reaches the Telegram card, the hourly
//       allowance counts cards (not records), a failed record of a sent card is reported, the seen-cap evicts by time
// Everything runs on fakes: FakeGh, FakeSink, a clock the test moves.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { decideIntakeCard } from "./actions";
import { FakePressHub, makeFakes, pressFor, seedCard } from "./intake-actions.test-helpers";
import { FakeGh, FakeSink, TestClock, depsFor, issuesJson, local, setupIntakeEnv, takeBaseline, testConfig, type IntakeTestEnv } from "./intake.test-helpers";
import { flushIntakeCards, runIntakePoll } from "./poll";
import { createIntakePressHandler } from "./press";
import {
  INTAKE_SEEN_CAP,
  appendIntakeIfState,
  appendIntakeRecord,
  foldIntakeLedger,
  intakeCardsPath,
  intakeLedgerPath,
  markIntakeSeen,
  readIntakeCardView,
  readIntakeCardViews,
  readIntakeCards,
  readIntakeLedger,
  readIntakeState,
  registerIntakeCard,
  updateIntakeState,
} from "./store";
import type { IntakeCardContent, IntakeLedgerRecord } from "./types";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
  env.setBoard([]);
});
afterEach(async () => {
  await env.teardown();
});

const issues = (from: number, to: number): string => issuesJson(Array.from({ length: to - from + 1 }, (_, i) => ({ number: from + i, updatedAt: `2026-10-05T10:${String(i).padStart(2, "0")}:00Z` })));

function content(id = "cdeadbeef001"): IntakeCardContent {
  return {
    id,
    eventKey: `issue:owner/name#${id}`,
    stamp: "2026-10-05T10:00:00Z",
    kind: "issue",
    repo: "owner/name",
    ref: "1",
    title: "A ticket",
    url: "https://github.com/owner/name/issues/1",
    actions: ["take", "decline", "later"],
    takeAllowed: true,
    account: "personal",
    createdAt: local(10).toISOString(),
    expiresAt: local(10, 0, 6).toISOString(),
  };
}

describe("the ledger fold (L4)", () => {
  const rec = (state: IntakeLedgerRecord["state"], at: Date, extra: Partial<IntakeLedgerRecord> = {}): IntakeLedgerRecord => ({ v: 1, at: at.toISOString(), cardId: "c1", eventKey: "k", kind: "issue", state, ...extra });

  test("a card put back in queued forgets the message it was sent as and the decision taken on it", () => {
    const [card] = foldIntakeLedger([
      rec("queued", local(10)),
      rec("sent", local(10, 1), { chatId: "-100", messageId: "11" }),
      rec("decided", local(10, 2), { choice: "later", decidedBy: "4242", decidedAt: local(10, 2).toISOString(), remindAt: local(14).toISOString() }),
      rec("queued", local(14), { reason: "reminder" }),
    ]);
    expect(card?.state).toBe("queued");
    expect(card?.chatId).toBeUndefined();
    expect(card?.messageId).toBeUndefined();
    expect(card?.choice).toBeUndefined();
    expect(card?.decidedBy).toBeUndefined();
    expect(card?.remindAt).toBeUndefined();
    expect(card?.reminded).toBe(true);
  });

  test("a card sent again carries the ids of the NEW message, and a sent record with no ids drops the old ones", () => {
    const [again] = foldIntakeLedger([rec("queued", local(10)), rec("sent", local(10, 1), { chatId: "-100", messageId: "11" }), rec("queued", local(14), { reason: "reminder" }), rec("sent", local(14, 1), { chatId: "-100", messageId: "42" })]);
    expect(again).toMatchObject({ state: "sent", chatId: "-100", messageId: "42", sentAt: local(14, 1).toISOString() });
    const [noIds] = foldIntakeLedger([rec("queued", local(10)), rec("sent", local(10, 1), { chatId: "-100", messageId: "11" }), rec("sent", local(10, 2))]);
    expect(noIds?.messageId).toBeUndefined();
  });

  test("a press that adopts ids on the same send keeps them (sent -> sent with ids)", () => {
    const [card] = foldIntakeLedger([rec("queued", local(10)), rec("sent", local(10, 1)), rec("sent", local(10, 1), { chatId: "-100", messageId: "7" })]);
    expect(card).toMatchObject({ messageId: "7", sentAt: local(10, 1).toISOString() });
  });
});

describe("a card is registered ledger first, and a half-card is healed (L5)", () => {
  const queuedLines = async (id: string): Promise<number> => (await readIntakeLedger(env.root)).filter((r) => r.cardId === id && r.state === "queued").length;

  test("when the registry cannot be written the ledger line is already there, and the next call completes the card", async () => {
    const card = content();
    // cards.json is a directory: the registry write fails, the ledger write has happened before it
    await mkdir(intakeCardsPath(env.root), { recursive: true });
    await expect(registerIntakeCard(env.root, card)).rejects.toThrow();
    expect(await queuedLines(card.id)).toBe(1);
    expect(await readIntakeCardViews(env.root)).toEqual([]);

    await rm(intakeCardsPath(env.root), { recursive: true });
    expect(await registerIntakeCard(env.root, card)).toBe(true);
    expect(await queuedLines(card.id)).toBe(1);
    expect((await readIntakeCardViews(env.root)).map((c) => c.id)).toEqual([card.id]);
    expect(await registerIntakeCard(env.root, card)).toBe(false);
    expect(await queuedLines(card.id)).toBe(1);
  });

  test("a card in the registry with no ledger line (the older write order) is completed, not skipped", async () => {
    const card = content("cdeadbeef002");
    await mkdir(intakeCardsPath(env.root).replace(/cards\.json$/, ""), { recursive: true });
    await writeFile(intakeCardsPath(env.root), JSON.stringify({ version: 1, cards: { [card.id]: card } }), "utf8");
    expect(await readIntakeCardViews(env.root)).toEqual([]);
    expect(await registerIntakeCard(env.root, card)).toBe(true);
    expect(await queuedLines(card.id)).toBe(1);
    expect((await readIntakeCardView(env.root, card.id))?.state).toBe("queued");
    expect(Object.keys(await readIntakeCards(env.root))).toEqual([card.id]);
  });

  test("a ledger line with no registry entry is completed, and the card is not duplicated in the ledger", async () => {
    const card = content("cdeadbeef003");
    await appendIntakeRecord(env.root, { at: card.createdAt, cardId: card.id, eventKey: card.eventKey, kind: "issue", state: "queued" });
    expect(await readIntakeCardViews(env.root)).toEqual([]);
    expect(await registerIntakeCard(env.root, card)).toBe(true);
    expect(await queuedLines(card.id)).toBe(1);
    expect((await readIntakeCardViews(env.root)).map((c) => c.id)).toEqual([card.id]);
  });
});

describe("the buttons live from the send (L6)", () => {
  test("a card made at 23:00 and held through the quiet hours expires a full lifetime after 08:00, not after 23:00", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(21, 30));
    const sink = new FakeSink();
    const config = testConfig({ buttonTtlHours: 24 });
    const deps = depsFor(env, { gh, clock, sink, config });
    await takeBaseline(env.root, deps, clock);
    clock.set(local(23, 0));
    gh.set("issue", issues(1, 1));
    const poll = await runIntakePoll(env.root, deps);
    const id = poll.cardIds[0]!;
    expect((await readIntakeCards(env.root))[id]?.expiresAt).toBe(local(23, 0, 6).toISOString());

    clock.set(local(8, 0, 6));
    expect((await flushIntakeCards(env.root, deps)).sent).toBe(1);
    const fresh = local(8, 0, 7).toISOString();
    expect(sink.cards[0]?.expiresAt).toBe(fresh);
    expect((await readIntakeCardView(env.root, id))?.expiresAt).toBe(fresh);

    // the old deadline (23:00 on the 6th) passes with the buttons still alive
    clock.set(local(23, 30, 6));
    expect((await flushIntakeCards(env.root, deps)).expired).toBe(0);
    expect((await readIntakeCardView(env.root, id))?.state).toBe("sent");
  });
});

describe("the overflow card (L7)", () => {
  async function overflowCards(): Promise<IntakeCardContent[]> {
    return Object.values(await readIntakeCards(env.root)).filter((c) => c.kind === "overflow");
  }

  test("a card already in Telegram is edited when its count grows, and a refused edit is reported", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const sink = new FakeSink();
    const deps = depsFor(env, { gh, clock, sink, config: testConfig({ cardsPerHour: 1 }) });
    await takeBaseline(env.root, deps, clock);
    gh.set("issue", issues(1, 3));
    await runIntakePoll(env.root, deps);
    const [overflow] = await overflowCards();
    expect(overflow?.collapsedIds).toHaveLength(2);
    expect(sink.edits).toEqual([]);

    clock.advance(5 * 60_000);
    gh.set("issue", issues(1, 5));
    await runIntakePoll(env.root, deps);
    expect(sink.edits).toHaveLength(1);
    expect(sink.edits[0]?.card).toMatchObject({ id: overflow!.id, title: "ещё 4 событий", messageId: expect.any(String) });
    expect(sink.edits[0]?.card.collapsedIds).toHaveLength(4);
    expect(await overflowCards()).toHaveLength(1);

    clock.advance(5 * 60_000);
    sink.editOk = false;
    gh.set("issue", issues(1, 6));
    const refused = await runIntakePoll(env.root, deps);
    expect(refused.failures.map((f) => f.detail).join("\n")).toContain("could not update its count");
    expect((await overflowCards())[0]?.collapsedIds).toHaveLength(5);
  });

  test("while the first overflow card is still queued (its send failed), later events join it: no second overflow card", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const sink = new FakeSink();
    sink.script = [{ ok: true, chatId: "-100", messageId: "1" }, { ok: false, reason: "telegram is down" }];
    const deps = depsFor(env, { gh, clock, sink, config: testConfig({ cardsPerHour: 1 }) });
    await takeBaseline(env.root, deps, clock);
    gh.set("issue", issues(1, 3));
    await runIntakePoll(env.root, deps);
    const [first] = await overflowCards();
    expect((await readIntakeCardView(env.root, first!.id))?.state).toBe("queued");

    clock.advance(1000);
    gh.set("issue", issues(1, 6));
    await runIntakePoll(env.root, deps);
    const all = await overflowCards();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(first!.id);
    expect(all[0]?.collapsedIds).toHaveLength(5);
  });

  test("the hourly allowance counts cards: a press that adopted message ids appended one more sent line for the SAME send", async () => {
    const config = testConfig({ cardsPerHour: 4 });
    const adopted = await seedCard(env.root, { withoutIds: true, createdAt: local(11, 50) });
    await seedCard(env.root, { createdAt: local(11, 50) });
    const fakes = makeFakes();
    const handler = createIntakePressHandler({ hub: new FakePressHub(), roots: () => [env.root], actionDeps: fakes.deps, now: () => local(12) });
    expect((await handler(pressFor(adopted, "decline")))?.text).toBe("Отклонено");
    const sentLines = (await readIntakeLedger(env.root)).filter((r) => r.state === "sent");
    expect(sentLines.length).toBe(3);

    await seedCard(env.root, { delivered: false, createdAt: local(11, 55) });
    await seedCard(env.root, { delivered: false, createdAt: local(11, 55) });
    const sink = new FakeSink();
    const deps = depsFor(env, { gh: new FakeGh(), clock: new TestClock(local(12)), sink, config });
    const flushed = await flushIntakeCards(env.root, deps);
    expect(flushed.sent).toBe(2);
    expect(flushed.collapsed).toBe(0);
    expect(sink.cards.filter((c) => c.kind !== "overflow")).toHaveLength(2);
  });
});

describe("a decision from another surface reaches the Telegram card (L7)", () => {
  test("a TUI or CLI decision leaves a pending edit; the next flush edits the card and forgets the edit", async () => {
    const card = await seedCard(env.root);
    const decided = await decideIntakeCard(env.root, card.id, "decline", { decidedBy: "tui", now: local(12) });
    expect(decided.ok).toBe(true);
    expect(Object.keys((await readIntakeState(env.root)).pendingEdits)).toEqual([card.id]);

    const sink = new FakeSink();
    const deps = depsFor(env, { gh: new FakeGh(), clock: new TestClock(local(12)), sink, config: testConfig() });
    await flushIntakeCards(env.root, deps);
    expect(sink.edits).toHaveLength(1);
    expect(sink.edits[0]?.card.id).toBe(card.id);
    expect(sink.edits[0]?.status).toContain("отклонено");
    expect((await readIntakeState(env.root)).pendingEdits).toEqual({});
  });

  test("a refused edit is kept and retried on the next flush", async () => {
    const card = await seedCard(env.root);
    await decideIntakeCard(env.root, card.id, "decline", { decidedBy: "cli", now: local(12) });
    const sink = new FakeSink();
    sink.editOk = false;
    const deps = depsFor(env, { gh: new FakeGh(), clock: new TestClock(local(12)), sink, config: testConfig() });
    const first = await flushIntakeCards(env.root, deps);
    expect(first.failures.map((f) => f.detail).join("\n")).toContain("retried");
    expect(Object.keys((await readIntakeState(env.root)).pendingEdits)).toEqual([card.id]);

    sink.editOk = true;
    await flushIntakeCards(env.root, deps);
    expect(sink.edits.map((e) => e.card.id)).toEqual([card.id]);
    expect((await readIntakeState(env.root)).pendingEdits).toEqual({});
  });

  test("a card that has no Telegram message has nothing to edit: its pending edit is dropped, not retried forever", async () => {
    const card = await seedCard(env.root, { delivered: false });
    await appendIntakeIfState(env.root, card.id, ["queued"], { state: "sent" });
    await decideIntakeCard(env.root, card.id, "decline", { decidedBy: "tui", now: local(12) });
    expect(Object.keys((await readIntakeState(env.root)).pendingEdits)).toEqual([card.id]);
    const sink = new FakeSink();
    const deps = depsFor(env, { gh: new FakeGh(), clock: new TestClock(local(12)), sink, config: testConfig() });
    await flushIntakeCards(env.root, deps);
    expect(sink.edits).toEqual([]);
    expect((await readIntakeState(env.root)).pendingEdits).toEqual({});
  });

  test("a press edits the card itself and leaves no pending edit behind", async () => {
    const card = await seedCard(env.root);
    const hub = new FakePressHub();
    const handler = createIntakePressHandler({ hub, roots: () => [env.root], actionDeps: makeFakes().deps, now: () => local(12) });
    expect((await handler(pressFor(card, "decline")))?.edited).toBe(true);
    expect(hub.edits).toHaveLength(1);
    expect((await readIntakeState(env.root)).pendingEdits).toEqual({});
  });
});

describe("a card the message of which is out but the ledger cannot say so (L7)", () => {
  test("a ledger that refuses the sent record is a failure of the run, not a sent card", async () => {
    const card = await seedCard(env.root, { delivered: false });
    const sink = new FakeSink();
    // the buttons expire while the message is on its way
    sink.onSend = async () => {
      await appendIntakeIfState(env.root, card.id, ["queued"], { state: "expired", reason: "buttons expired" });
    };
    const deps = depsFor(env, { gh: new FakeGh(), clock: new TestClock(local(12)), sink, config: testConfig() });
    const flushed = await flushIntakeCards(env.root, deps);
    expect(flushed.sent).toBe(0);
    expect(flushed.failures.map((f) => f.detail).join("\n")).toMatch(/sent, but the ledger refused the record \(the card is expired\)/);
    expect((await readIntakeCardView(env.root, card.id))?.state).toBe("expired");
  });

  test.skipIf(process.getuid?.() === 0)("a ledger that cannot be written is a failure of the run too, and nothing counts as sent", async () => {
    const card = await seedCard(env.root, { delivered: false });
    const sink = new FakeSink();
    sink.onSend = () => chmod(intakeLedgerPath(env.root), 0o444);
    const deps = depsFor(env, { gh: new FakeGh(), clock: new TestClock(local(12)), sink, config: testConfig() });
    try {
      const flushed = await flushIntakeCards(env.root, deps);
      expect(flushed.sent).toBe(0);
      expect(flushed.failures.map((f) => f.detail).join("\n")).toContain("the ledger could not be written");
    } finally {
      await chmod(intakeLedgerPath(env.root), 0o644);
    }
    expect((await readIntakeCardView(env.root, card.id))?.state).toBe("queued");
  });
});

describe("the seen-cap evicts the item not seen for the longest (L7)", () => {
  const filler = (n: number): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, "2026-10-05T00:00:00Z"]));

  test("markIntakeSeen moves a key seen again to the end", () => {
    const next = markIntakeSeen({ a: "1", b: "1", c: "1" }, { a: "2", d: "1" });
    expect(Object.keys(next)).toEqual(["b", "c", "a", "d"]);
    expect(next["a"]).toBe("2");
  });

  test("a full state drops the oldest-seen key, and a key just seen again survives however early it was first added", async () => {
    await updateIntakeState(env.root, (s) => ({ ...s, seen: filler(INTAKE_SEEN_CAP) }));
    await updateIntakeState(env.root, (s) => ({ ...s, seen: markIntakeSeen(s.seen, { f0: "2026-10-05T00:00:00Z", fresh: "2026-10-05T01:00:00Z" }) }));
    const seen = (await readIntakeState(env.root)).seen;
    expect(Object.keys(seen)).toHaveLength(INTAKE_SEEN_CAP);
    expect(seen["f0"]).toBeDefined();
    expect(seen["fresh"]).toBeDefined();
    expect(seen["f1"]).toBeUndefined();
  });

  test("a poll that reads a ticket again unchanged keeps it, even when it was the first one ever seen", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const deps = depsFor(env, { gh, clock, sink: new FakeSink(), config: testConfig() });
    gh.set("issue", issues(1, 1));
    await takeBaseline(env.root, deps, clock);
    const [oldest] = Object.keys((await readIntakeState(env.root)).seen);
    expect(oldest).toBeDefined();
    // the ticket is the OLDEST key in a full state
    await updateIntakeState(env.root, (s) => ({ ...s, seen: { [oldest!]: s.seen[oldest!]!, ...filler(INTAKE_SEEN_CAP - 1) } }));
    gh.set("issue", issues(1, 2));
    await runIntakePoll(env.root, deps);
    const seen = (await readIntakeState(env.root)).seen;
    expect(Object.keys(seen)).toHaveLength(INTAKE_SEEN_CAP);
    expect(seen[oldest!]).toBeDefined();
    expect(seen["f0"]).toBeUndefined();
  });
});
