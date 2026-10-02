// AC21: a press on an approval prompt edits the question in place: the buttons go, the text shows
// the result (allowed or denied, by whom, when), and no separate "Approval granted" message is sent.
// A press on an expired or already answered prompt puts the message back to its final state and
// changes nothing else. A failed edit falls back to one short reply and never leaves live buttons.
// (The picker and confirmation prompts of flow 387 reuse the same hub path: picker-callbacks.test.ts.)
// Fake Bot API only.

import { afterEach, describe, expect, test } from "bun:test";
import type { RemoteClient } from "./client";
import type { FakeSentMessage } from "./fake-bot-api";
import { clockText, settledText } from "./http-surface";
import { approvalCallbackData } from "./protocol";
import { makeRig, type Rig } from "./remote.http.test-helpers";
import { OWNER_ID, settle, STRANGER_ID, until } from "./remote.test-helpers";
import { BotApiError } from "./types";

let rig: Rig;
afterEach(async () => {
  await rig.cleanup();
});

async function session(sessionId: string, name: string): Promise<{ client: RemoteClient; threadId: number }> {
  const client = rig.makeClient({ sessionId, project: `/work/${name}`, name, onLine: () => undefined });
  const started = await client.start();
  if (!started.ok) {
    throw new Error(`session ${sessionId} did not start: ${started.message}`);
  }
  return { client, threadId: started.threadId };
}

async function untilPrompt(threadId: number): Promise<{ message: FakeSentMessage; allow: string; deny: string }> {
  const find = (): FakeSentMessage | undefined => rig.api.sentTo(threadId).find((message) => message.inlineKeyboard !== undefined);
  await until(() => find() !== undefined, "the approval buttons in the topic");
  const message = find() as FakeSentMessage;
  const buttons = (message.inlineKeyboard ?? []).flat();
  const allow = buttons.find((button) => button.text === "Allow")?.callback_data;
  const deny = buttons.find((button) => button.text === "Deny")?.callback_data;
  if (allow === undefined || deny === undefined) {
    throw new Error("the approval message has no Allow and Deny buttons");
  }
  return { message, allow, deny };
}

function press(threadId: number, data: string, messageId: number, fromId = OWNER_ID): void {
  rig.api.pushCallback({ fromId, data, threadId, messageId });
}

function current(messageId: number): FakeSentMessage {
  const message = rig.api.message(messageId);
  if (message === undefined) {
    throw new Error(`message ${messageId} is not in the topic`);
  }
  return message;
}

function textsIn(threadId: number): string[] {
  return rig.api.sentTo(threadId).map((message) => message.text);
}

