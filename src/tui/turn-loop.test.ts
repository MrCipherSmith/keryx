// Flow 441 (AC1): the extracted turn loop (`createTurnLoop`) driven with a MODELLED `runLine`. This is
// not the mounted shell: `tui-shell.ts` cannot be mounted by a unit test. Here the lines arrive through
// the production enqueue steps (`enqueueWhileBusy`, `enqueue`, `remote.enqueueTelegramLine`), and the
// real `createMainQueueDrain` and `createRemoteQueueWiring` (built by `createTurnLoop`, the call the shell
// makes) run them. Only the turn runner is fake: an inline slash command returns with no turn started, a
// plain line starts a turn and leaves the shell busy until `settleTurn`, `/model` starts detached work.
//
// The boundary: the fake models only the happy busy branch of the shell's `runLine` (not
// `classifyBusyDispatch`, the lease-held branch or the recipient dock). What the shell passes into
// `createTurnLoop` and the call sites of `turnLoop.*` / `drainSites.*` are pinned as source text, each
// where its subject lives: the inputs and the drain getter in tui-hold.test.ts, the lease-held notices
// there too, the busy deferred branch in busy-dispatch.test.ts, the idle predicate of the recipient
// choice in main-queue.test.ts, the settle call in tui-bus.test.ts, the Force `replaceQueue` call in
// tui-shell.test.ts. remote-queue-wiring.test.ts pins only how the wiring delegates, by count.

import { describe, expect, test } from "bun:test";
import { TG_SOURCE } from "../remote/shell-bridge";
import type { QueuedMainQuestion } from "./main-queue";
import { createTurnLoop, type TurnLoop } from "./turn-loop";

interface Harness {
  loop: TurnLoop;
  said: string[];
  /** Lines the fake turn runner was asked to run, with the source they carried. */
  ran: Array<{ line: string; source?: typeof TG_SOURCE }>;
  turns: string[];
  /** Painted queue length at each repaint, interleaved with `run:<line>` for each line handed to `runLine`. */
  events: string[];
  settles: number;
  failures: string[];
  busy: boolean;
  forced: QueuedMainQuestion[];
  detachedWork: Array<{ resolve(): void; reject(error: Error): void }>;
  /** The operator submits a line: queued while busy, run when idle. */
  submit(line: string, source?: typeof TG_SOURCE): void;
  settleTurn(): void;
}

/** The label the shell shows for a line: never the line itself, so a swap of the two is visible. */
const shown = (line: string): string => `«${line}»`;

function harness(): Harness {
  const h: Harness = {
    loop: undefined as unknown as TurnLoop,
    said: [],
    ran: [],
    turns: [],
    events: [],
    settles: 0,
    failures: [],
    busy: false,
    forced: [],
    detachedWork: [],
    submit: (line, source) => runLine(line, "operator", source),
    settleTurn: () => {
      h.busy = false;
      h.loop.drain.onTurnSettle();
    },
  };
  const runLine = (line: string, _origin: "operator", source?: typeof TG_SOURCE): void => {
    if (h.busy) {
      const name = line.startsWith("/") ? line.split(/\s+/)[0] : undefined;
      if (name !== undefined) {
        h.loop.enqueueWhileBusy(line, shown(line), name, source);
      } else {
        h.loop.enqueue(line, shown(line), source);
      }
      return;
    }
    h.ran.push({ line, ...(source !== undefined ? { source } : {}) });
    h.events.push(`run:${line}`);
    if (line === "/model") {
      h.loop.drain.detach(
        new Promise<void>((resolve, reject) => {
          h.detachedWork.push({ resolve, reject });
        }),
      );
      return;
    }
    if (line.startsWith("/")) return;
    h.turns.push(line);
    h.busy = true;
  };
  h.loop = createTurnLoop({
    forced: {
      takeNext: () => h.forced.shift(),
      get pendingCount() {
        return h.forced.length;
      },
      isAwaitingSettlement: false,
    },
    remote: {
      getBridge: () => undefined,
      summarize: (text) => `sum:${text}`,
      composer: { setText: () => {}, focus: () => {} },
    },
    paint: () => h.events.push(`paint:${h.loop.queue.length}`),
    say: (text) => h.said.push(text),
    runLine,
    turnWorkInFlight: () => h.busy,
    onSettle: () => {
      h.settles += 1;
    },
    onDetachedFailure: (error) => h.failures.push(error instanceof Error ? error.message : String(error)),
  });
  return h;
}

