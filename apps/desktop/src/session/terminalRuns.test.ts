import { describe, expect, test } from "bun:test";
import type { PtyTab } from "../platform/panels";
import { initialState, reducer, type Action, type Item, type TerminalRunItem } from "./reducer";
import {
  BUSY_RETRY_MAX_MS,
  BUSY_RETRY_MS,
  capRunOutput,
  createTerminalRuns,
  newRunId,
  RESULTS_PER_PROMPT,
  RUN_COMMAND_MAX_CHARS,
  RUN_OUTPUT_CUT,
  RUN_OUTPUT_LINES,
  RUN_OUTPUT_MAX_BYTES,
  type DeliveryOutcome,
  type TerminalResultEntry,
} from "./terminalRuns";

const tab = (id: number, title = "run"): PtyTab => ({ id, title, owner: "user", cwd: "/proj", running: true, exitCode: null });

interface Sent {
  sessionId: string;
  results: TerminalResultEntry[];
  settle(outcome: DeliveryOutcome): void;
}

/** A window holding s1 (where the Run was clicked) and s2 (shown), with a fake keryx connection and host. */
function rig(opts: { accepts?: boolean | null } = {}) {
  let win = reducer({ ...initialState, phase: "ready" }, { t: "created", sessionId: "s1", show: true });
  win = reducer(win, { t: "created", sessionId: "s2", show: true });
  const sent: Sent[] = [];
  const idle = new Set(["s1", "s2"]);
  const tails = new Map<number, string>();
  const tailCalls: Array<[number, number]> = [];
  const failTail = new Set<number>();
  /** Tails held until the test releases them: events that land while a tail is read. */
  const tailGates = new Map<number, Promise<void>>();
  const shown: number[] = [];
  const later: Array<{ fn: () => void; ms: number }> = [];
  let accepts: boolean | null = opts.accepts === undefined ? true : opts.accepts;
  let clock = 10_000;
  let ids = 0;
  const runs = createTerminalRuns({
    acceptsResults: () => accepts,
    send: (sessionId, results) => {
      if (!idle.has(sessionId)) return null;
      idle.delete(sessionId); // a turn runs until keryx answers the prompt
      return new Promise<DeliveryOutcome>((resolve) =>
        sent.push({
          sessionId,
          results: results.map((r) => ({ ...r })),
          settle: (o) => {
            idle.add(sessionId);
            resolve(o);
          },
        }),
      );
    },
    tail: async (id, lines) => {
      tailCalls.push([id, lines]);
      const gate = tailGates.get(id);
      if (gate) await gate;
      if (failTail.has(id)) throw new Error("no such tab");
      return tails.get(id) ?? "";
    },
    showTab: (t) => void shown.push(t.id),
    dispatch: (a: Action) => {
      win = reducer(win, a);
    },
    now: () => clock,
    newRunId: () => `run-${++ids}`,
    later: (fn, ms) => void later.push({ fn, ms }),
  });
  const items = (sid = "s1"): Item[] => win.convs[sid]!.items;
  const card = (runId: string, sid = "s1"): TerminalRunItem => {
    const found = items(sid).find((i): i is TerminalRunItem => i.kind === "terminalRun" && i.runId === runId);
    if (!found) throw new Error(`no card for ${runId} in ${sid}`);
    return found;
  };
  /** A Run click in s1's transcript whose tab opened as `tabId`. */
  const start = (command: string, tabId: number, sid = "s1") => {
    const runId = runs.requested(command, { sessionId: sid });
    runs.opened(runId, tab(tabId));
    return runId;
  };
  const settled = () => new Promise<void>((r) => setTimeout(r, 0));
  /** Hold the next tail reads of `tabId` until the returned function is called. */
  const holdTail = (tabId: number): (() => Promise<void>) => {
    let release = () => {};
    tailGates.set(tabId, new Promise<void>((r) => (release = r)));
    return async () => {
      tailGates.delete(tabId);
      release();
      await settled();
    };
  };
  return {
    runs, sent, idle, tails, tailCalls, failTail, shown, later, items, card, start, settled, holdTail,
    advance: (ms: number) => void (clock += ms),
    setAccepts: (v: boolean | null) => void (accepts = v),
    win: () => win,
    dispatch: (a: Action) => void (win = reducer(win, a)),
  };
}

