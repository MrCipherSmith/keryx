// AC13 (flow 403): only the allowlisted operator can decide a card. This runs the real hub against the fake Bot API:
// a press from a stranger never reaches the intake handler and changes nothing, a press from the operator does the
// action and edits the card in place.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createIntakeCardSink } from "./card";
import { makeFakes, seedCard } from "./intake-actions.test-helpers";
import { local, setupIntakeEnv, type IntakeTestEnv } from "./intake.test-helpers";
import { createIntakePressHandler } from "./press";
import { appendIntakeRecord, readIntakeCardView } from "./store";
import { type Harness, makeHarness, OWNER_ID, STRANGER_ID, until } from "../remote/remote.test-helpers";
import { renderIntakeCard } from "./card";

let env: IntakeTestEnv;
let h: Harness;
beforeEach(async () => {
  env = await setupIntakeEnv();
});
afterEach(async () => {
  await h.cleanup();
  await env.teardown();
});

/** A real hub with the intake press handler registered, and one card actually sent through it. */
async function setup() {
  h = makeHarness();
  const hub = h.makeHub();
  const fakes = makeFakes();
  hub.registerIntakeCallbackHandler(createIntakePressHandler({ hub, roots: () => [env.root], now: () => local(10, 42), actionDeps: fakes.deps }));
  const reg = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
  if (!reg.ok) throw new Error("register failed");
  await hub.start();

  const card = await seedCard(env.root, { delivered: false, assessment: "Small bug." });
  const view = (await readIntakeCardView(env.root, card.id))!;
  const sent = await createIntakeCardSink(hub).sendCard(view);
  if (!sent.ok || sent.chatId === undefined || sent.messageId === undefined) throw new Error("card was not sent");
  await appendIntakeRecord(env.root, { at: view.createdAt, cardId: card.id, eventKey: view.eventKey, kind: "issue", state: "sent", chatId: sent.chatId, messageId: sent.messageId });
  const message = h.api.sent.find((m) => m.messageId === Number(sent.messageId))!;
  return { card, fakes, message, data: message.inlineKeyboard![0]![0]!.callback_data! };
}

describe("allowlist (AC13)", () => {
  test("a press from a stranger reaches nobody: no decision, no flow, no edit", async () => {
    const { card, fakes, message, data } = await setup();
    h.api.pushCallback({ fromId: STRANGER_ID, data, threadId: message.messageThreadId!, messageId: message.messageId });
    // Updates are handled in order, so the operator's press behind it is a positive fence: once it has been decided the
    // stranger's press has been through the hub, and everything it could have done is already visible.
    h.api.pushCallback({ fromId: OWNER_ID, data, threadId: message.messageThreadId!, messageId: message.messageId });
    await until(() => fakes.flows.initCalls.length === 1, "operator take");
    await until(() => h.api.edits.length === 1, "operator edit");
    expect(fakes.flows.initCalls).toHaveLength(1);
    expect(h.api.edits).toHaveLength(1);
    expect((await readIntakeCardView(env.root, card.id))!.decidedBy).toBe(String(OWNER_ID));
  });

  test("a press from the operator takes the card and edits it in place without buttons", async () => {
    const { card, fakes, message, data } = await setup();
    h.api.pushCallback({ fromId: OWNER_ID, data, threadId: message.messageThreadId!, messageId: message.messageId });
    await until(() => h.api.edits.length > 0, "card edited");
    expect(fakes.flows.initCalls).toHaveLength(1);
    expect(await readIntakeCardView(env.root, card.id)).toMatchObject({ state: "taken", flowId: "412", decidedBy: String(OWNER_ID) });
    const edit = h.api.edits[0]!;
    expect(edit.messageId).toBe(message.messageId);
    const after = h.api.sent.find((m) => m.messageId === message.messageId)!;
    expect(after.inlineKeyboard ?? []).toEqual([]);
    expect(renderIntakeCard((await readIntakeCardView(env.root, card.id))!, "✅ взято")).toContain("✅ взято");
    await until(() => h.api.answeredCallbacks.length > 0, "toast");
    expect(h.api.answeredCallbacks[0]!.text).toContain("flow 412");
  });

  test("the stranger's press is the only difference: the same card is still takeable by the operator afterwards", async () => {
    const { card, fakes, message, data } = await setup();
    h.api.pushCallback({ fromId: STRANGER_ID, data, threadId: message.messageThreadId!, messageId: message.messageId });
    h.api.pushCallback({ fromId: OWNER_ID, data, threadId: message.messageThreadId!, messageId: message.messageId });
    await until(() => (h.api.answeredCallbacks as readonly { text?: string }[]).some((c) => c.text?.includes("flow 412") === true), "operator toast");
    expect(fakes.flows.initCalls).toHaveLength(1);
    expect(await readIntakeCardView(env.root, card.id)).toMatchObject({ state: "taken", decidedBy: String(OWNER_ID) });
  });
});
