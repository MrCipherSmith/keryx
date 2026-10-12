// AC3 (flow 419): an approval or question nobody has answered gets a reminder in the topic after a stated
// interval; an answered one gets none, and the number of reminders is bounded.

import { afterEach, describe, expect, test } from "bun:test";
import type { RemoteClient } from "./client";
import { MAX_PROMPT_REMINDERS } from "./protocol";
import { reminderExcerpt } from "./http-surface";
import { makeRig, type Rig } from "./remote.http.test-helpers";
import { OWNER_ID, until } from "./remote.test-helpers";

let rig: Rig;
afterEach(async () => {
  await rig.cleanup();
});

async function session(sessionId: string): Promise<{ client: RemoteClient; threadId: number }> {
  const client = rig.makeClient({ sessionId, project: "/work/remind", name: "remind", onLine: () => undefined });
  const started = await client.start();
  if (!started.ok) throw new Error(`session did not start: ${started.message}`);
  return { client, threadId: started.threadId };
}

const reminders = (threadId: number): string[] => rig.api.sentTo(threadId).map((m) => m.text).filter((t) => t.startsWith("Reminder:"));

describe("reminders for an unanswered prompt", () => {
  test("an approval nobody answers gets a reminder naming what is asked", async () => {
    rig = makeRig();
    await rig.startServe({ service: { surface: { reminderMs: 40 } } });
    const { client, threadId } = await session("sess-rem-0001");
    const abort = new AbortController();
    void client.askApproval("rm -rf build", 30_000, { signal: abort.signal });
    await until(() => reminders(threadId).length >= 1, "the first reminder");
    const first = reminders(threadId)[0] as string;
    expect(first).toContain("An approval is still waiting");
    expect(first).toContain("rm -rf build");
    expect(first).toContain("It expires at ");
    abort.abort("shell");
  });

  test("reminders stop at the stated number", async () => {
    rig = makeRig();
    await rig.startServe({ service: { surface: { reminderMs: 20 } } });
    const { client, threadId } = await session("sess-rem-0002");
    const abort = new AbortController();
    void client.askApproval("npm publish", 30_000, { signal: abort.signal });
    await until(() => reminders(threadId).length >= MAX_PROMPT_REMINDERS, "every reminder");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(reminders(threadId)).toHaveLength(MAX_PROMPT_REMINDERS);
    abort.abort("shell");
  });

  test("an approval answered before the interval gets no reminder", async () => {
    rig = makeRig();
    await rig.startServe({ service: { surface: { reminderMs: 150 } } });
    const { client, threadId } = await session("sess-rem-0003");
    const asked = client.askApproval("git push", 30_000);
    await until(() => rig.api.sentTo(threadId).some((m) => m.inlineKeyboard !== undefined), "the buttons");
    const message = rig.api.sentTo(threadId).find((m) => m.inlineKeyboard !== undefined)!;
    const allow = (message.inlineKeyboard ?? []).flat().find((b) => b.text === "Allow")!.callback_data;
    rig.api.pushCallback({ fromId: OWNER_ID, data: allow, threadId, messageId: message.messageId });
    expect((await asked).decision).toBe("allow");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reminders(threadId)).toHaveLength(0);
  });

  test("an approval closed in the shell gets no reminder", async () => {
    rig = makeRig();
    await rig.startServe({ service: { surface: { reminderMs: 150 } } });
    const { client, threadId } = await session("sess-rem-0004");
    const abort = new AbortController();
    const asked = client.askApproval("make deploy", 30_000, { signal: abort.signal });
    await until(() => rig.api.sentTo(threadId).some((m) => m.inlineKeyboard !== undefined), "the buttons");
    abort.abort("shell");
    await asked;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reminders(threadId)).toHaveLength(0);
  });
});

describe("reminders for a question", () => {
  test("an ask_user menu nobody answers gets a reminder", async () => {
    rig = makeRig();
    await rig.startServe({ service: { surface: { reminderMs: 40 } } });
    const { client, threadId } = await session("sess-rem-0005");
    const abort = new AbortController();
    void client.askChoice("Which branch should I use?", [["main", "dev"]], 30_000, { signal: abort.signal });
    await until(() => reminders(threadId).length >= 1, "the reminder");
    expect(reminders(threadId)[0]).toContain("A question is still waiting");
    expect(reminders(threadId)[0]).toContain("Which branch should I use?");
    abort.abort("shell");
  });
});

describe("reminderExcerpt", () => {
  test("drops the label and the fence and cuts a long line", () => {
    expect(reminderExcerpt("Approval needed:\n```\nbun test\n```")).toBe("bun test");
    expect(reminderExcerpt(undefined)).toBe("");
    expect(reminderExcerpt("x".repeat(200))).toHaveLength(80);
  });
});