describe("AC1: a slash command queued behind a turn does not strand the question behind it", () => {
  test("/compact then a question, both typed while a turn runs: the question becomes a turn when it settles", () => {
    const h = harness();
    h.busy = true;

    h.submit("/compact");
    h.submit("question");
    expect(h.loop.queue.map((item) => item.question)).toEqual(["/compact", "question"]);
    expect(h.said).toEqual(["◇ main is busy — queued as q1 (runs when the turn ends).\n"]);

    h.settleTurn();

    expect(h.ran.map((r) => r.line)).toEqual(["/compact", "question"]);
    expect(h.turns).toEqual(["question"]);
    expect(h.loop.queue).toEqual([]);
    expect(h.busy).toBe(true);
  });

  test("a chain of inline slash commands before the question is drained in one settle", () => {
    const h = harness();
    h.busy = true;
    h.submit("/compact");
    h.submit("/plan");
    h.submit("/mode auto");
    h.submit("question");

    h.settleTurn();

    expect(h.ran.map((r) => r.line)).toEqual(["/compact", "/plan", "/mode auto", "question"]);
    expect(h.turns).toEqual(["question"]);
  });

  test("a second question waits for the first turn, then runs on its settle, with no further operator input", () => {
    const h = harness();
    h.busy = true;
    h.submit("/compact");
    h.submit("first");
    h.submit("second");

    h.settleTurn();
    expect(h.turns).toEqual(["first"]);
    expect(h.loop.queue.map((item) => item.question)).toEqual(["second"]);

    h.settleTurn();
    expect(h.turns).toEqual(["first", "second"]);
  });

  test("a Telegram line keeps its source when the drain runs it", () => {
    const h = harness();
    h.busy = true;
    h.submit("/compact", TG_SOURCE);
    h.submit("from the topic", TG_SOURCE);

    h.settleTurn();

    expect(h.ran).toEqual([
      { line: "/compact", source: TG_SOURCE },
      { line: "from the topic", source: TG_SOURCE },
    ]);
  });

  test("a forced line runs ahead of the queue on the settle", () => {
    const h = harness();
    h.busy = true;
    h.submit("/compact");
    h.forced.push({ id: "f", question: "forced", displayQuestion: "forced" });

    h.settleTurn();

    expect(h.ran.map((r) => r.line)).toEqual(["forced"]);
    expect(h.loop.queue.map((item) => item.question)).toEqual(["/compact"]);
  });

  test("a session-replacing command is refused while busy and queues nothing", () => {
    const h = harness();
    expect(h.loop.enqueueWhileBusy("/new", "/new", "/new")).toBe(false);
    expect(h.loop.queue).toEqual([]);
    expect(h.said).toEqual([]);
  });

  for (const line of ["/sessions abc123", "/rewind"]) {
    test(`${line.split(" ")[0]} replaces the session too, so it is refused while busy and queues nothing`, () => {
      const h = harness();
      h.submit("question");
      h.submit(line);
      h.submit("follow-up");
      expect(h.loop.queue.map((item) => item.question)).toEqual(["follow-up"]);
      h.settleTurn();
      expect(h.ran.map((r) => r.line)).toEqual(["question", "follow-up"]);
    });
  }
  test("/queue remove between the slash command and the settle drains the replaced queue, not a stale one", () => {
    const h = harness();
    h.busy = true;
    h.submit("/compact");
    h.submit("question");

    h.loop.remote.removeMainQueue(0);
    h.settleTurn();

    expect(h.ran.map((r) => r.line)).toEqual(["question"]);
    expect(h.turns).toEqual(["question"]);
  });

  test("a slash command with detached work holds the lines behind it until that work ends", async () => {
    const h = harness();
    h.busy = true;
    h.submit("/model");
    h.submit("question");

    h.settleTurn();
    expect(h.turns).toEqual([]);
    expect(h.loop.queue.map((item) => item.question)).toEqual(["question"]);

    h.detachedWork.shift()!.resolve();
    await new Promise((done) => setTimeout(done, 0));
    expect(h.turns).toEqual(["question"]);
  });

  test("the recipient choice after the turn already settled runs the line at once", () => {
    const h = harness();
    h.loop.enqueue("late", shown("late"));

    h.loop.drainAfterRecipientChoice(() => !h.busy);

    expect(h.turns).toEqual(["late"]);
    expect(h.loop.queue).toEqual([]);
  });

  test("an empty drain reports the settle so the bus may wake", () => {
    const h = harness();
    h.busy = true;
    h.settleTurn();
    expect(h.settles).toBe(1);
  });
});

