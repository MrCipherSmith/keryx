import { expect, test } from "bun:test";
import { makeRig } from "./remote.http.test-helpers";
import { OWNER_ID, until } from "./remote.test-helpers";

test("a projected choice claims the verified sender before resolving", async () => {
  const rig = makeRig();
  try {
    await rig.startServe();
    const client = rig.makeClient({ sessionId: "choice-claim", project: "/project", onLine: () => {} });
    const started = await client.start();
    if (!started.ok) throw new Error("registration failed");
    let observed = 0;
    const answer = client.askChoice("Choose", [["One"], ["Two"]], 10_000, { claim: (_index, actor) => { observed = actor; return false; } });
    await until(() => rig.api.sentTo(started.threadId).some((message) => message.inlineKeyboard !== undefined));
    const message = rig.api.sentTo(started.threadId).find((item) => item.inlineKeyboard !== undefined);
    const data = message?.inlineKeyboard?.[0]?.[0]?.callback_data;
    if (message === undefined || data === undefined) throw new Error("missing choice");
    rig.api.pushCallback({ fromId: OWNER_ID, threadId: started.threadId, messageId: message.messageId, data });
    expect(await answer).toEqual({ kind: "none" });
    expect(observed).toBe(OWNER_ID);
  } finally { await rig.cleanup(); }
});
