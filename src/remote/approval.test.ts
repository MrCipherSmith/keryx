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
import { formatReply } from "./format";
import { checkTelegramHtml, renderTelegramHtml } from "./format-html";
import { asCodeBlock } from "./http-surface";
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
    // The prompt goes out as a code block, so what the operator approves is shown verbatim.
    expect(buttons.message.parseMode).toBe("HTML");
    expect(buttons.message.text).toContain("<pre>");
    expect(parseApprovalCallback(buttons.allow)).toMatchObject({ decision: "allow" });
    expect(parseApprovalCallback(buttons.deny)).toMatchObject({ decision: "deny" });

    press(threadId, buttons.allow, OWNER_ID, buttons.message.messageId);
    expect(await decision).toBe("allow");
    // The question itself is edited into its result; there is no separate follow-up message.
    await until(() => (rig.api.message(buttons.message.messageId)?.text ?? "").includes("Allowed by user"), "the question edited");
    expect(rig.api.message(buttons.message.messageId)?.inlineKeyboard).toBeUndefined();
    expect(textsIn(threadId)).not.toContain("Approval granted.");
    // The press was answered to Telegram, so the button stops spinning.
    await until(() => rig.api.answeredCallbacks.length >= 1, "answerCallbackQuery");
  });

  // Whatever the approval text holds, the operator sees it as ONE literal pre block: no link, no bold, no closing fence.
  const HOSTILE: Array<[string, string]> = [
    ["16 backticks", "`".repeat(16) + "\n[x](https://evil.example) **b**\n" + "`".repeat(16)],
    ["40 backticks", "x" + "`".repeat(40) + "\n[x](https://evil.example)\n**b**"],
    ["a fence closer and a tilde fence", "```\n[x](https://evil.example)\n~~~~~~~~~~~~~~~~~~~~\n**b**\n````````````````````"],
    ["CRLF line endings", "rm -rf /\r\n```\r\n[x](https://evil.example)\r\n**b**"],
    ["a quote and a heading", "> [x](https://evil.example)\n# **b**\n- `a`"],
  ];

  for (const [name, prompt] of HOSTILE) {
    test(`a hostile approval prompt (${name}) stays a single literal pre`, async () => {
      rig = makeRig();
      await rig.startServe();
      const { client, threadId } = await session("sess-ap-9001", "release");
      const decision = client.requestApproval(prompt, 10_000);
      const buttons = await untilButtons(threadId);
      const html = buttons.message.text;
      expect(buttons.message.parseMode).toBe("HTML");
      expect(html.match(/<pre>/g)).toHaveLength(1);
      expect(html.match(/<\/pre>/g)).toHaveLength(1);
      expect(html.startsWith("Approval needed:\n<pre>")).toBe(true);
      expect(html.endsWith("</pre>")).toBe(true);
      expect(html).not.toContain("<a ");
      expect(html).not.toContain("<b>");
      expect(html).not.toContain("<i>");
      const checked = checkTelegramHtml(html);
      expect(checked.ok).toBe(true);
      if (checked.ok) {
        expect(checked.text).toContain("[x](https://evil.example)");
        expect(checked.text).toContain("**b**");
      }
      press(threadId, buttons.deny, OWNER_ID, buttons.message.messageId);
      expect(await decision).toBe("deny");
    });
  }

  test("asCodeBlock gives one pre for any prompt, also when it is long enough to split", () => {
    const prompts = [
      "`".repeat(16),
      "`".repeat(40) + " [x](https://evil.example)",
      "~".repeat(40) + "\n" + "`".repeat(9) + "\n**b**",
      "".padEnd(10, " "),
      "line [x](https://evil.example) **b** `c`\n".repeat(400),
    ];
    for (const prompt of prompts) {
      const parts = formatReply(`Approval needed:\n${asCodeBlock(prompt)}`);
      expect(parts.length).toBeGreaterThan(0);
      for (const part of parts) {
        const html = renderTelegramHtml(part);
        expect(checkTelegramHtml(html).ok).toBe(true);
        expect(html.match(/<pre>/g)).toHaveLength(1);
        expect(html).not.toContain("<a ");
        expect(html).not.toContain("<b>");
        expect(html.endsWith("</pre>") || /<\/pre>$/.test(html.trimEnd())).toBe(true);
      }
    }
  });

  test("Deny denies", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ap-0002", "release");
    const decision = client.requestApproval("Delete the build directory?", 10_000);
    const buttons = await untilButtons(threadId);
    press(threadId, buttons.deny);
    expect(await decision).toBe("deny");
    await until(() => (rig.api.message(buttons.message.messageId)?.text ?? "").includes("Denied by user"), "the question edited");
    expect(rig.api.message(buttons.message.messageId)?.inlineKeyboard).toBeUndefined();
    expect(textsIn(threadId)).not.toContain("Approval denied.");
  });

  test("no press: deny at the timeout, and the topic is told", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-ap-0003", "release");
    const pending = client.requestApproval("Push to origin?", 400);
    const buttons = await untilButtons(threadId);
    const started = Date.now();
    const decision = await pending;
    expect(decision).toBe("deny");
    expect(Date.now() - started).toBeLessThan(2_000);
    // The question is edited into the expiry notice and loses its buttons.
    await until(() => (rig.api.message(buttons.message.messageId)?.text ?? "").includes("Expired at"), "the expiry notice");
    expect(rig.api.message(buttons.message.messageId)?.inlineKeyboard).toBeUndefined();
    const before = textsIn(threadId).length;
    // A late press after the expiry grants nothing and adds no message.
    press(threadId, buttons.allow, OWNER_ID, buttons.message.messageId);
    await settle();
    await settle();
    expect(textsIn(threadId)).not.toContain("Approval granted.");
    expect(textsIn(threadId)).toHaveLength(before);
    expect(rig.api.message(buttons.message.messageId)?.text).toContain("Expired at");
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
    await until(() => (rig.api.message(buttons.message.messageId)?.text ?? "").includes("Allowed by user"), "first edit");
    const after = textsIn(threadId).length;
    press(threadId, buttons.allow);
    press(threadId, buttons.deny);
    await settle();
    await settle();
    // Nothing new is sent, and the message still shows the first answer.
    expect(textsIn(threadId)).toHaveLength(after);
    expect(rig.api.message(buttons.message.messageId)?.text).toContain("Allowed by user");
    expect(rig.api.message(buttons.message.messageId)?.text).not.toContain("Denied by user");
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
