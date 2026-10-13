// AC1 and AC2 (flow 419): an approval the shell raises reaches the topic with its buttons; an answer in the
// shell takes the buttons away (the topic text says "Answered in the shell"), a stopped turn says "Cancelled",
// and a press that comes after finds nothing to answer. Real client and serve over loopback, fake Bot API.

import { afterEach, describe, expect, test } from "bun:test";
import type { RemoteClient } from "./client";
import type { FakeSentMessage } from "./fake-bot-api";
import { makeRig, type Rig } from "./remote.http.test-helpers";
import { OWNER_ID, until } from "./remote.test-helpers";

let rig: Rig;
afterEach(async () => {
  await rig.cleanup();
});

async function session(sessionId: string): Promise<{ client: RemoteClient; threadId: number }> {
  const client = rig.makeClient({ sessionId, project: "/work/mirror", name: "mirror", onLine: () => undefined });
  const started = await client.start();
  if (!started.ok) throw new Error(`session did not start: ${started.message}`);
  return { client, threadId: started.threadId };
}

async function untilPrompt(threadId: number): Promise<{ message: FakeSentMessage; allow: string; deny: string }> {
  const find = (): FakeSentMessage | undefined => rig.api.sentTo(threadId).find((message) => message.inlineKeyboard !== undefined);
  await until(() => find() !== undefined, "the approval buttons in the topic");
  const message = find() as FakeSentMessage;
  const buttons = (message.inlineKeyboard ?? []).flat();
  const allow = buttons.find((button) => button.text === "Allow")?.callback_data;
  const deny = buttons.find((button) => button.text === "Deny")?.callback_data;
  if (allow === undefined || deny === undefined) throw new Error("no Allow and Deny buttons");
  return { message, allow, deny };
}

function current(messageId: number): FakeSentMessage {
  const message = rig.api.message(messageId);
  if (message === undefined) throw new Error(`message ${messageId} is not in the topic`);
  return message;
}

describe("an approval raised in the shell", () => {
  test("AC1: the prompt reaches the outbound log with Allow and Deny", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-mir-0001");
    const abort = new AbortController();
    void client.askApproval("Run `bun test`?", 10_000, { signal: abort.signal });
    const prompt = await untilPrompt(threadId);
    expect(prompt.message.text).toContain("Run `bun test`?");
    expect(rig.api.sentTo(threadId).some((message) => message.inlineKeyboard !== undefined)).toBe(true);
    abort.abort("shell");
  });

  test("AC2, shell first: the buttons go, the text says it was answered in the shell, a late press changes nothing", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-mir-0002");
    const abort = new AbortController();
    const asked = client.askApproval("Delete the build directory?", 10_000, { signal: abort.signal });
    const prompt = await untilPrompt(threadId);

    abort.abort("shell");
    expect((await asked).decision).toBe("deny");
    await until(() => current(prompt.message.messageId).inlineKeyboard === undefined, "the buttons to go");
    expect(current(prompt.message.messageId).text).toContain("Answered in the shell");

    const textAfterShell = current(prompt.message.messageId).text;
    rig.api.pushCallback({ fromId: OWNER_ID, data: prompt.allow, threadId, messageId: prompt.message.messageId });
    await until(() => rig.api.answeredCallbacks.length >= 1, "the late press to be answered");
    expect(current(prompt.message.messageId).text).not.toContain("Allowed by");
    expect(current(prompt.message.messageId).inlineKeyboard).toBeUndefined();
    expect(textAfterShell).toContain("Answered in the shell");
  });

  test("AC2, a stopped turn says the approval is no longer open", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-mir-0003");
    const abort = new AbortController();
    const asked = client.askApproval("Write the file?", 10_000, { signal: abort.signal });
    const prompt = await untilPrompt(threadId);

    abort.abort("cancelled");
    await asked;
    await until(() => current(prompt.message.messageId).inlineKeyboard === undefined, "the buttons to go");
    expect(current(prompt.message.messageId).text).toContain("Cancelled at ");
  });

  test("AC2, topic first: the press resolves the shell exactly once and a shell abort afterwards changes nothing", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-mir-0004");
    const abort = new AbortController();
    const asked = client.askApproval("Run the migration?", 10_000, { signal: abort.signal });
    const prompt = await untilPrompt(threadId);

    rig.api.pushCallback({ fromId: OWNER_ID, data: prompt.allow, threadId, messageId: prompt.message.messageId });
    const answer = await asked;
    expect(answer.decision).toBe("allow");
    await until(() => current(prompt.message.messageId).text.includes("Allowed by user"), "the edit");

    // The shell closes its dock after the topic won: that must not rewrite the final state.
    abort.abort("shell");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(current(prompt.message.messageId).text).toContain("Allowed by user");
    expect(current(prompt.message.messageId).text).not.toContain("Answered in the shell");
  });

  test("a signal that is already aborted never posts a prompt that outlives it", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-mir-0005");
    const abort = new AbortController();
    abort.abort("cancelled");
    const answer = await client.askApproval("Too late", 10_000, { signal: abort.signal });
    expect(answer.decision).toBe("deny");
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (const message of rig.api.sentTo(threadId)) {
      expect(message.inlineKeyboard).toBeUndefined();
    }
  });
});
