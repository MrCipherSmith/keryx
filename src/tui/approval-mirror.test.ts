// AC2 (flow 419): an approval raised in the shell is answered once, from whichever place answers first,
// and the other place is taken down. Both orders, plus silence in the topic and a stopped turn.

import { describe, expect, test } from "bun:test";
import type { RemoteApprovalAnswer } from "../remote/shell-bridge";
import { type DockRace, isTopicPress, raceApproval } from "./approval-mirror";

const press = (decision: "allow" | "deny", fromId = 7): RemoteApprovalAnswer => ({ decision, always: false, fromId });
const silence: RemoteApprovalAnswer = { decision: "deny", always: false };

function abortedWith(signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(signal.reason);
    signal.addEventListener("abort", () => resolve(signal.reason), { once: true });
  });
}

describe("isTopicPress", () => {
  test("an allow, or a deny from a named user, is a press; a timeout deny is not", () => {
    expect(isTopicPress(press("allow"))).toBe(true);
    expect(isTopicPress(press("deny"))).toBe(true);
    expect(isTopicPress(silence)).toBe(false);
  });
});

describe("raceApproval", () => {
  test("the dock answers first: the topic leg is aborted with the reason shell", async () => {
    let topicSignal: AbortSignal | undefined;
    const outcome = await raceApproval({
      turnSignal: new AbortController().signal,
      dock: async (race: DockRace) => {
        race.opened();
        return "allowed-in-dock";
      },
      topic: (signal) => {
        topicSignal = signal;
        return new Promise<RemoteApprovalAnswer>(() => undefined);
      },
    });
    expect(outcome).toEqual({ from: "dock", result: "allowed-in-dock" });
    expect(topicSignal?.aborted).toBe(true);
    expect(topicSignal?.reason).toBe("shell");
  });

  test("a press in the topic ends the dock and wins", async () => {
    const answer = press("allow");
    let dockReason: unknown;
    const outcome = await raceApproval({
      turnSignal: new AbortController().signal,
      dock: async (race) => {
        race.opened();
        dockReason = await abortedWith(race.signal);
        expect(race.topicWon()).toBe(true);
        return "ignored";
      },
      topic: async () => answer,
    });
    expect(outcome).toEqual({ from: "topic", answer });
    expect(dockReason).toBe("topic");
  });

  test("a denial pressed in the topic wins too", async () => {
    const answer = press("deny");
    const outcome = await raceApproval({
      turnSignal: new AbortController().signal,
      dock: async (race) => {
        race.opened();
        await abortedWith(race.signal);
        return "ignored";
      },
      topic: async () => answer,
    });
    expect(outcome).toEqual({ from: "topic", answer });
  });

  test("silence in the topic never ends the dock", async () => {
    let dockAbortedEarly = true;
    const outcome = await raceApproval({
      turnSignal: new AbortController().signal,
      dock: async (race) => {
        race.opened();
        await new Promise((resolve) => setTimeout(resolve, 15));
        dockAbortedEarly = race.signal.aborted;
        return "dock";
      },
      topic: async () => silence,
    });
    expect(dockAbortedEarly).toBe(false);
    expect(outcome).toEqual({ from: "dock", result: "dock" });
  });

  test("a topic that fails never ends the dock", async () => {
    const outcome = await raceApproval({
      turnSignal: new AbortController().signal,
      dock: async (race) => {
        race.opened();
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "dock";
      },
      topic: async () => {
        throw new Error("serve is gone");
      },
    });
    expect(outcome).toEqual({ from: "dock", result: "dock" });
  });

  test("the turn stops: the dock closes and the topic leg is told it was cancelled", async () => {
    const turn = new AbortController();
    let topicSignal: AbortSignal | undefined;
    const outcome = await raceApproval({
      turnSignal: turn.signal,
      dock: async (race) => {
        race.opened();
        queueMicrotask(() => turn.abort("cancelled"));
        await abortedWith(race.signal);
        return "stopped";
      },
      topic: (signal) => {
        topicSignal = signal;
        return new Promise<RemoteApprovalAnswer>(() => undefined);
      },
    });
    expect(outcome).toEqual({ from: "dock", result: "stopped" });
    expect(topicSignal?.reason).toBe("cancelled");
  });

  test("a dock that never opens never starts the topic leg", async () => {
    let started = false;
    const outcome = await raceApproval({
      turnSignal: new AbortController().signal,
      dock: async () => "auto-approved",
      topic: () => {
        started = true;
        return new Promise<RemoteApprovalAnswer>(() => undefined);
      },
    });
    expect(outcome).toEqual({ from: "dock", result: "auto-approved" });
    expect(started).toBe(false);
  });

  test("opened() starts the topic leg once", async () => {
    let starts = 0;
    await raceApproval({
      turnSignal: new AbortController().signal,
      dock: async (race) => {
        race.opened();
        race.opened();
        return "x";
      },
      topic: () => {
        starts += 1;
        return new Promise<RemoteApprovalAnswer>(() => undefined);
      },
    });
    expect(starts).toBe(1);
  });
});
