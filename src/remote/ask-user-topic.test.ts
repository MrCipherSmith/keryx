// Flow 401, AC7: the shell side of an ask_user question put in the Telegram topic. Against a fake
// client: no network, no serve. What the bridge decides: the buttons, the own flag, how an answer maps back.

import { expect, test } from "bun:test";
import type { AskUserRequest } from "../harness/tool/builtin/ask-user-tool";
import type { ChoiceAnswer } from "./client";
import { RemoteBridge, type RemoteBridgeHost, type RemoteClientLike } from "./shell-bridge";

const REQUEST: AskUserRequest = {
  question: "Which way?",
  options: [
    { id: "a", label: "Alpha", description: "the first" },
    { id: "b", label: "Beta", description: "", recommended: true },
  ],
};

interface Asked {
  text: string;
  rows: string[][];
  options: { forUserId?: number; own?: boolean; signal?: AbortSignal };
}

async function bridgeWith(answer: ChoiceAnswer | "throw", connected = true): Promise<{ bridge: RemoteBridge; asked: Asked[]; approvals: string[] }> {
  const asked: Asked[] = [];
  const approvals: string[] = [];
  const host: RemoteBridgeHost = {
    sessionId: () => "sess-1",
    project: () => "/proj",
    isBusy: () => false,
    runLine: () => undefined,
    enqueue: () => undefined,
    notice: () => undefined,
    cancelTurn: () => undefined,
    recordOn: () => undefined,
    recordOff: () => undefined,
    dropQueuedTelegramLines: () => [],
    onChange: () => undefined,
  };
  const bridge = new RemoteBridge({
    host,
    approvalTimeoutMs: 50,
    makeClient: () =>
      ({
        connected,
        name: "topic",
        runTimeoutMs: 0,
        lastHeartbeatAt: undefined,
        start: async () => ({ ok: true, name: "topic", threadId: 7, runTimeoutMs: 0 }),
        close: async () => undefined,
        reply: async () => true,
        requestApproval: async (prompt: string) => {
          approvals.push(prompt);
          return "deny";
        },
        requestChoice: async () => undefined,
        askChoice: async (text: string, rows: string[][], _timeoutMs: number, options: Asked["options"] = {}) => {
          asked.push({ text, rows, options });
          if (answer === "throw") throw new Error("stream dropped");
          return answer;
        },
      }) as RemoteClientLike,
  });
  await bridge.enable();
  return { bridge, asked, approvals };
}

test("the question goes to the topic with one button per option and the own flag", async () => {
  const { bridge, asked } = await bridgeWith({ kind: "none" });
  await bridge.askUser(REQUEST);
  expect(asked).toHaveLength(1);
  expect(asked[0]?.options.own).toBe(true);
  expect(asked[0]?.rows).toEqual([["1. Alpha"], ["2. Beta"]]);
  expect(asked[0]?.text).toContain("Which way?");
  expect(asked[0]?.text).toContain("Alpha");
  expect(asked[0]?.text).toContain("the first");
  expect(asked[0]?.text).toContain("(recommended)");
});

test("a pressed position comes back as that option's id", async () => {
  const { bridge } = await bridgeWith({ kind: "index", index: 1 });
  expect(await bridge.askUser(REQUEST)).toBe("b");
});

test("an own answer comes back as the operator's own text", async () => {
  const { bridge } = await bridgeWith({ kind: "own", text: "do something else" });
  expect(await bridge.askUser(REQUEST)).toEqual({ kind: "own", text: "do something else" });
});

test("no answer, a thrown error and a position outside the options are all no answer", async () => {
  expect(await (await bridgeWith({ kind: "none" })).bridge.askUser(REQUEST)).toBeUndefined();
  expect(await (await bridgeWith("throw")).bridge.askUser(REQUEST)).toBeUndefined();
  expect(await (await bridgeWith({ kind: "index", index: 9 })).bridge.askUser(REQUEST)).toBeUndefined();
});

test("without a connection nothing is asked", async () => {
  const { bridge, asked } = await bridgeWith({ kind: "own", text: "x" }, false);
  expect(await bridge.askUser(REQUEST)).toBeUndefined();
  expect(asked).toEqual([]);
});

test("the abort signal reaches the client so the topic question can be closed", async () => {
  const { bridge, asked } = await bridgeWith({ kind: "none" });
  const abort = new AbortController();
  await bridge.askUser(REQUEST, abort.signal);
  expect(asked[0]?.options.signal).toBe(abort.signal);
});

test("an approval never goes through the question path: no own flag is ever asked for it", async () => {
  const { bridge, asked, approvals } = await bridgeWith({ kind: "own", text: "yes" });
  const answer = await bridge.askApproval("Run `ls`?");
  expect(answer.decision).toBe("deny");
  expect(approvals).toHaveLength(1);
  expect(asked).toEqual([]);
});