describe("an approval press edits the question in place", () => {
  test("Allow: the buttons go and the text names who and when; nothing else is sent", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ed-0001", "release");
    const decision = client.requestApproval("Run `bun test`?", 10_000);
    const prompt = await untilPrompt(threadId);
    const sentBefore = textsIn(threadId).length;

    press(threadId, prompt.allow, prompt.message.messageId);
    expect(await decision).toBe("allow");
    await until(() => current(prompt.message.messageId).text.includes("Allowed by user"), "the edit");

    const edited = current(prompt.message.messageId);
    expect(edited.inlineKeyboard).toBeUndefined();
    expect(edited.text).toContain(`Allowed by user ${OWNER_ID} at `);
    expect(edited.text).toMatch(/at \d{2}:\d{2}:\d{2} UTC\./);
    // What was asked stays on the message, so the record shows what the answer was for.
    expect(edited.text).toContain("Run `bun test`?");
    expect(edited.parseMode).toBe("HTML");
    expect(textsIn(threadId)).toHaveLength(sentBefore);
    expect(textsIn(threadId)).not.toContain("Approval granted.");
  });

  test("Deny: the same, with the denial", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ed-0002", "release");
    const decision = client.requestApproval("Delete the build directory?", 10_000);
    const prompt = await untilPrompt(threadId);
    press(threadId, prompt.deny, prompt.message.messageId);
    expect(await decision).toBe("deny");
    await until(() => current(prompt.message.messageId).text.includes("Denied by user"), "the edit");
    expect(current(prompt.message.messageId).inlineKeyboard).toBeUndefined();
    expect(textsIn(threadId)).not.toContain("Approval denied.");
  });

  test("the press is answered to Telegram so the button stops spinning", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ed-0003", "release");
    const decision = client.requestApproval("Answer me", 10_000);
    const prompt = await untilPrompt(threadId);
    press(threadId, prompt.allow, prompt.message.messageId);
    await decision;
    await until(() => rig.api.answeredCallbacks.length >= 1, "answerCallbackQuery");
  });

  test("expiry edits the question into the expiry notice and removes the buttons", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ed-0004", "release");
    const pending = client.requestApproval("Push to origin?", 300);
    const prompt = await untilPrompt(threadId);
    expect(await pending).toBe("deny");
    await until(() => current(prompt.message.messageId).text.includes("Expired at"), "the expiry edit");
    expect(current(prompt.message.messageId).inlineKeyboard).toBeUndefined();
    expect(textsIn(threadId).some((text) => text.startsWith("Approval request expired"))).toBe(false);
  });

  test("a late press on an expired prompt edits it to its final state and changes nothing else", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ed-0005", "release");
    const pending = client.requestApproval("Push to origin?", 300);
    const prompt = await untilPrompt(threadId);
    expect(await pending).toBe("deny");
    await until(() => current(prompt.message.messageId).text.includes("Expired at"), "the expiry edit");
    const sentBefore = textsIn(threadId).length;
    const editsBefore = rig.api.edits.length;

    press(threadId, prompt.allow, prompt.message.messageId);
    await settle();
    await settle();
    // The message is already final: nothing new is sent and the text is not turned into an approval.
    expect(textsIn(threadId)).toHaveLength(sentBefore);
    expect(current(prompt.message.messageId).text).toContain("Expired at");
    expect(current(prompt.message.messageId).text).not.toContain("Allowed by");
    expect(current(prompt.message.messageId).inlineKeyboard).toBeUndefined();
    expect(rig.api.edits.length).toBeGreaterThanOrEqual(editsBefore);
    await until(() => rig.api.answeredCallbacks.length >= 1, "the late press is answered");
  });

  test("a replayed press keeps the first answer on the message and sends nothing", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ed-0006", "release");
    const decision = client.requestApproval("Once only", 10_000);
    const prompt = await untilPrompt(threadId);
    press(threadId, prompt.allow, prompt.message.messageId);
    expect(await decision).toBe("allow");
    await until(() => current(prompt.message.messageId).text.includes("Allowed by user"), "the edit");
    const sentBefore = textsIn(threadId).length;
    press(threadId, prompt.allow, prompt.message.messageId);
    press(threadId, prompt.deny, prompt.message.messageId);
    await settle();
    await settle();
    expect(textsIn(threadId)).toHaveLength(sentBefore);
    expect(current(prompt.message.messageId).text).toContain("Allowed by user");
    expect(current(prompt.message.messageId).text).not.toContain("Denied by user");
    expect(current(prompt.message.messageId).inlineKeyboard).toBeUndefined();
  });

  test("a press from someone who is not allowed edits nothing", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ed-0007", "release");
    const decision = client.requestApproval("Install a package?", 500);
    const prompt = await untilPrompt(threadId);
    press(threadId, prompt.allow, prompt.message.messageId, STRANGER_ID);
    await settle();
    expect(current(prompt.message.messageId).inlineKeyboard).toBeDefined();
    expect(current(prompt.message.messageId).text).not.toContain("Allowed by");
    expect(await decision).toBe("deny");
  });

  test("a press from another topic's message cannot edit this prompt", async () => {
    rig = makeRig();
    await rig.startServe();
    const a = await session("sess-ed-0008", "alpha");
    const b = await session("sess-ed-0009", "beta");
    const decision = a.client.requestApproval("Alpha asks", 10_000);
    const prompt = await untilPrompt(a.threadId);
    press(b.threadId, prompt.allow, prompt.message.messageId);
    await settle();
    await settle();
    expect(current(prompt.message.messageId).inlineKeyboard).toBeDefined();
    press(a.threadId, prompt.allow, prompt.message.messageId);
    expect(await decision).toBe("allow");
  });

  test("an id the server never issued edits the pressed message to a final state, never to an approval", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ed-0010", "release");
    const decision = client.requestApproval("Forge me", 10_000);
    const live = await untilPrompt(threadId);
    // A stale button on an older message (an id lost to a restart): its message is closed out.
    const stale = await rig.api.sendMessage({
      chatId: rig.api.chatId,
      messageThreadId: threadId,
      text: "Approval needed: old",
      inlineKeyboard: [[{ text: "Allow", callback_data: approvalCallbackData("ap000000000000", "allow") }]],
    });
    press(threadId, approvalCallbackData("ap000000000000", "allow"), stale.message_id);
    await until(() => current(stale.message_id).inlineKeyboard === undefined, "the stale buttons removed");
    expect(current(stale.message_id).text).toContain("no longer active");
    // The live prompt is untouched and still decides.
    expect(current(live.message.messageId).inlineKeyboard).toBeDefined();
    press(threadId, live.allow, live.message.messageId);
    expect(await decision).toBe("allow");
  });

  test("losing the shell removes the buttons from the question", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    const { client, threadId } = await session("sess-ed-0011", "release");
    const decision = client.requestApproval("Will serve survive?", 30_000);
    const prompt = await untilPrompt(threadId);
    await client.drop();
    expect(await decision).toBe("deny");
    await until(() => current(prompt.message.messageId).inlineKeyboard === undefined, "the buttons removed");
    expect(current(prompt.message.messageId).text).toContain("Cancelled at");
    await serve.stop();
  });
});