describe("a Run is a tracked run of the session that showed the button", () => {
  test("the click adds a starting card; the open tab makes it running with Show tab", () => {
    const r = rig();
    const runId = r.runs.requested("bun test", { sessionId: "s1" });
    expect(r.card(runId)).toMatchObject({ kind: "terminalRun", command: "bun test", state: "starting", tabOpen: false });
    r.runs.opened(runId, tab(5));
    expect(r.card(runId)).toMatchObject({ state: "running", tabOpen: true });
    expect(r.runs.showTab(runId)).toBe(true);
    expect(r.shown).toEqual([5]);
    expect(runId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  test("AC3: the exit sends exactly one prompt to that session with the six fields, the tail capped to 200 lines / 16 KiB", async () => {
    const r = rig();
    const runId = r.start("bun test", 5);
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1} ${"x".repeat(80)}`);
    r.tails.set(5, lines.join("\n"));
    r.advance(1500);
    await r.runs.exited(5, 3);
    // One line more than a result keeps: a full tail shows that earlier output was cut.
    expect(r.tailCalls).toEqual([[5, RUN_OUTPUT_LINES + 1]]);
    expect(r.sent).toHaveLength(1);
    const [prompt] = r.sent;
    expect(prompt!.sessionId).toBe("s1");
    expect(prompt!.results).toHaveLength(1);
    const entry = prompt!.results[0]!;
    expect(Object.keys(entry).sort()).toEqual(["command", "durationMs", "exitCode", "output", "runId", "state"]);
    expect(entry).toMatchObject({ runId, command: "bun test", state: "exited", exitCode: 3, durationMs: 1500 });
    expect(new TextEncoder().encode(entry.output).length).toBeLessThanOrEqual(RUN_OUTPUT_MAX_BYTES);
    expect(entry.output.split("\n").length).toBeLessThanOrEqual(RUN_OUTPUT_LINES);
    expect(entry.output.endsWith(lines[299]!)).toBe(true);
    // LG2-002: the cut is said, at the head of the output, inside the same 200 lines.
    expect(entry.output.split("\n")[0]).toBe(RUN_OUTPUT_CUT);
    expect(r.card(runId)).toMatchObject({ state: "sent", exitCode: 3, durationMs: 1500, output: entry.output });
  });

  test("AC3: the result goes to its own session while another session is shown, and only there", async () => {
    const r = rig();
    expect(r.win().shownId).toBe("s2");
    const runId = r.start("ls", 5);
    r.tails.set(5, "a\nb");
    await r.runs.exited(5, 0);
    expect(r.sent.map((p) => p.sessionId)).toEqual(["s1"]);
    expect(r.card(runId).state).toBe("sent");
    expect(r.items("s2").some((i) => i.kind === "terminalRun")).toBe(false);
  });

  test("a sent card moves to the end of the transcript (the agent's reply follows it) and a turn begins", async () => {
    const r = rig();
    const runId = r.start("ls", 5);
    r.dispatch({ t: "notice", sessionId: "s1", level: "info", text: "later line" });
    const turns = r.win().convs.s1!.parentTurn;
    await r.runs.exited(5, 0);
    expect(r.items().at(-1)).toMatchObject({ kind: "terminalRun", runId });
    expect(r.win().convs.s1!.parentTurn).toBe(turns + 1);
  });

  test("AC4: results that end while the session's turn runs wait, then go in ONE prompt when it ends", async () => {
    const r = rig();
    r.idle.delete("s1");
    const a = r.start("make a", 5);
    const b = r.start("make b", 6);
    await r.runs.exited(6, 1);
    await r.runs.exited(5, 0);
    expect(r.sent).toHaveLength(0);
    expect(r.card(a).state).toBe("waiting");
    expect(r.card(b).state).toBe("waiting");
    r.idle.add("s1");
    r.runs.flush("s1");
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.results.map((x) => x.runId)).toEqual([b, a]);
    expect(r.card(a).state).toBe("sent");
    expect(r.card(b).state).toBe("sent");
    // Nothing is sent twice.
    r.sent[0]!.settle({ kind: "done" });
    await r.settled();
    r.runs.flush();
    expect(r.sent).toHaveLength(1);
  });

  test("AC4: more than 8 waiting results go 8 per prompt; the rest after that turn ends", async () => {
    const r = rig();
    r.idle.delete("s1");
    const ids = Array.from({ length: 10 }, (_, i) => r.start(`echo ${i}`, 100 + i));
    for (let i = 0; i < 10; i++) await r.runs.exited(100 + i, 0);
    r.idle.add("s1");
    r.runs.flush();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.results.map((x) => x.runId)).toEqual(ids.slice(0, RESULTS_PER_PROMPT));
    expect(r.card(ids[9]!).state).toBe("waiting");
    r.runs.flush(); // the turn still runs
    expect(r.sent).toHaveLength(1);
    r.sent[0]!.settle({ kind: "done" });
    await r.settled();
    r.runs.flush("s1");
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1]!.results.map((x) => x.runId)).toEqual(ids.slice(RESULTS_PER_PROMPT));
  });

  test("a busy refusal puts the results back to waiting; they are retried after a pause, never in a tight loop", async () => {
    const r = rig();
    const runId = r.start("ls", 5);
    await r.runs.exited(5, 0);
    r.sent[0]!.settle({ kind: "busy" });
    await r.settled();
    expect(r.card(runId).state).toBe("waiting");
    r.runs.flush("s1"); // the refused turn's own end
    expect(r.sent).toHaveLength(1);
    expect(r.later).toHaveLength(1);
    r.advance(r.later[0]!.ms);
    r.later[0]!.fn();
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1]!.results.map((x) => x.runId)).toEqual([runId]);
    expect(r.card(runId).state).toBe("sent");
  });

  test("a prompt keryx refuses (invalid params) leaves the result not sent, with keryx's reason", async () => {
    const r = rig();
    const runId = r.start("ls", 5);
    await r.runs.exited(5, 0);
    r.sent[0]!.settle({ kind: "refused", error: "terminalResults[0].runId repeats" });
    await r.settled();
    expect(r.card(runId)).toMatchObject({ state: "not-sent", error: "terminalResults[0].runId repeats" });
    r.runs.flush();
    expect(r.sent).toHaveLength(1);
  });

  test("AC9: Send output now delivers one snapshot (state running, no exitCode); the later exit only updates the card", async () => {
    const r = rig();
    const runId = r.start("bun run dev", 5);
    r.tails.set(5, "listening on :3000");
    r.advance(4000);
    await r.runs.sendNow(runId);
    expect(r.sent).toHaveLength(1);
    const snap = r.sent[0]!.results[0]!;
    expect(Object.keys(snap).sort()).toEqual(["command", "durationMs", "output", "runId", "state"]);
    expect(snap).toMatchObject({ runId, state: "running", durationMs: 4000, output: "listening on :3000" });
    expect(r.card(runId).state).toBe("sent-while-running");
    expect(r.card(runId).exitCode).toBeUndefined();
    r.sent[0]!.settle({ kind: "done" });
    await r.settled();
    r.advance(1000);
    await r.runs.exited(5, 130);
    r.runs.flush();
    expect(r.sent).toHaveLength(1);
    expect(r.card(runId)).toMatchObject({ state: "sent-while-running", exitCode: 130, durationMs: 5000 });
    // A second click after it was sent does nothing.
    await r.runs.sendNow(runId);
    expect(r.sent).toHaveLength(1);
  });

  test("a snapshot still waiting when the process ends is replaced by the exit's result: one entry per run", async () => {
    const r = rig();
    r.idle.delete("s1");
    const runId = r.start("bun run build", 5);
    r.tails.set(5, "half");
    await r.runs.sendNow(runId);
    expect(r.card(runId).state).toBe("waiting");
    r.tails.set(5, "half\ndone");
    await r.runs.exited(5, 0);
    r.idle.add("s1");
    r.runs.flush("s1");
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.results).toEqual([{ runId, command: "bun run build", state: "exited", exitCode: 0, durationMs: 0, output: "half\ndone" }]);
  });
});

describe("AC8: failure paths send nothing and start no turn", () => {
  test("closing the tab before the command ends: the card says closed; the exit that follows is not a result", async () => {
    const r = rig();
    const runId = r.start("sleep 60", 5);
    r.runs.closed(5);
    expect(r.card(runId)).toMatchObject({ state: "closed", tabOpen: false });
    await r.runs.exited(5, 1);
    r.runs.flush();
    expect(r.sent).toHaveLength(0);
    expect(r.tailCalls).toHaveLength(0);
    expect(r.card(runId).state).toBe("closed");
    expect(r.runs.showTab(runId)).toBe(false);
    expect(r.win().convs.s1!.busy).toBe(false);
  });

  test("a closed tab after the exit keeps the result: it is still sent", async () => {
    const r = rig();
    r.idle.delete("s1");
    const runId = r.start("ls", 5);
    await r.runs.exited(5, 0);
    r.runs.closed(5);
    expect(r.card(runId)).toMatchObject({ state: "waiting", tabOpen: false });
    r.idle.add("s1");
    r.runs.flush("s1");
    expect(r.sent).toHaveLength(1);
  });

  test("a shell that cannot start: the card names the error; nothing is sent", async () => {
    const r = rig();
    const runId = r.runs.requested("bun test", { sessionId: "s1" });
    r.runs.failed(runId, "no such file: /bin/zsh");
    expect(r.card(runId)).toMatchObject({ state: "start-failed", error: "no such file: /bin/zsh", tabOpen: false });
    r.runs.opened(runId, tab(5)); // a late answer changes nothing
    await r.runs.exited(5, 0);
    r.runs.flush();
    expect(r.sent).toHaveLength(0);
    expect(r.card(runId).state).toBe("start-failed");
  });

  test("a keryx whose initialize lacks terminalResults gets no prompt; the card says the result was not sent", async () => {
    const r = rig({ accepts: false });
    const runId = r.start("ls", 5);
    r.tails.set(5, "a");
    await r.runs.exited(5, 0);
    r.runs.flush();
    expect(r.sent).toHaveLength(0);
    expect(r.card(runId)).toMatchObject({ state: "not-sent", exitCode: 0, output: "a" });
    expect(r.card(runId).error).toContain("does not take run results");
    // Send output now on such a keryx is not sent either.
    const other = r.start("bun run dev", 6);
    await r.runs.sendNow(other);
    expect(r.sent).toHaveLength(0);
    expect(r.card(other).state).toBe("not-sent");
  });

  test("while keryx is reconnecting (initialize not answered yet) a result waits instead of being dropped", async () => {
    const r = rig({ accepts: null });
    const runId = r.start("ls", 5);
    await r.runs.exited(5, 0);
    expect(r.card(runId).state).toBe("waiting");
    r.runs.flush();
    expect(r.sent).toHaveLength(0);
    r.setAccepts(true);
    r.runs.flush();
    expect(r.sent).toHaveLength(1);
  });

  test("a command longer than keryx accepts is not sent, and says why", async () => {
    const r = rig();
    const runId = r.start(`echo ${"a".repeat(5000)}`, 5);
    await r.runs.exited(5, 0);
    expect(r.sent).toHaveLength(0);
    expect(r.card(runId).state).toBe("not-sent");
    expect(r.card(runId).error).toContain("4096");
  });
});

describe("host edges", () => {
  test("a process that ends before its tab id is known is not lost", async () => {
    const r = rig();
    await r.runs.exited(9, 2);
    const runId = r.runs.requested("false", { sessionId: "s1" });
    r.runs.opened(runId, tab(9));
    await r.settled();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.results[0]).toMatchObject({ runId, state: "exited", exitCode: 2 });
  });

  test("a tail that cannot be read still sends the exit code, and says the output could not be read", async () => {
    const r = rig();
    const runId = r.start("ls", 5);
    r.failTail.add(5);
    await r.runs.exited(5, 0);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.results[0]).toMatchObject({ runId, exitCode: 0 });
    expect(r.sent[0]!.results[0]!.output).toContain("could not be read");
  });

  test("a signal exit (null) passes through as null", async () => {
    const r = rig();
    const runId = r.start("sleep 9", 5);
    await r.runs.exited(5, null);
    expect(r.sent[0]!.results[0]).toMatchObject({ runId, state: "exited", exitCode: null });
  });

  test("exits of tabs that are not runs change nothing", async () => {
    const r = rig();
    await r.runs.exited(42, 0);
    r.runs.closed(43);
    r.runs.flush();
    expect(r.sent).toHaveLength(0);
    expect(r.items().some((i) => i.kind === "terminalRun")).toBe(false);
  });
});

describe("HL2-002 / HL-002: once the process ended with its tab open, a running snapshot is never what goes", () => {
  test("a snapshot waiting while the exit's tail is read is not sent: the exit's result goes, once", async () => {
    const r = rig();
    r.idle.delete("s1");
    const runId = r.start("bun run build", 5);
    r.tails.set(5, "half");
    await r.runs.sendNow(runId);
    expect(r.card(runId).state).toBe("waiting");
    r.tails.set(5, "half\ndone");
    const release = r.holdTail(5);
    const exiting = r.runs.exited(5, 0);
    // The turn ends while the exit's tail is still being read.
    r.idle.add("s1");
    r.runs.flush("s1");
    expect(r.sent).toHaveLength(0);
    await release();
    await exiting;
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.results).toEqual([{ runId, command: "bun run build", state: "exited", exitCode: 0, durationMs: 0, output: "half\ndone" }]);
  });

  test("a snapshot refused as busy after the process ended is rebuilt from the exit before it is sent again", async () => {
    const r = rig();
    const runId = r.start("bun run dev", 5);
    r.tails.set(5, "listening");
    await r.runs.sendNow(runId);
    expect(r.sent[0]!.results[0]).toMatchObject({ state: "running" });
    r.tails.set(5, "listening\nstopped");
    await r.runs.exited(5, 0); // while the snapshot's prompt is on its way
    r.sent[0]!.settle({ kind: "busy" });
    await r.settled();
    expect(r.card(runId).state).toBe("waiting");
    r.advance(r.later[0]!.ms);
    r.later[0]!.fn();
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1]!.results).toEqual([{ runId, command: "bun run dev", state: "exited", exitCode: 0, durationMs: 0, output: "listening\nstopped" }]);
  });
});

describe("HL-001: a refused results prompt leaves no trace of a turn, and busy retries back off", () => {
  test("the follow-up turn counted when the prompt went out is taken back when keryx did not take it", async () => {
    const outcomes: DeliveryOutcome[] = [{ kind: "busy" }, { kind: "refused", error: "no" }, { kind: "wait" }];
    for (const outcome of outcomes) {
      const r = rig();
      const before = r.win().convs.s1!.parentTurn;
      r.start("ls", 5);
      await r.runs.exited(5, 0);
      expect(r.win().convs.s1!.parentTurn).toBe(before + 1);
      r.sent[0]!.settle(outcome);
      await r.settled();
      expect(r.win().convs.s1!.parentTurn).toBe(before);
    }
  });

  test("each busy refusal in a row doubles the pause, up to a cap; a prompt keryx takes resets it", async () => {
    const r = rig();
    const runId = r.start("ls", 5);
    await r.runs.exited(5, 0);
    const pauses: number[] = [];
    for (let i = 0; i < 7; i++) {
      r.sent.at(-1)!.settle({ kind: "busy" });
      await r.settled();
      const next = r.later.at(-1)!;
      pauses.push(next.ms);
      r.advance(next.ms);
      next.fn();
    }
    expect(pauses).toEqual([1, 2, 4, 8, 16, 32, 64].map((n) => Math.min(n * BUSY_RETRY_MS, BUSY_RETRY_MAX_MS)));
    expect(pauses.at(-1)).toBe(BUSY_RETRY_MAX_MS);
    expect(r.sent.at(-1)!.results.map((x) => x.runId)).toEqual([runId]);
    r.sent.at(-1)!.settle({ kind: "done" });
    await r.settled();
    r.start("pwd", 6);
    await r.runs.exited(6, 0);
    r.sent.at(-1)!.settle({ kind: "busy" });
    await r.settled();
    expect(r.later.at(-1)!.ms).toBe(BUSY_RETRY_MS);
  });
});

describe("HL2-001: a session keryx released, or a keryx shutting down: the results wait until the session is held again", () => {
  test("a 'wait' answer puts the results back to waiting with no retry; resume sends them once", async () => {
    const r = rig();
    const runId = r.start("ls", 5);
    await r.runs.exited(5, 0);
    r.sent[0]!.settle({ kind: "wait" });
    await r.settled();
    expect(r.card(runId).state).toBe("waiting");
    expect(r.later).toHaveLength(0);
    r.runs.flush("s1"); // idle, but not held again yet
    r.runs.flush();
    expect(r.sent).toHaveLength(1);
    r.runs.resume("s1");
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1]!.results.map((x) => x.runId)).toEqual([runId]);
  });
});

describe("PF-002: a run that can no longer change is dropped from the store; its card stays", () => {
  test("sent and closed, closed before its end and hung up, start-failed: dropped; waiting, or with its tab open: kept", async () => {
    const r = rig();
    const sent = r.start("ls", 5);
    await r.runs.exited(5, 0);
    expect(r.runs.tracked()).toBe(1); // the reply is not in yet
    r.sent[0]!.settle({ kind: "done" });
    await r.settled();
    expect(r.runs.tracked()).toBe(1); // its tab is still open: Show tab works
    r.runs.closed(5);
    expect(r.runs.tracked()).toBe(0);
    expect(r.card(sent)).toMatchObject({ state: "sent", tabOpen: false });

    r.start("sleep 60", 6);
    r.runs.closed(6);
    expect(r.runs.tracked()).toBe(1); // the hang-up has not arrived
    await r.runs.exited(6, 1);
    expect(r.runs.tracked()).toBe(0);

    const failed = r.runs.requested("bun test", { sessionId: "s1" });
    r.runs.failed(failed, "no shell");
    expect(r.runs.tracked()).toBe(0);

    r.idle.delete("s1");
    const waits = r.start("make", 7);
    await r.runs.exited(7, 0);
    r.runs.closed(7);
    expect(r.runs.tracked()).toBe(1);
    r.idle.add("s1");
    r.runs.flush("s1");
    r.sent.at(-1)!.settle({ kind: "done" });
    await r.settled();
    expect(r.runs.tracked()).toBe(0);
    expect(r.card(waits).state).toBe("sent");

    const dev = r.start("bun run dev", 8);
    await r.runs.sendNow(dev);
    r.sent.at(-1)!.settle({ kind: "done" });
    await r.settled();
    await r.runs.exited(8, 0);
    expect(r.runs.tracked()).toBe(1);
    r.runs.closed(8);
    expect(r.runs.tracked()).toBe(0);
  });
});

describe("FE-W1-001: a reload of the session keeps the cards of the runs the window still tracks", () => {
  test("a running run's card survives loadStart/loadDone with its actions, and its exit updates that one card", async () => {
    const r = rig();
    const runId = r.start("bun run dev", 5);
    r.dispatch({ t: "loadStart", sessionId: "s1" });
    r.dispatch({ t: "loadDone", sessionId: "s1", show: false });
    expect(r.card(runId)).toMatchObject({ state: "running", tabOpen: true });
    expect(r.card(runId).replayed).toBeUndefined();
    await r.runs.exited(5, 0);
    expect(r.items().filter((i) => i.kind === "terminalRun")).toHaveLength(1);
    expect(r.card(runId).state).toBe("sent");
  });

  test("a replayed note of a run still live shows the live card in the note's place; a delivered card keryx no longer replays is gone", async () => {
    const r = rig();
    const dev = r.start("bun run dev", 5);
    await r.runs.sendNow(dev);
    r.sent[0]!.settle({ kind: "done" });
    const done = r.start("ls", 6);
    await r.runs.exited(6, 0);
    r.sent[1]!.settle({ kind: "done" });
    await r.settled();
    r.runs.closed(6);
    r.dispatch({ t: "loadStart", sessionId: "s1" });
    r.dispatch({ t: "updates", updates: [{ sessionId: "s1", at: 1, update: {
      sessionUpdate: "user_message_chunk", content: { type: "text", text: "$ bun run dev" },
      _meta: { keryx: { terminalResult: { runId: dev, command: "bun run dev", state: "running", durationMs: 0, output: "" } } },
    } }] });
    r.dispatch({ t: "loadDone", sessionId: "s1", show: false });
    const runCards = r.items().filter((i): i is TerminalRunItem => i.kind === "terminalRun");
    expect(runCards.map((c) => c.runId)).toEqual([dev]);
    expect(runCards[0]).toMatchObject({ state: "sent-while-running", tabOpen: true });
    expect(runCards[0]!.replayed).toBeUndefined();
    expect(done).not.toBe(dev);
  });
});

describe("TP-004: branches no other test reaches", () => {
  test("a result that waited through a reconnect to a keryx without terminalResults is not sent", async () => {
    const r = rig({ accepts: null });
    const runId = r.start("ls", 5);
    await r.runs.exited(5, 0);
    expect(r.card(runId).state).toBe("waiting");
    r.setAccepts(false);
    r.runs.flush();
    expect(r.sent).toHaveLength(0);
    expect(r.card(runId)).toMatchObject({ state: "not-sent", error: "this keryx does not take run results" });
  });

  test("a waiting snapshot whose tab was closed before the process ended goes as it was: the hang-up is not read", async () => {
    const r = rig();
    r.idle.delete("s1");
    const runId = r.start("bun run dev", 5);
    r.tails.set(5, "ready");
    await r.runs.sendNow(runId);
    r.runs.closed(5);
    await r.runs.exited(5, 1);
    expect(r.tailCalls).toHaveLength(1);
    r.idle.add("s1");
    r.runs.flush("s1");
    expect(r.sent[0]!.results).toEqual([{ runId, command: "bun run dev", state: "running", durationMs: 0, output: "ready" }]);
  });

  test("a close while the exit's tail is read: the exit happened with the tab open, so its result is sent", async () => {
    const r = rig();
    const runId = r.start("ls", 5);
    r.tails.set(5, "a");
    const release = r.holdTail(5);
    const exiting = r.runs.exited(5, 0);
    r.runs.closed(5);
    await release();
    await exiting;
    expect(r.sent[0]!.results).toEqual([{ runId, command: "ls", state: "exited", exitCode: 0, durationMs: 0, output: "a" }]);
    expect(r.card(runId)).toMatchObject({ state: "sent", tabOpen: false });
  });

  test("Send output now, then the exit during its tail read: one result, the exit's", async () => {
    const r = rig();
    const runId = r.start("make", 5);
    r.tails.set(5, "built");
    const release = r.holdTail(5);
    const snapshot = r.runs.sendNow(runId);
    const exiting = r.runs.exited(5, 2);
    await release();
    await snapshot;
    await exiting;
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.results).toEqual([{ runId, command: "make", state: "exited", exitCode: 2, durationMs: 0, output: "built" }]);
  });

  test("a second Send output now during the first one's read does nothing", async () => {
    const r = rig();
    const runId = r.start("bun run dev", 5);
    const release = r.holdTail(5);
    const first = r.runs.sendNow(runId);
    const second = r.runs.sendNow(runId);
    await release();
    await first;
    await second;
    expect(r.tailCalls).toHaveLength(1);
    expect(r.sent).toHaveLength(1);
  });

  test("a close during Send output now's read: nothing is sent and the card says closed", async () => {
    const r = rig();
    const runId = r.start("bun run dev", 5);
    const release = r.holdTail(5);
    const snapshot = r.runs.sendNow(runId);
    r.runs.closed(5);
    await release();
    await snapshot;
    expect(r.sent).toHaveLength(0);
    expect(r.card(runId).state).toBe("closed");
  });

  test("a command of exactly 4096 characters is sent; one more is not", async () => {
    const r = rig();
    const longest = "a".repeat(RUN_COMMAND_MAX_CHARS);
    const ok = r.start(longest, 5);
    await r.runs.exited(5, 0);
    expect(r.card(ok).state).toBe("sent");
    r.sent[0]!.settle({ kind: "done" });
    await r.settled();
    const over = r.start(`${longest}b`, 6);
    await r.runs.exited(6, 0);
    expect(r.card(over).state).toBe("not-sent");
    expect(r.sent).toHaveLength(1);
  });

  test("a waiting snapshot replaced by its exit keeps its place in the delivery order", async () => {
    const r = rig();
    r.idle.delete("s1");
    const a = r.start("make a", 5);
    await r.runs.sendNow(a);
    const b = r.start("make b", 6);
    await r.runs.exited(6, 0);
    await r.runs.exited(5, 1);
    r.idle.add("s1");
    r.runs.flush("s1");
    expect(r.sent[0]!.results.map((x) => [x.runId, x.state])).toEqual([[a, "exited"], [b, "exited"]]);
  });

  test("exits of unknown tabs are kept for the 32 newest only", async () => {
    const r = rig();
    for (let id = 1000; id <= 1032; id++) await r.runs.exited(id, 0);
    const evicted = r.runs.requested("first", { sessionId: "s1" });
    r.runs.opened(evicted, tab(1000));
    await r.settled();
    expect(r.card(evicted).state).toBe("running");
    const kept = r.runs.requested("last", { sessionId: "s1" });
    r.runs.opened(kept, tab(1032));
    await r.settled();
    expect(r.card(kept).state).toBe("sent");
  });

  test("a failure reported after the tab opened changes nothing", () => {
    const r = rig();
    const runId = r.start("ls", 5);
    r.runs.failed(runId, "late");
    expect(r.card(runId)).toMatchObject({ state: "running", tabOpen: true });
    expect(r.card(runId).error).toBeUndefined();
  });
});

/** The slice of keryx's own contract module (`src/acp/terminal-result.ts`) these tests hold the desktop to. */
interface KeryxTerminalResultContract {
  TERMINAL_RESULTS_MAX: number;
  TERMINAL_COMMAND_MAX_CHARS: number;
  TERMINAL_RESULT_MAX_BYTES: number;
  parseTerminalResults(raw: unknown): { ok: true; results: readonly unknown[] } | { ok: false; reason: string };
}

// Loaded by URL when the test runs: the web view never imports keryx's module (its redaction reads
// node:fs), and this tsconfig does not type keryx's node-side code.
const keryxContract = (): Promise<KeryxTerminalResultContract> => import(new URL("../../../../src/acp/terminal-result.ts", import.meta.url).href);

describe("AR-001: the desktop's copies of keryx's terminal-results contract are keryx's", () => {
  test("the limits match keryx's own constants", async () => {
    const keryx = await keryxContract();
    expect(RESULTS_PER_PROMPT).toBe(keryx.TERMINAL_RESULTS_MAX);
    expect(RUN_COMMAND_MAX_CHARS).toBe(keryx.TERMINAL_COMMAND_MAX_CHARS);
    expect(RUN_OUTPUT_MAX_BYTES).toBe(keryx.TERMINAL_RESULT_MAX_BYTES);
  });

  test("a full batch the store builds passes keryx's own validator", async () => {
    const keryx = await keryxContract();
    const sent: TerminalResultEntry[][] = [];
    let busy = true;
    let clock = 1000;
    const runs = createTerminalRuns({
      acceptsResults: () => true,
      send: (_sid, results) => {
        if (busy) return null;
        sent.push([...results]);
        return new Promise<DeliveryOutcome>(() => {});
      },
      tail: async (id) => (id === 1 ? Array.from({ length: 400 }, (_, i) => `line ${i} ${"€".repeat(40)}`).join("\n") : `out ${id}`),
      showTab: () => {},
      dispatch: () => {},
      now: () => clock,
      newRunId,
      later: () => {},
    });
    for (let i = 1; i <= RESULTS_PER_PROMPT; i++) {
      clock += 7;
      const runId = runs.requested(i === 2 ? "x".repeat(RUN_COMMAND_MAX_CHARS) : `cmd ${i}`, { sessionId: "s1" });
      runs.opened(runId, tab(i));
      clock += 13;
      if (i === 3) await runs.sendNow(runId);
      else await runs.exited(i, i === 4 ? null : i);
    }
    busy = false;
    runs.flush("s1");
    expect(sent).toHaveLength(1);
    const batch = sent[0]!;
    expect(batch).toHaveLength(RESULTS_PER_PROMPT);
    expect(batch.map((x) => x.state).filter((s) => s === "running")).toHaveLength(1);
    expect(keryx.parseTerminalResults(batch)).toEqual({ ok: true, results: batch });
  });
});

describe("capRunOutput", () => {
  test("keeps the last lines and the last 16 KiB of UTF-8, never splitting a character, and says when it cut", () => {
    expect(capRunOutput("a\nb\n")).toBe("a\nb");
    const lines = (n: number) => Array.from({ length: n }, (_, i) => String(i)).join("\n");
    // Up to 200 lines nothing is cut, and nothing is said.
    expect(capRunOutput(lines(RUN_OUTPUT_LINES))).toBe(lines(RUN_OUTPUT_LINES));
    // More (the host is asked for one line more than a result keeps): the first line says earlier output was cut.
    const many = capRunOutput(lines(250)).split("\n");
    expect(many).toHaveLength(RUN_OUTPUT_LINES);
    expect(many[0]).toBe(RUN_OUTPUT_CUT);
    expect(many.slice(1)).toEqual(Array.from({ length: RUN_OUTPUT_LINES - 1 }, (_, i) => String(i + 51)));
    const wide = "ж".repeat(RUN_OUTPUT_MAX_BYTES); // 2 bytes each
    const cut = capRunOutput(`x${wide}`);
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(RUN_OUTPUT_MAX_BYTES);
    expect(cut.startsWith(`${RUN_OUTPUT_CUT}\n`)).toBe(true);
    expect(cut.slice(RUN_OUTPUT_CUT.length + 1)).toMatch(/^ж+$/);
    const euros = capRunOutput("€".repeat(6000));
    expect(euros.includes("�")).toBe(false);
    expect(new TextEncoder().encode(euros).length).toBeLessThanOrEqual(RUN_OUTPUT_MAX_BYTES);
    expect(euros.split("\n")[0]).toBe(RUN_OUTPUT_CUT);
  });
});
