// AC7: a shell that needs permission asks in its topic, and the answer is a
// button press by an allowed user. Everything else is a deny.
//
//   - the buttons appear in the session's topic;
//   - a press of Allow by an allowed user grants, a press of Deny denies;
//   - no press means deny at the timeout (and the topic is told);
//   - a stranger's press, a press in another session's topic, a replay and an id
//     the server never issued all change nothing;
//   - losing the connection denies, and so does asking without one.

import { afterEach, describe, expect, test } from "bun:test";
import type { FakeSentMessage } from "./fake-bot-api";
import { approvalCallbackData, parseApprovalCallback } from "./protocol";
import { call, makeRig, type Rig } from "./remote.http.test-helpers";
import { OWNER_ID, settle, STRANGER_ID, until } from "./remote.test-helpers";
import type { RemoteClient } from "./client";

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

/** The message carrying the Allow/Deny buttons, once it is in the topic. */
async function untilButtons(threadId: number): Promise<{ message: FakeSentMessage; allow: string; deny: string }> {
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

function press(threadId: number, data: string, fromId = OWNER_ID, messageId?: number): void {
  rig.api.pushCallback({ fromId, data, threadId, ...(messageId === undefined ? {} : { messageId }) });
}

function textsIn(threadId: number): string[] {
  return rig.api.sentTo(threadId).map((message) => message.text);
}

describe("approval through the topic", () => {
  test("the buttons appear in the topic and Allow grants", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ap-0001", "release");
    const decision = client.requestApproval("Run `bun test`?", 10_000);
    const buttons = await untilButtons(threadId);
    expect(buttons.message.text).toContain("Run `bun test`?");
    expect(parseApprovalCallback(buttons.allow)).toMatchObject({ decision: "allow" });
    expect(parseApprovalCallback(buttons.deny)).toMatchObject({ decision: "deny" });

    press(threadId, buttons.allow, OWNER_ID, buttons.message.messageId);
    expect(await decision).toBe("allow");
    await until(() => textsIn(threadId).includes("Approval granted."), "the follow-up in the topic");
    // The press was answered to Telegram, so the button stops spinning.
    await until(() => rig.api.answeredCallbacks.length >= 1, "answerCallbackQuery");
  });

  test("Deny denies", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ap-0002", "release");
    const decision = client.requestApproval("Delete the build directory?", 10_000);
    const buttons = await untilButtons(threadId);
    press(threadId, buttons.deny);
    expect(await decision).toBe("deny");
    await until(() => textsIn(threadId).includes("Approval denied."), "the follow-up in the topic");
  });

  test("no press: deny at the timeout, and the topic is told", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ap-0003", "release");
    const started = Date.now();
    const decision = await client.requestApproval("Push to origin?", 400);
    expect(decision).toBe("deny");
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    await until(() => textsIn(threadId).some((text) => text.startsWith("Approval request expired")), "the expiry notice");
    // A late press after the expiry grants nothing.
    const buttons = await untilButtons(threadId);
    press(threadId, buttons.allow);
    await settle();
    await settle();
    expect(textsIn(threadId)).not.toContain("Approval granted.");
  });

  test("a press by a sender who is not allowed changes nothing", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ap-0004", "release");
    const decision = client.requestApproval("Install a package?", 600);
    const buttons = await untilButtons(threadId);
    press(threadId, buttons.allow, STRANGER_ID);
    expect(await decision).toBe("deny");
    expect(textsIn(threadId)).not.toContain("Approval granted.");
  });

  test("a press in another session's topic cannot answer this session's approval", async () => {
    rig = makeRig();
    await rig.startServe();
    const a = await session("sess-ap-0005", "alpha");
    const b = await session("sess-ap-0006", "beta");
    const decision = a.client.requestApproval("Alpha asks", 10_000);
    const buttons = await untilButtons(a.threadId);

    press(b.threadId, buttons.allow);
    await settle();
    await settle();
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    await settle();
    expect(settled).toBe(false);

    press(a.threadId, buttons.allow);
    expect(await decision).toBe("allow");
  });

  test("a second press of the same button is a replay and does nothing", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ap-0007", "release");
    const decision = client.requestApproval("Once only", 10_000);
    const buttons = await untilButtons(threadId);
    press(threadId, buttons.allow);
    expect(await decision).toBe("allow");
    await until(() => textsIn(threadId).includes("Approval granted."), "first follow-up");
    press(threadId, buttons.allow);
    press(threadId, buttons.deny);
    await settle();
    await settle();
    expect(textsIn(threadId).filter((text) => text === "Approval granted.")).toHaveLength(1);
    expect(textsIn(threadId)).not.toContain("Approval denied.");
  });

  test("a button for an id the server never issued is dropped", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ap-0008", "release");
    const decision = client.requestApproval("Forge me", 500);
    await untilButtons(threadId);
    press(threadId, approvalCallbackData("ap000000000000", "allow"));
    expect(await decision).toBe("deny");
  });

  test("losing the connection denies what was waiting", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    const { client, threadId } = await session("sess-ap-0009", "release");
    const decision = client.requestApproval("Will serve survive?", 30_000);
    await untilButtons(threadId);
    await serve.stop();
    expect(await decision).toBe("deny");
  });

  test("asking without a connection is a deny, without waiting", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client } = await session("sess-ap-0010", "release");
    await client.drop();
    const started = Date.now();
    expect(await client.requestApproval("Anyone there?", 30_000)).toBe("deny");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("the server refuses an approval when no stream is connected", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    const registered = await call(serve.origin, serve.shellToken, "POST", "/v1/remote/register", { sessionId: "sess-ap-0011", project: "/work/app", name: "release" });
    expect(registered.status).toBe(200);
    const asked = await call(serve.origin, serve.shellToken, "POST", "/v1/remote/approval", { sessionId: "sess-ap-0011", prompt: "No stream", timeoutMs: 1_000 });
    expect(asked.status).toBe(409);
    expect(asked.body).toEqual({ error: { code: "no-stream", message: expect.any(String) } });
  });

  test("a shell cannot attach its own buttons in the approval namespace", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    await call(serve.origin, serve.shellToken, "POST", "/v1/remote/register", { sessionId: "sess-ap-0012", project: "/work/app", name: "release" });
    const forged = await call(serve.origin, serve.shellToken, "POST", "/v1/remote/reply", {
      sessionId: "sess-ap-0012",
      text: "pick",
      keyboard: [[{ text: "Allow", data: approvalCallbackData("ap000000000000", "allow") }]],
    });
    expect(forged.status).toBe(400);
    const fine = await call(serve.origin, serve.shellToken, "POST", "/v1/remote/reply", {
      sessionId: "sess-ap-0012",
      text: "pick",
      keyboard: [[{ text: "Yes", data: "choice:yes" }]],
    });
    expect(fine.status).toBe(200);
  });

  test("approval prompts and replies are redacted before they reach the topic", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ap-0013", "release");
    const secret = `ghp_${"A1b2C3d4E5".repeat(4)}`;
    void client.requestApproval(`Use token ${secret}?`, 500);
    await untilButtons(threadId);
    await client.reply(`the token is ${secret}`);
    await until(() => textsIn(threadId).some((text) => text.startsWith("the token is")), "the reply");
    expect(textsIn(threadId).some((text) => text.includes(secret))).toBe(false);
  });
});
