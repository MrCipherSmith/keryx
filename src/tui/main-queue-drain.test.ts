// Flow 441 (R1, AC1-AC4): the queue drain. `tui-shell.ts` cannot be mounted by a unit test, so the
// shell is modelled here with the same two pieces it builds (`drainNext`, `createDrainSites`) around a
// `runLine` that behaves as the real one does: an inline slash command returns with no turn started,
// any other line starts a turn and leaves the shell busy until it settles.

import { describe, expect, test } from "bun:test";
import { createDrainSites, drainNext, type QueuedMainQuestion } from "./main-queue";

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
  /** The turn finished: the shell goes idle and the settle site runs. */
  settleTurn(): void;
  /** The foreground operation finished. */
  completeOperation(): void;
  releaseLease(): void;
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
    settleTurn: () => {
      shell.busy = false;
      sites.onTurnSettle();
    },
    completeOperation: () => sites.onForegroundOperationComplete(),
    releaseLease: () => sites.onLeaseRelease(),
  };
  const runLine = (line: string): void => {
    shell.ran.push(line);
    if (line.startsWith("/")) {
      onSlash?.(line, shell);
      return;
    }
    shell.turns.push(line);
    shell.busy = true;
  };
  const inFlight = (): boolean => shell.busy || shell.awaitingSettlement;
  const sites = createDrainSites({
    drain: () =>
      drainNext({
        take: () => shell.forced.shift() ?? shell.queue.shift(),
        pending: () => shell.queue.length,
        paint: () => {
          shell.paints += 1;
        },
        run: (next) => runLine(next.question),
        isBusy: inFlight,
      }),
    isAwaitingSettlement: () => shell.awaitingSettlement,
    isBusy: inFlight,
    onSettle: () => {
      shell.settles += 1;
    },
  });
  return shell;
}

describe("AC1/AC2: a slash line queued before a question no longer strands it", () => {
  const slashCommands = ["/compact", "/model", "/goal", "/connect"];

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

describe("AC3: the three sites share one drain and keep what differs between them", () => {
  test("turn settle: drains one line that starts a turn and stops; onSettle does not fire", () => {
    const shell = modelShell();
    shell.queue.push(item("a", "first"), item("b", "second"));
    shell.settleTurn();
    expect(shell.turns).toEqual(["first"]);
    expect(shell.queue.map((i) => i.question)).toEqual(["second"]);
    expect(shell.settles).toBe(0);
  });

  test("turn settle: onSettle fires in the else branch, when nothing was queued", () => {
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
    // the drain ended idle with nothing queued: the bus wake (the else branch) still gets its turn
    expect(shell.settles).toBe(1);
  });

  test("a line that puts itself back in the queue cannot hold the drain", () => {
    const shell = modelShell((line, self) => {
      self.queue.push(item(`again-${self.ran.length}`, line));
    });
    shell.queue.push(item("a", "/loop"), item("b", "/loop"));

    shell.settleTurn();

    // two queued lines + one for a forced item: at most three runs, then the drain gives up
    expect(shell.ran.length).toBeLessThanOrEqual(3);
    expect(shell.ran.length).toBeGreaterThan(0);
  });

  test("drainNext paints after every take, including the one that finds nothing", () => {
    const shell = modelShell();
    shell.queue.push(item("a", "/a"), item("b", "/b"));
    shell.settleTurn();
    expect(shell.paints).toBe(3);
  });
});
