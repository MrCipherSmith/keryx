// Flow 401, AC7: a question of a Telegram-started turn is shown in the dock and in the topic; the first
// answer wins and the other place is closed. Silence in the topic never closes the dock.

import { expect, test } from "bun:test";
import { raceAskUser } from "./ask-user-race";

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

function dockThatWaitsForAbort(): { run: (signal: AbortSignal) => Promise<string>; aborted: () => string | undefined; answer: (value: string) => void } {
  let aborted: string | undefined;
  let answer: (value: string) => void = () => undefined;
  return {
    run: (signal) =>
      new Promise<string>((resolve) => {
        answer = resolve;
        signal.addEventListener("abort", () => {
          aborted = String(signal.reason);
          resolve("__cancel__");
        });
      }),
    aborted: () => aborted,
    answer: (value) => answer(value),
  };
}

test("the dock answers first: the topic question is aborted as answered in the shell", async () => {
  const dock = dockThatWaitsForAbort();
  let topicReason: unknown;
  const turn = new AbortController();
  const outcome = raceAskUser({
    turnSignal: turn.signal,
    dock: dock.run,
    topic: (signal) => {
      signal.addEventListener("abort", () => (topicReason = signal.reason));
      return never();
    },
  });
  dock.answer("a");
  expect(await outcome).toEqual({ from: "dock", result: "a" });
  expect(topicReason).toBe("shell");
});

test("the topic answers first: the answer wins and the dock is taken down", async () => {
  const dock = dockThatWaitsForAbort();
  const turn = new AbortController();
  const outcome = await raceAskUser({ turnSignal: turn.signal, dock: dock.run, topic: async () => ({ kind: "own", text: "mine" }) });
  expect(outcome).toEqual({ from: "topic", answer: { kind: "own", text: "mine" } });
  expect(dock.aborted()).toBe("topic");
});

test("a pressed option in the topic wins the same way", async () => {
  const dock = dockThatWaitsForAbort();
  const outcome = await raceAskUser({ turnSignal: new AbortController().signal, dock: dock.run, topic: async () => "b" });
  expect(outcome).toEqual({ from: "topic", answer: "b" });
});

test("silence in the topic (no answer, or an error) leaves the dock open and it still decides", async () => {
  for (const topic of [async () => undefined, async (): Promise<undefined> => Promise.reject(new Error("down"))]) {
    const dock = dockThatWaitsForAbort();
    const outcome = raceAskUser({ turnSignal: new AbortController().signal, dock: dock.run, topic });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dock.aborted()).toBeUndefined();
    dock.answer("a");
    expect(await outcome).toEqual({ from: "dock", result: "a" });
  }
});

test("the turn stopping closes both places, the topic one as cancelled", async () => {
  const dock = dockThatWaitsForAbort();
  const turn = new AbortController();
  let topicReason: unknown;
  const outcome = raceAskUser({
    turnSignal: turn.signal,
    dock: dock.run,
    topic: (signal) => {
      signal.addEventListener("abort", () => (topicReason = signal.reason));
      return never();
    },
  });
  turn.abort();
  expect(await outcome).toEqual({ from: "dock", result: "__cancel__" });
  expect(dock.aborted()).toBe("cancelled");
  expect(topicReason).toBe("cancelled");
});

test("a question of a turn typed in the shell has no topic part at all", async () => {
  const dock = dockThatWaitsForAbort();
  const outcome = raceAskUser({ turnSignal: new AbortController().signal, dock: dock.run });
  dock.answer("a");
  expect(await outcome).toEqual({ from: "dock", result: "a" });
});
