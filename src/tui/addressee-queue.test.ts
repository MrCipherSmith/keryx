// Flow 176 T16 — per-addressee queues and external delivery intents.
// Package: docs/requirements/keryx-external-agent-runtime §7.5 (AC10, AC11), D-09.
import { describe, expect, test } from "bun:test";
import {
  MAIN_ADDRESSEE,
  addresseesWithQueue,
  clearAddresseeQueue,
  deliveredUserMessageEvent,
  describeDeliveryIntent,
  editInAddresseeQueue,
  emptyAddresseeQueues,
  enqueueForAddressee,
  externalUserMessageEvent,
  intentDeliversNow,
  planExternalDelivery,
  queueFor,
  reinsertIntoAddresseeQueue,
  removeFromAddresseeQueue,
  totalQueued,
  type ExternalAddresseeState,
} from "./addressee-queue";
import type { QueuedMainQuestion } from "./main-queue";

const q = (id: string, question: string): QueuedMainQuestion => ({ id, question, displayQuestion: question });

const codex = (over: Partial<ExternalAddresseeState> = {}): ExternalAddresseeState => ({
  agentId: "codex-cli",
  streamingInput: false,
  launchedStreaming: false,
  resumable: true,
  running: true,
  ...over,
});

const claude = (over: Partial<ExternalAddresseeState> = {}): ExternalAddresseeState => ({
  agentId: "claude-cli",
  streamingInput: true,
  launchedStreaming: true,
  resumable: true,
  sessionRef: "sess-1",
  running: true,
  ...over,
});