describe("the queue as the panel and the next drain see it", () => {
  test("items keep the line and its label apart, with one fresh id each, across all three producers", () => {
    const h = harness();
    h.busy = true;
    h.submit("/compact");
    h.loop.remote.enqueueTelegramLine("from the topic");
    h.submit("question");

    expect(h.loop.queue.map((item) => ({ id: item.id, question: item.question, display: item.displayQuestion, source: item.source }))).toEqual([
      { id: "mq0", question: "/compact", display: shown("/compact"), source: undefined },
      { id: "mq1", question: "from the topic", display: "sum:from the topic", source: TG_SOURCE },
      { id: "mq2", question: "question", display: shown("question"), source: undefined },
    ]);
  });

  test("each queued slash command is told its own position", () => {
    const h = harness();
    h.busy = true;
    h.submit("/compact");
    h.submit("/plan");
    h.submit("/mode auto");

    expect(h.said).toEqual([
      "◇ main is busy — queued as q1 (runs when the turn ends).\n",
      "◇ main is busy — queued as q2 (runs when the turn ends).\n",
      "◇ main is busy — queued as q3 (runs when the turn ends).\n",
    ]);
  });

  test("enqueue returns the 1-based position and repaints with the line already in the queue", () => {
    const h = harness();
    expect(h.loop.enqueue("a", shown("a"))).toBe(1);
    expect(h.loop.enqueue("b", shown("b"))).toBe(2);
    expect(h.events).toEqual(["paint:1", "paint:2"]);
  });

  test("a line from the topic is queued with its source, told its position, and runs after the settle", () => {
    const h = harness();
    h.busy = true;
    h.submit("first");
    h.loop.remote.enqueueTelegramLine("from the topic");

    expect(h.said).toEqual(["◇ a line from Telegram is queued as q2.\n"]);
    h.settleTurn();
    expect(h.ran).toEqual([{ line: "first" }]);
    h.settleTurn();
    expect(h.ran).toEqual([{ line: "first" }, { line: "from the topic", source: TG_SOURCE }]);
  });

  test("a line from the topic repaints the panel with the line already in the queue", () => {
    const h = harness();
    h.busy = true;
    h.loop.remote.enqueueTelegramLine("one");
    h.loop.remote.enqueueTelegramLine("two");
    expect(h.events).toEqual(["paint:1", "paint:2"]);
  });

  test("replaceQueue swaps the array the drain reads: a removed line never runs, the kept one does", () => {
    const h = harness();
    h.busy = true;
    h.submit("/compact");
    h.submit("kept");
    const [, second] = h.loop.queue;

    h.loop.replaceQueue([second!]);
    expect(h.loop.queue.map((item) => item.question)).toEqual(["kept"]);
    h.settleTurn();

    expect(h.ran.map((r) => r.line)).toEqual(["kept"]);
  });

  test("a Telegram line queued after replaceQueue is pushed onto the new array and still runs with its source", () => {
    const h = harness();
    h.busy = true;
    h.submit("/compact");
    h.loop.replaceQueue([]);
    h.loop.remote.enqueueTelegramLine("late topic line");

    expect(h.loop.queue.map((item) => item.question)).toEqual(["late topic line"]);
    h.settleTurn();
    expect(h.ran).toEqual([{ line: "late topic line", source: TG_SOURCE }]);
  });
});

describe("detached slash work", () => {
  test("a rejected detached run is reported once and the line behind it still runs", async () => {
    const h = harness();
    h.busy = true;
    h.submit("/model");
    h.submit("question");
    h.settleTurn();

    h.detachedWork.shift()!.reject(new Error("model list unavailable"));
    await new Promise((done) => setTimeout(done, 0));

    expect(h.failures).toEqual(["model list unavailable"]);
    expect(h.turns).toEqual(["question"]);
  });
});

describe("drainAfterRecipientChoice", () => {
  test("repaints with the head already taken, then runs it", () => {
    const h = harness();
    h.loop.enqueue("late", shown("late"));
    h.events.length = 0;

    h.loop.drainAfterRecipientChoice(() => !h.busy);

    expect(h.events).toEqual(["paint:0", "run:late"]);
  });

  test("dispatches nothing while the caller's predicate says the shell is busy", () => {
    const h = harness();
    h.busy = true;
    h.loop.enqueue("late", shown("late"));
    h.events.length = 0;

    h.loop.drainAfterRecipientChoice(() => !h.busy);

    expect(h.ran).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.loop.queue.map((item) => item.question)).toEqual(["late"]);
  });

  test("a forced item goes first and the queue keeps its head", () => {
    const h = harness();
    h.loop.enqueue("queued", shown("queued"));
    h.forced.push({ id: "f", question: "forced", displayQuestion: "forced" });

    h.loop.drainAfterRecipientChoice(() => !h.busy);

    expect(h.ran.map((r) => r.line)).toEqual(["forced"]);
    expect(h.loop.queue.map((item) => item.question)).toEqual(["queued"]);
  });
});
