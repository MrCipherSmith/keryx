// Flow 441 (AC1): the turn loop, mounted headlessly. `tui-shell.ts` cannot be mounted by a unit
// test, so until now AC1 was held by source text and by `main-queue-drain.test.ts`, which pushes into
// its own array. Here the lines arrive through the production enqueue step (`enqueueWhileBusy`,
// `enqueue`), and the real `createMainQueueDrain` and `createRemoteQueueWiring` (both built by
// `createTurnLoop`, the same call the shell makes) run them. Only the turn runner is fake: it plays
// `runLine` as the shell's does, an inline slash command returns with no turn started, a plain line
// starts a turn and leaves the shell busy until `settleTurn`.
//
// What stays pinned by source text (tui-bus.test.ts, tui-hold.test.ts, remote-queue-wiring.test.ts):
// that the shell's `runLine` calls `turnLoop.enqueueWhileBusy` / `turnLoop.enqueue` at its busy sites,
// and that the three drain sites call `drainSites.*`.

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
  settles: number;
  failures: string[];
  busy: boolean;
  forced: QueuedMainQuestion[];
  detachedWork: Array<{ resolve(): void; reject(error: Error): void }>;
  /** The operator submits a line: queued while busy, run when idle. */
  submit(line: string, source?: typeof TG_SOURCE): void;
  settleTurn(): void;
}

function harness(): Harness {
  const h: Harness = {
    loop: undefined as unknown as TurnLoop,
    said: [],
    ran: [],
    turns: [],
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
        h.loop.enqueueWhileBusy(line, line, name, source);
      } else {
        h.loop.enqueue(line, line, source);
      }
      return;
    }
    h.ran.push({ line, ...(source !== undefined ? { source } : {}) });
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
      summarize: (text) => text,
      composer: { setText: () => {}, focus: () => {} },
    },
    paint: () => {},
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
    h.loop.enqueue("late", "late");

    h.loop.drainWhenIdle(() => !h.busy);

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