describe("per-addressee queues", () => {
  test("queues are independent and the main queue keeps its existing behaviour", () => {
    let queues = emptyAddresseeQueues();
    queues = enqueueForAddressee(queues, MAIN_ADDRESSEE, q("m1", "main one"));
    queues = enqueueForAddressee(queues, "ext:1", q("e1", "child one"));
    queues = enqueueForAddressee(queues, "ext:1", q("e2", "child two"));

    expect(queueFor(queues, MAIN_ADDRESSEE).map((i) => i.id)).toEqual(["m1"]);
    expect(queueFor(queues, "ext:1").map((i) => i.id)).toEqual(["e1", "e2"]);
    expect(addresseesWithQueue(queues)).toEqual([MAIN_ADDRESSEE, "ext:1"]);
    expect(totalQueued(queues)).toBe(3);
    expect(queueFor(queues, "unknown")).toEqual([]);
  });

  test("remove splices only the targeted addressee and is a no-op out of range", () => {
    let queues = enqueueForAddressee(emptyAddresseeQueues(), "ext:1", q("a", "A"));
    queues = enqueueForAddressee(queues, "ext:1", q("b", "B"));
    queues = enqueueForAddressee(queues, MAIN_ADDRESSEE, q("m", "M"));

    const removed = removeFromAddresseeQueue(queues, "ext:1", 0);
    expect(removed.removed?.id).toBe("a");
    expect(queueFor(removed.queues, "ext:1").map((i) => i.id)).toEqual(["b"]);
    expect(queueFor(removed.queues, MAIN_ADDRESSEE).map((i) => i.id)).toEqual(["m"]);
    // The input map is untouched.
    expect(queueFor(queues, "ext:1")).toHaveLength(2);

    const miss = removeFromAddresseeQueue(queues, "ext:1", 99);
    expect(miss.removed).toBeUndefined();
    expect(queueFor(miss.queues, "ext:1")).toHaveLength(2);
  });

  test("edit preserves position through remove + reinsert", () => {
    let queues = emptyAddresseeQueues();
    for (const item of [q("a", "A"), q("b", "B"), q("c", "C")]) {
      queues = enqueueForAddressee(queues, "ext:1", item);
    }
    const edited = editInAddresseeQueue(queues, "ext:1", 1);
    expect(edited?.text).toBe("B");
    expect(queueFor(edited!.queues, "ext:1").map((i) => i.id)).toEqual(["a", "c"]);

    const back = reinsertIntoAddresseeQueue(edited!.queues, "ext:1", 1, q("b", "B2"));
    expect(queueFor(back, "ext:1").map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(queueFor(back, "ext:1")[1]?.question).toBe("B2");
    expect(editInAddresseeQueue(queues, "ext:1", 99)).toBeUndefined();
  });

  test("an emptied addressee is dropped so dead children stop showing up", () => {
    const queues = enqueueForAddressee(emptyAddresseeQueues(), "ext:1", q("a", "A"));
    expect(addresseesWithQueue(removeFromAddresseeQueue(queues, "ext:1", 0).queues)).toEqual([]);
    expect(addresseesWithQueue(clearAddresseeQueue(queues, "ext:1"))).toEqual([]);
    expect(clearAddresseeQueue(queues, "missing")).toBe(queues);
  });
});

describe("planExternalDelivery", () => {
  test("AC10: a streaming-mode claude run takes the message on stdin", () => {
    const intent = planExternalDelivery({ state: claude(), message: "check the tests" });
    expect(intent).toEqual({ kind: "stdin", message: "check the tests" });
    expect(intentDeliversNow(intent)).toBe(true);
  });

  test("AC10: streamingInput true but launched one-shot falls back to resume", () => {
    const intent = planExternalDelivery({
      state: claude({ launchedStreaming: false }),
      message: "hi",
    });
    expect(intent).toEqual({ kind: "resume", when: "after-exit", sessionRef: "sess-1", message: "hi" });
    // Not delivered yet, so no awareness event yet.
    expect(intentDeliversNow(intent)).toBe(false);
  });

  test("AC10: codex holds the message until the run ends, then resumes", () => {
    const running = planExternalDelivery({ state: codex({ sessionRef: "thread-1" }), message: "hi" });
    expect(running).toEqual({ kind: "resume", when: "after-exit", sessionRef: "thread-1", message: "hi" });
    const ended = planExternalDelivery({
      state: codex({ sessionRef: "thread-1", running: false }),
      message: "hi",
    });
    expect(ended).toEqual({ kind: "resume", when: "now", sessionRef: "thread-1", message: "hi" });
    expect(intentDeliversNow(ended)).toBe(true);
  });

  test("a codex run that has not announced thread_id yet holds rather than failing", () => {
    const intent = planExternalDelivery({ state: codex(), message: "hi" });
    expect(intent.kind).toBe("hold");
    expect(describeDeliveryIntent(intent)).toContain("held");
  });

  test("a run that ended without a handle is undeliverable, not silently dropped", () => {
    const intent = planExternalDelivery({ state: codex({ running: false }), message: "hi" });
    expect(intent.kind).toBe("undeliverable");
    expect(intentDeliversNow(intent)).toBe(false);
  });

  test("AC11: force is kill plus resume, carrying the session id and the message", () => {
    const intent = planExternalDelivery({ state: claude(), message: "stop", force: true });
    expect(intent).toEqual({ kind: "kill-then-resume", sessionRef: "sess-1", message: "stop" });
    // Force interrupts even where a stdin route exists: stdin would queue the
    // message behind the turn already in flight.
    expect(intentDeliversNow(intent)).toBe(true);
  });

  test("force on a codex run killed before thread.started degrades to a plain kill", () => {
    const intent = planExternalDelivery({ state: codex(), message: "stop", force: true });
    expect(intent.kind).toBe("kill-only");
    expect(intent.kind === "kill-only" && intent.reason).toContain("cannot be resumed");
    expect(intentDeliversNow(intent)).toBe(false);
    expect(describeDeliveryIntent(intent)).toContain("killing the run");
  });

  test("force on a non-resumable agent kills and says the message is lost", () => {
    const intent = planExternalDelivery({
      state: codex({ resumable: false, sessionRef: "thread-1" }),
      message: "stop",
      force: true,
    });
    expect(intent.kind).toBe("kill-only");
    expect(intent.kind === "kill-only" && intent.reason).toContain("cannot resume");
  });

  test("force on an already-finished run has nothing to kill and resumes instead", () => {
    const intent = planExternalDelivery({
      state: codex({ running: false, sessionRef: "thread-1" }),
      message: "stop",
      force: true,
    });
    expect(intent).toEqual({ kind: "resume", when: "now", sessionRef: "thread-1", message: "stop" });
  });

  test("an agent with neither streaming nor resume is undeliverable by name", () => {
    const intent = planExternalDelivery({
      state: codex({ resumable: false, sessionRef: "thread-1" }),
      message: "hi",
    });
    expect(intent.kind).toBe("undeliverable");
    expect(describeDeliveryIntent(intent)).toContain("not delivered");
  });
});

describe("D-09: delivery emits a user_message canonical event", () => {
  test("every intent that delivers now produces the event, verbatim", () => {
    expect(externalUserMessageEvent("hello")).toEqual({ kind: "user_message", text: "hello" });
    const delivered = [
      planExternalDelivery({ state: claude(), message: "a" }),
      planExternalDelivery({ state: claude(), message: "b", force: true }),
      planExternalDelivery({ state: codex({ running: false, sessionRef: "t" }), message: "c" }),
    ];
    expect(delivered.map((intent) => deliveredUserMessageEvent(intent))).toEqual([
      { kind: "user_message", text: "a" },
      { kind: "user_message", text: "b" },
      { kind: "user_message", text: "c" },
    ]);
  });

  test("an undelivered message emits nothing — awareness must not outrun delivery", () => {
    const held = planExternalDelivery({ state: codex(), message: "later" });
    const killed = planExternalDelivery({ state: codex(), message: "stop", force: true });
    expect(deliveredUserMessageEvent(held)).toBeUndefined();
    expect(deliveredUserMessageEvent(killed)).toBeUndefined();
  });
});
