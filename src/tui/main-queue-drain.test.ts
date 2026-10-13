// Flow 441 (R1, AC1-AC4): the queue drain. `tui-shell.ts` cannot be mounted by a unit test, so the
// shell is modelled here with the one factory it builds (`createMainQueueDrain`) around a `runLine`
// that behaves as the real one does: an inline slash command returns with no turn started, a slash
// command with detached work (`/model`, `/connect`) holds the queue until that work ends, any other
// line starts a turn and leaves the shell busy until it settles. The source-text tests in
// tui-bus.test.ts, tui-hold.test.ts and remote-queue-wiring.test.ts pin that the shell builds the
// factory with the real objects.

import { describe, expect, test } from "bun:test";
import { createMainQueueDrain, drainNext, type QueuedMainQuestion } from "./main-queue";

const item = (id: string, question: string): QueuedMainQuestion => ({ id, question, displayQuestion: question });

interface ModelShell {
  queue: QueuedMainQuestion[];
  forced: QueuedMainQuestion[];
  ran: string[];
  turns: string[];
  paints: number;
  settles: number;
  busy: boolean;
  awaitingSettlement: boolean;
  detached: number;
  /** The turn finished: the shell goes idle and the settle site runs. */
  settleTurn(): void;
  /** The foreground operation finished. */
  completeOperation(): void;
  releaseLease(): void;
  /** A detached slash command's work ended. */
  endDetached(): void;
}

function modelShell(onSlash?: (line: string, shell: ModelShell) => void): ModelShell {
  const shell: ModelShell = {
    queue: [],
    forced: [],
    ran: [],
    turns: [],
    paints: 0,
    settles: 0,
    busy: false,
    awaitingSettlement: false,
    detached: 0,
    settleTurn: () => {
      shell.busy = false;
      sites.onTurnSettle();
    },
    completeOperation: () => sites.onForegroundOperationComplete(),
    releaseLease: () => sites.onLeaseRelease(),
    endDetached: () => {
      shell.detached -= 1;
      sites.onDetachedWorkDone();
    },
  };
  const runLine = (line: string): void => {
    shell.ran.push(line);
    if (line === "/model" || line === "/connect") {
      shell.detached += 1;
      return;
    }
    if (line.startsWith("/")) {
      onSlash?.(line, shell);
      return;
    }
    shell.turns.push(line);
    shell.busy = true;
  };
  const forced = {
    takeNext: () => shell.forced.shift(),
    get pendingCount() {
      return shell.forced.length;
    },
    get isAwaitingSettlement() {
      return shell.awaitingSettlement;
    },
  };
  const sites = createMainQueueDrain({
    forced,
    queue: shell.queue,
    paint: () => {
      shell.paints += 1;
    },
    run: (next) => runLine(next.question),
    workInFlight: () => shell.busy || shell.awaitingSettlement || shell.detached > 0,
    onSettle: () => {
      shell.settles += 1;
    },
  });
  return shell;
}

describe("AC1/AC2: a slash line queued before a question no longer strands it", () => {
  const slashCommands = ["/compact", "/queue", "/plan"];

  for (const command of slashCommands) {
    test(`${command} then a question: the question is dispatched as a turn when the running turn settles`, () => {
      const shell = modelShell();
      shell.busy = true; // a turn is running
      shell.queue.push(item("a", command), item("b", "question"));

      shell.settleTurn();

      expect(shell.ran).toEqual([command, "question"]);
      expect(shell.turns).toEqual(["question"]);
      expect(shell.queue).toEqual([]);
      expect(shell.busy).toBe(true);
    });
  }

  test("the same holds when the lease is released and when a foreground operation completes", () => {
    for (const trigger of ["releaseLease", "completeOperation"] as const) {
      const shell = modelShell();
      shell.queue.push(item("a", "/compact"), item("b", "question"));
      shell[trigger]();
      expect(shell.turns).toEqual(["question"]);
    }
  });
});

describe("F-001: a slash command whose work outlives its handler holds the queue", () => {
  for (const command of ["/model", "/connect"]) {
    test(`${command} then a question: the question waits for the command's work, then runs`, () => {
      const shell = modelShell();
      shell.busy = true;
      shell.queue.push(item("a", command), item("b", "question"));

      shell.settleTurn();

      expect(shell.ran).toEqual([command]);
      expect(shell.queue.map((i) => i.question)).toEqual(["question"]);
      expect(shell.turns).toEqual([]);

      shell.endDetached();

      expect(shell.ran).toEqual([command, "question"]);
      expect(shell.queue).toEqual([]);
      expect(shell.turns).toEqual(["question"]);
    });
  }

  test("the end of the work stays out while a turn is running, and the turn's settle drains", () => {
    const shell = modelShell();
    shell.detached = 1;
    shell.queue.push(item("a", "question"));
    shell.busy = true;
    shell.endDetached();
    expect(shell.ran).toEqual([]);
    shell.settleTurn();
    expect(shell.turns).toEqual(["question"]);
  });

  test("a forced item and a queued slash command with detached work: the forced one runs first, the rest wait", () => {
    const shell = modelShell();
    shell.busy = true;
    shell.forced.push(item("f", "/model"));
    shell.queue.push(item("a", "question"));
    shell.settleTurn();
    expect(shell.ran).toEqual(["/model"]);
    shell.endDetached();
    expect(shell.turns).toEqual(["question"]);
  });
});