describe("a failed edit never leaves live buttons behind", () => {
  test("edit refused: the buttons are removed and ONE short reply says the result", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ed-0020", "release");
    const decision = client.requestApproval("Run it?", 10_000);
    const prompt = await untilPrompt(threadId);
    const sentBefore = textsIn(threadId).length;
    rig.api.failNext("editMessageText", new BotApiError("rejected", "editMessageText: 400 Bad Request: message can't be edited", { status: 400 }));

    press(threadId, prompt.allow, prompt.message.messageId);
    expect(await decision).toBe("allow");
    await until(() => textsIn(threadId).includes("Approval granted."), "the short reply");
    expect(current(prompt.message.messageId).inlineKeyboard).toBeUndefined();
    expect(textsIn(threadId).filter((text) => text === "Approval granted.")).toHaveLength(1);
    expect(textsIn(threadId)).toHaveLength(sentBefore + 1);
  });

  test("a network failure on the edit takes the same fallback", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ed-0021", "release");
    const decision = client.requestApproval("Run it?", 10_000);
    const prompt = await untilPrompt(threadId);
    rig.api.failNext("editMessageText", new BotApiError("network", "editMessageText: request failed"));
    press(threadId, prompt.deny, prompt.message.messageId);
    expect(await decision).toBe("deny");
    await until(() => textsIn(threadId).includes("Approval denied."), "the short reply");
    expect(current(prompt.message.messageId).inlineKeyboard).toBeUndefined();
  });

  test("when the question is gone the result is still said once", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ed-0022", "release");
    const decision = client.requestApproval("Run it?", 10_000);
    const prompt = await untilPrompt(threadId);
    // The edit finds no message to edit and the markup removal does not either.
    rig.api.failNext("editMessageText", new BotApiError("rejected", "editMessageText: 400 Bad Request: message to edit not found", { status: 400 }), 1);
    rig.api.failNext("editMessageReplyMarkup", new BotApiError("rejected", "editMessageReplyMarkup: 400 Bad Request: message to edit not found", { status: 400 }), 1);
    press(threadId, prompt.allow, prompt.message.messageId);
    expect(await decision).toBe("allow");
    await until(() => textsIn(threadId).includes("Approval granted."), "the short reply");
    expect(textsIn(threadId).filter((text) => text === "Approval granted.")).toHaveLength(1);
  });
});

describe("the final text helpers", () => {
  test("clockText is a UTC clock", () => {
    expect(clockText(Date.UTC(2026, 9, 2, 4, 5, 6))).toBe("04:05:06 UTC");
  });

  test("settledText keeps what was asked, and stays under the message limit", () => {
    expect(settledText("Approval needed:", "Allowed.")).toBe("Approval needed:\n\nAllowed.");
    expect(settledText(undefined, "Allowed.")).toBe("Allowed.");
    expect(settledText("x".repeat(5_000), "Allowed.")).toBe("Allowed.");
  });
});
