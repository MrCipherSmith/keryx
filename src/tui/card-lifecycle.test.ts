// Flow 464 (PR 1052 E-08): the hop between a topic press and the durable record. The shell logs a card when it is
// asked, marks it when the topic cannot take it or gave up on it, and settles it however it ends; these tests drive
// that lifecycle with the real log and a fake topic, so dropping `fromId`, `pressedAt` or the settle fails here.

import { expect, test } from "bun:test";
import type { RemoteApprovalAnswer } from "../remote/shell-bridge";
import type { DockRace } from "./approval-mirror";
import { OperatorConfirmationLog, askUnmirroredCard, pendingConfirmationLine, raceMirroredCard, remoteApproval } from "./operator-confirmations";

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const allow = (fromId?: number): RemoteApprovalAnswer => ({ decision: "allow", always: false, ...(fromId === undefined ? {} : { fromId }) });

/** A dock that opens the topic leg and waits until the race closes it, like the real approval dock. */
const waitingDock = (race: DockRace): Promise<string> => {
  race.opened();
  return new Promise((resolve) => race.signal.addEventListener("abort", () => resolve("dock-closed")));
};

/** A dock that opens the topic leg, lets it settle, and answers itself. */
const answeringDock =
  (verdict: boolean) =>
  async (race: DockRace): Promise<boolean> => {
    race.opened();
    await new Promise((resolve) => setTimeout(resolve, 10));
    return verdict;
  };

const newLog = (): OperatorConfirmationLog => new OperatorConfirmationLog(() => T0);

test("remoteApproval names who pressed and stamps the shell's clock; a press with no user carries no pressedBy", () => {
  const now = () => new Date("2026-10-19T12:34:56.000Z");
  expect(remoteApproval("fp-1", 9, now)).toEqual({ approved: true, fingerprint: "fp-1", via: "remote", pressedBy: 9, pressedAt: "2026-10-19T12:34:56.000Z" });
  expect(remoteApproval("fp-1", undefined, now)).not.toHaveProperty("pressedBy");
});

test("a topic allow closes the dock and logs who pressed", async () => {
  const log = newLog();
  const outcome = await raceMirroredCard({ log, question: "Complete review X?", turnSignal: new AbortController().signal, dock: waitingDock, topic: async () => allow(9) });
  expect(outcome).toMatchObject({ from: "topic", answer: { decision: "allow", fromId: 9 } });
  expect(log.waiting()).toHaveLength(0);
  expect(log.entries()[0]?.answered).toMatchObject({ place: "telegram", yes: true, pressedBy: 9 });
});

test("a topic deny with a presser logs no, from Telegram", async () => {
  const log = newLog();
  await raceMirroredCard({ log, question: "Complete review X?", turnSignal: new AbortController().signal, dock: waitingDock, topic: async () => ({ decision: "deny", always: false, fromId: 4 }) });
  expect(log.entries()[0]?.answered).toMatchObject({ place: "telegram", yes: false, pressedBy: 4 });
});

test("a card the topic never took stops waiting there, says so, and is answered in the dock", async () => {
  const log = newLog();
  let told = 0;
  const outcome = await raceMirroredCard({
    log,
    question: "Complete review X?",
    turnSignal: new AbortController().signal,
    onUndelivered: () => {
      told += 1;
    },
    dock: async (race) => {
      race.opened();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(log.waiting()).toHaveLength(0);
      expect(pendingConfirmationLine(log.entries()[0]!, T0)).toContain("Telegram mirror not delivered");
      return true;
    },
    topic: async () => ({ decision: "deny", always: false, undelivered: true }),
  });
  expect(told).toBe(1);
  expect(outcome).toEqual({ from: "dock", result: true });
  expect(log.entries()[0]?.answered).toMatchObject({ place: "shell", yes: true });
});

test("a topic leg that ended with no press stops the card waiting, without the undelivered note", async () => {
  const log = newLog();
  let told = 0;
  await raceMirroredCard({
    log,
    question: "Complete review X?",
    turnSignal: new AbortController().signal,
    onUndelivered: () => {
      told += 1;
    },
    dock: async (race) => {
      race.opened();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(log.waiting()).toHaveLength(0);
      expect(pendingConfirmationLine(log.entries()[0]!, T0)).toContain("no longer waiting for this card");
      return false;
    },
    topic: async () => ({ decision: "deny", always: false }),
  });
  expect(told).toBe(0);
  expect(log.entries()[0]?.answered).toMatchObject({ place: "shell", yes: false });
});

test("a dock that throws leaves the card withdrawn, never waiting", async () => {
  const log = newLog();
  await expect(
    raceMirroredCard({
      log,
      question: "Complete review X?",
      turnSignal: new AbortController().signal,
      dock: async () => {
        throw new Error("dock failed");
      },
      topic: async () => allow(),
    }),
  ).rejects.toThrow("dock failed");
  expect(log.waiting()).toHaveLength(0);
  expect(log.entries()[0]?.answered).toMatchObject({ place: "withdrawn", yes: false });
});

test("a turn that stopped withdraws the card even if the dock returned a verdict", async () => {
  const log = newLog();
  const turn = new AbortController();
  await raceMirroredCard({
    log,
    question: "Complete review X?",
    turnSignal: turn.signal,
    dock: async (race) => {
      race.opened();
      turn.abort();
      return false;
    },
    topic: (signal) => new Promise<RemoteApprovalAnswer>((resolve) => signal.addEventListener("abort", () => resolve({ decision: "deny", always: false }))),
  });
  expect(log.entries()[0]?.answered).toMatchObject({ place: "withdrawn" });
});

test("a question that is not an operator card logs nothing", async () => {
  const log = newLog();
  await raceMirroredCard({ log, question: undefined, turnSignal: new AbortController().signal, dock: answeringDock(true), topic: async () => ({ decision: "deny", always: false }) });
  expect(log.entries()).toHaveLength(0);
});

test("askUnmirroredCard logs a card the topic cannot get as not mirrored, then answered in the shell", async () => {
  const log = newLog();
  const verdict = await askUnmirroredCard(log, "Complete review X?", new AbortController().signal, async () => {
    expect(log.entries()[0]?.mirrored).toBe(false);
    return true;
  });
  expect(verdict).toBe(true);
  expect(log.entries()[0]?.answered).toMatchObject({ place: "shell", yes: true });
});

test("askUnmirroredCard: a no is logged as no, a stopped turn or a throw as withdrawn", async () => {
  const log = newLog();
  await askUnmirroredCard(log, "A?", new AbortController().signal, async () => false);
  const turn = new AbortController();
  await askUnmirroredCard(log, "B?", turn.signal, async () => {
    turn.abort();
    return true;
  });
  await expect(
    askUnmirroredCard(log, "C?", new AbortController().signal, async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(log.entries().map((entry) => [entry.question, entry.answered?.place, entry.answered?.yes])).toEqual([
    ["C?", "withdrawn", false],
    ["B?", "withdrawn", true],
    ["A?", "shell", false],
  ]);
});