describe("AC3: the three sites share one drain and keep what differs between them", () => {
  test("turn settle: drains one line that starts a turn and stops; onSettle does not fire", () => {
    const shell = modelShell();
    shell.queue.push(item("a", "first"), item("b", "second"));
    shell.settleTurn();
    expect(shell.turns).toEqual(["first"]);
    expect(shell.queue.map((i) => i.question)).toEqual(["second"]);
    expect(shell.settles).toBe(0);
  });

  test("turn settle: onSettle fires when the drain finds nothing queued", () => {
    const shell = modelShell();
    shell.settleTurn();
    expect(shell.ran).toEqual([]);
    expect(shell.settles).toBe(1);
  });

  test("turn settle: a forced item goes before the queue and a pending hand-off drains nothing", () => {
    const shell = modelShell();
    shell.queue.push(item("a", "queued"));
    shell.forced.push(item("f", "forced"));
    shell.settleTurn();
    expect(shell.turns).toEqual(["forced"]);

    const waiting = modelShell();
    waiting.queue.push(item("a", "queued"));
    waiting.awaitingSettlement = true;
    waiting.settleTurn();
    expect(waiting.ran).toEqual([]);
    expect(waiting.settles).toBe(0);
  });

  test("foreground operation complete: drains one line that starts a turn and stops; never calls onSettle", () => {
    const shell = modelShell();
    shell.queue.push(item("a", "first"), item("b", "second"));
    shell.completeOperation();
    expect(shell.turns).toEqual(["first"]);
    expect(shell.queue.map((i) => i.question)).toEqual(["second"]);

    const empty = modelShell();
    empty.completeOperation();
    expect(empty.settles).toBe(0);

    const waiting = modelShell();
    waiting.queue.push(item("a", "queued"));
    waiting.awaitingSettlement = true;
    waiting.completeOperation();
    expect(waiting.ran).toEqual([]);
  });

  test("lease release: drains one line that starts a turn and stops, and stays out while anything is busy", () => {
    const shell = modelShell();
    shell.queue.push(item("a", "first"), item("b", "second"));
    shell.releaseLease();
    expect(shell.turns).toEqual(["first"]);
    expect(shell.queue.map((i) => i.question)).toEqual(["second"]);
    expect(shell.settles).toBe(0);

    for (const block of ["busy", "awaitingSettlement"] as const) {
      const held = modelShell();
      held[block] = true;
      held.queue.push(item("a", "queued"));
      held.releaseLease();
      expect(held.ran).toEqual([]);
      expect(held.queue).toHaveLength(1);
    }
  });
});

describe("drainNext outcomes", () => {
  const line = (id: string): QueuedMainQuestion => item(id, id);

  test("a take that finds nothing reports empty and still paints", () => {
    let paints = 0;
    const outcome = drainNext({
      take: () => undefined,
      pending: () => 1,
      paint: () => void (paints += 1),
      run: () => {},
      isBusy: () => false,
    });
    expect(outcome).toBe("empty");
    expect(paints).toBe(1);
  });

  test("a run that leaves work in flight reports started and takes no more", () => {
    const queue = [line("a"), line("b")];
    const ran: string[] = [];
    const outcome = drainNext({
      take: () => queue.shift(),
      pending: () => queue.length,
      paint: () => {},
      run: (next) => void ran.push(next.id),
      isBusy: () => true,
    });
    expect(outcome).toBe("started");
    expect(ran).toEqual(["a"]);
  });

  test("a line that puts itself back reports exhausted, not empty", () => {
    const queue = [line("a")];
    const outcome = drainNext({
      take: () => queue.shift(),
      pending: () => queue.length,
      paint: () => {},
      run: (next) => void queue.push(next),
      isBusy: () => false,
    });
    expect(outcome).toBe("exhausted");
    expect(queue).toHaveLength(1);
  });
});

describe("AC4: slash lines that start no turn drain completely, within a bound", () => {
  test("five slash lines run in order and leave the queue empty", () => {
    const shell = modelShell();
    shell.busy = true;
    const lines = ["/a", "/b", "/c", "/d", "/e"];
    shell.queue.push(...lines.map((line, i) => item(String(i), line)));

    shell.settleTurn();

    expect(shell.ran).toEqual(lines);
    expect(shell.queue).toEqual([]);
    expect(shell.turns).toEqual([]);
    expect(shell.busy).toBe(false);
    // the drain ended idle with nothing queued: the bus wake still gets its turn
    expect(shell.settles).toBe(1);
  });

  test("a line that puts itself back in the queue cannot hold the drain", () => {
    const shell = modelShell((line, self) => {
      self.queue.push(item(`again-${self.ran.length}`, line));
    });
    shell.queue.push(item("a", "/loop"), item("b", "/loop"));

    shell.settleTurn();

    // the first line queues a copy of itself behind the other, so the count never falls: one run, then the drain stops
    expect(shell.ran).toEqual(["/loop"]);
    expect(shell.queue).toHaveLength(2);
    expect(shell.settles).toBe(0);
  });

  test("drainNext paints after every take", () => {
    const shell = modelShell();
    shell.queue.push(item("a", "/a"), item("b", "/b"));
    shell.settleTurn();
    expect(shell.paints).toBe(2);
  });

  test("a drain that finds nothing takes and paints nothing", () => {
    const shell = modelShell();
    shell.settleTurn();
    expect(shell.paints).toBe(0);
  });

  test("forced items and queued lines are both counted: a forced slash line and two queued ones all run", () => {
    const shell = modelShell();
    shell.busy = true;
    shell.forced.push(item("f", "/f"));
    shell.queue.push(item("a", "/a"), item("b", "/b"));
    shell.settleTurn();
    expect(shell.ran).toEqual(["/f", "/a", "/b"]);
    expect(shell.settles).toBe(1);
  });
});
