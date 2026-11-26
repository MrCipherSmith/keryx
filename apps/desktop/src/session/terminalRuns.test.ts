import { describe, expect, test } from "bun:test";
import type { PtyTab } from "../platform/panels";
import { initialState, reducer, type Action, type Item, type RoutedUpdate, type TerminalRunItem } from "./reducer";
import {
  BUSY_RETRY_MAX_MS,
  BUSY_RETRY_MS,
  capRunOutput,
  createTerminalRuns,
  newRunId,
  RESULTS_PER_PROMPT,
  RUN_COMMAND_MAX_CHARS,
  RUN_OUTPUT_CUT,
  RUN_OUTPUT_NOTHING_WHOLE,
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
  /** Tabs whose host ring dropped earlier output. */
  const truncated = new Set<number>();
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
      return { text: tails.get(id) ?? "", truncated: truncated.has(id) };
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
    runs, sent, idle, tails, truncated, tailCalls, failTail, shown, later, items, card, start, settled, holdTail,
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

  test("LG2-002: output the host ring dropped is said, even when what is left is under the caps", async () => {
    const r = rig();
    const runId = r.start("bun run build", 5);
    r.tails.set(5, "compiled\ndone");
    r.truncated.add(5);
    await r.runs.exited(5, 0);
    expect(r.sent[0]!.results[0]).toMatchObject({ runId, output: `${RUN_OUTPUT_CUT}\ncompiled\ndone` });
    // A tab whose ring kept everything says nothing.
    const whole = r.start("ls", 6);
    r.tails.set(6, "a");
    r.sent[0]!.settle({ kind: "done" });
    await r.settled();
    await r.runs.exited(6, 0);
    expect(r.sent[1]!.results[0]).toMatchObject({ runId: whole, output: "a" });
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
    // R2-RR-001: resume itself sends nothing (a turn the load's caller starts takes the slot first)…
    r.runs.resume("s1");
    expect(r.sent).toHaveLength(1);
    // …the next flush (the window's arbiter, after the load's render) does, once.
    r.runs.flush();
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1]!.results.map((x) => x.runId)).toEqual([runId]);
    r.runs.flush();
    expect(r.sent).toHaveLength(2);
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

/** keryx's replay of a run's stored note (`_meta.keryx.terminalResult`) into s1. */
function noteUpdate(at: number, runId: string, command: string, result: { state: "running" } | { state: "exited"; exitCode: number }): RoutedUpdate {
  return { sessionId: "s1", at, update: {
    sessionUpdate: "user_message_chunk", content: { type: "text", text: `$ ${command}` },
    _meta: { keryx: { terminalResult: { runId, command, durationMs: 0, output: "", ...result } } },
  } };
}
const agentUpdate = (at: number, text: string): RoutedUpdate => ({ sessionId: "s1", at, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
/** A session/load of s1 whose replay is `updates`. */
function reload(r: ReturnType<typeof rig>, updates: RoutedUpdate[]): void {
  r.dispatch({ t: "loadStart", sessionId: "s1" });
  r.dispatch({ t: "updates", updates });
  r.dispatch({ t: "loadDone", sessionId: "s1", show: false });
}

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

  test("R2-FE-006: a replayed note of a run still live shows the live card in the note's place, before the reply that followed it; a delivered card keryx no longer replays is gone", async () => {
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
    r.dispatch({ t: "updates", updates: [
      { sessionId: "s1", at: 1, update: {
        sessionUpdate: "user_message_chunk", content: { type: "text", text: "$ bun run dev" },
        _meta: { keryx: { terminalResult: { runId: dev, command: "bun run dev", state: "running", durationMs: 0, output: "" } } },
      } },
      { sessionId: "s1", at: 2, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The server is up." } } },
    ] });
    const note = r.win().loading.s1!.items[0]!;
    expect(note).toMatchObject({ kind: "terminalRun", runId: dev, replayed: true });
    r.dispatch({ t: "loadDone", sessionId: "s1", show: false });
    const items = r.items();
    expect(items.map((i) => i.kind)).toEqual(["terminalRun", "agent"]);
    expect(items[0]).toMatchObject({ id: note.id, runId: dev, state: "sent-while-running", tabOpen: true });
    expect((items[0] as TerminalRunItem).replayed).toBeUndefined();
    expect(items.some((i) => i.kind === "terminalRun" && i.runId === done)).toBe(false);
  });

  test("R3-FE-001: a card a replay put in its note's place stays there when its result is sent again, before the agent's reply to the note", async () => {
    const r = rig();
    const runId = r.start("make", 5);
    await r.runs.exited(5, 0);
    // keryx stored the note, then the connection was lost with no answer: the prompt waits.
    r.sent[0]!.settle({ kind: "wait" });
    await r.settled();
    expect(r.card(runId).state).toBe("waiting");
    r.dispatch({ t: "loadStart", sessionId: "s1" });
    r.dispatch({ t: "updates", updates: [
      { sessionId: "s1", at: 1, update: {
        sessionUpdate: "user_message_chunk", content: { type: "text", text: "$ make" },
        _meta: { keryx: { terminalResult: { runId, command: "make", state: "exited", exitCode: 0, durationMs: 0, output: "" } } },
      } },
      { sessionId: "s1", at: 2, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The build passed." } } },
    ] });
    r.dispatch({ t: "loadDone", sessionId: "s1", show: false });
    // The replayed note holds a final result, the one this run sends again: keryx answers it as a duplicate.
    expect(r.card(runId).inHistory).toBe("final");
    r.runs.resume("s1");
    r.runs.flush("s1");
    expect(r.sent).toHaveLength(2);
    expect(r.card(runId).state).toBe("sent");
    expect(r.items().map((i) => i.kind)).toEqual(["terminalRun", "agent"]);
    // A card with no note in the transcript still goes to the end, after what the turn before it wrote.
    r.sent[1]!.settle({ kind: "done" });
    await r.settled();
    const other = r.start("ls", 6);
    await r.runs.exited(6, 0);
    expect(r.items().map((i) => (i.kind === "terminalRun" ? i.runId : i.kind))).toEqual([runId, "agent", other]);
  });

  test("T16-Q1: keryx replays a snapshot and the exit for one run: the live card takes the exit note's place, the snapshot stays a replayed note, and updates and a re-send touch only the live card", async () => {
    const r = rig();
    const dev = r.start("bun run dev", 5);
    await r.runs.sendNow(dev);
    // keryx stored the snapshot and recorded its turn, then the connection was lost with no answer; the
    // process exits meanwhile, and its exit's result waits for s1 to be held again.
    r.sent[0]!.settle({ kind: "wait" });
    await r.settled();
    await r.runs.exited(5, 0);
    expect(r.sent).toHaveLength(1);
    const snapshotNote = noteUpdate(1, dev, "bun run dev", { state: "running" });
    // The load holds s1 again: keryx has the snapshot only, and the exit goes for the first time.
    reload(r, [snapshotNote, agentUpdate(2, "Still starting.")]);
    r.runs.resume("s1");
    r.runs.flush("s1");
    expect(r.sent[1]!.results.map((x) => [x.runId, x.state])).toEqual([[dev, "exited"]]);
    // keryx stored the exit as a second note, then the connection was lost again with no answer.
    r.sent[1]!.settle({ kind: "wait" });
    await r.settled();
    reload(r, [snapshotNote, agentUpdate(2, "Still starting."), noteUpdate(3, dev, "bun run dev", { state: "exited", exitCode: 0 })]);
    const cards = () => r.items().filter((i): i is TerminalRunItem => i.kind === "terminalRun");
    expect(r.items().map((i) => i.kind)).toEqual(["terminalRun", "agent", "terminalRun"]);
    expect(cards()[0]).toMatchObject({ runId: dev, replayed: true, state: "sent-while-running" });
    expect(cards()[1]!.replayed).toBeUndefined();
    expect(cards()[1]!.inHistory).toBe("final");
    const snapshot = cards()[0]!;
    r.runs.resume("s1");
    r.runs.flush("s1");
    expect(r.sent[2]!.results).toEqual(r.sent[1]!.results);
    r.sent[2]!.settle({ kind: "done" });
    await r.settled();
    expect(r.items().map((i) => i.kind)).toEqual(["terminalRun", "agent", "terminalRun"]);
    expect(cards()[0]).toEqual(snapshot);
    expect(cards()[1]!.state).toBe("sent");
  });

  test("R4-LG-002: a card a reload put in a snapshot note's place moves to the end when the run's exit goes: keryx stores it as a new note and the agent's reply follows the card", async () => {
    const r = rig();
    const dev = r.start("bun run dev", 5);
    await r.runs.sendNow(dev);
    // keryx stored the snapshot and recorded its turn; its answer was lost. The process then ends with its
    // tab open: the exit's result replaces the snapshot that waits.
    r.sent[0]!.settle({ kind: "wait" });
    await r.settled();
    await r.runs.exited(5, 0);
    expect(r.card(dev)).toMatchObject({ state: "waiting", exitCode: 0 });
    reload(r, [noteUpdate(1, dev, "bun run dev", { state: "running" }), agentUpdate(2, "Still starting.")]);
    expect(r.items().map((i) => i.kind)).toEqual(["terminalRun", "agent"]);
    expect(r.card(dev).inHistory).toBe("running");
    r.runs.resume("s1");
    r.runs.flush("s1");
    expect(r.sent[1]!.results.map((x) => x.state)).toEqual(["exited"]);
    const order = () => r.items().map((i) => (i.kind === "terminalRun" ? i.runId : i.kind === "agent" ? i.text : i.kind));
    expect(order()).toEqual(["Still starting.", dev]);
    expect(r.card(dev).inHistory).toBeUndefined();
    // The follow-up turn's reply streams after the card, as its own message.
    r.dispatch({ t: "busy", sessionId: "s1", busy: true });
    r.dispatch({ t: "updates", updates: [agentUpdate(3, "It exited cleanly.")] });
    expect(order()).toEqual(["Still starting.", dev, "It exited cleanly."]);
  });

  test("R5-TP-001: a card a reload put in a snapshot note's place stays there when that snapshot is sent again while the run still runs: keryx holds it already, and the agent's reply follows the card", async () => {
    const r = rig();
    const dev = r.start("bun run dev", 5);
    await r.runs.sendNow(dev);
    // keryx stored the snapshot and recorded its turn; its answer was lost. The process keeps running.
    r.sent[0]!.settle({ kind: "wait" });
    await r.settled();
    expect(r.card(dev).state).toBe("waiting");
    reload(r, [noteUpdate(1, dev, "bun run dev", { state: "running" }), agentUpdate(2, "Still starting.")]);
    expect(r.card(dev).inHistory).toBe("running");
    r.runs.resume("s1");
    r.runs.flush("s1");
    // The same snapshot goes again: a note of the same kind as the one keryx replayed, so the card keeps its place.
    expect(r.sent[1]!.results.map((x) => x.state)).toEqual(["running"]);
    const order = () => r.items().map((i) => (i.kind === "terminalRun" ? i.runId : i.kind === "agent" ? i.text : i.kind));
    expect(order()).toEqual([dev, "Still starting."]);
    expect(r.card(dev)).toMatchObject({ state: "sent-while-running", inHistory: "running" });
    // keryx answers the duplicate: no turn runs, the card stays where it is.
    r.sent[1]!.settle({ kind: "done" });
    await r.settled();
    expect(order()).toEqual([dev, "Still starting."]);
    expect(r.card(dev).inHistory).toBe("running");
  });

  test("R4-AR-003: a card a later reload appends at the end (the replay no longer holds its note) keeps no mark from the earlier reload, and moves when its result goes", async () => {
    const r = rig();
    const runId = r.start("make", 5);
    await r.runs.exited(5, 0);
    r.sent[0]!.settle({ kind: "wait" });
    await r.settled();
    reload(r, [noteUpdate(1, runId, "make", { state: "exited", exitCode: 0 }), agentUpdate(2, "The build passed.")]);
    expect(r.card(runId).inHistory).toBe("final");
    // A compaction removed the note while the result still waits: the next replay has only its summary.
    reload(r, [agentUpdate(1, "Summary.")]);
    expect(r.items().map((i) => i.kind)).toEqual(["agent", "terminalRun"]);
    expect(r.card(runId).inHistory).toBeUndefined();
    r.dispatch({ t: "notice", sessionId: "s1", level: "info", text: "later" });
    r.runs.resume("s1");
    r.runs.flush("s1");
    expect(r.sent).toHaveLength(2);
    expect(r.items().map((i) => i.kind)).toEqual(["agent", "notice", "terminalRun"]);
  });

  test("R2-UX-001: a run that can no longer change (closed, could not start, not sent, its tab closed) is not drawn again after a reload; one that can is kept at the end", async () => {
    const r = rig();
    const closed = r.start("sleep 60", 5);
    r.runs.closed(5);
    await r.runs.exited(5, 1);
    const failed = r.runs.requested("bun test", { sessionId: "s1" });
    r.runs.failed(failed, "no shell");
    const long = r.start(`echo ${"a".repeat(RUN_COMMAND_MAX_CHARS)}`, 6);
    await r.runs.exited(6, 0);
    r.idle.delete("s1");
    const waits = r.start("make", 7);
    await r.runs.exited(7, 0);
    expect([closed, failed, long, waits].map((id) => r.card(id).state)).toEqual(["closed", "start-failed", "not-sent", "waiting"]);
    const reload = () => {
      r.dispatch({ t: "loadStart", sessionId: "s1" });
      r.dispatch({ t: "updates", updates: [{ sessionId: "s1", at: 1, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Newest reply." } } }] });
      r.dispatch({ t: "loadDone", sessionId: "s1", show: false });
    };
    const runIds = () => r.items().filter((i): i is TerminalRunItem => i.kind === "terminalRun").map((i) => i.runId);
    reload();
    // The not-sent run's process had ended, its tab is still open: a reload treats not sent as final whatever
    // its tab does, so its card is not kept. The store still holds the run until its tab closes (R4-RR-001).
    expect(r.items().map((i) => i.kind)).toEqual(["agent", "terminalRun"]);
    expect(runIds()).toEqual([waits]);
    expect(r.runs.tracked()).toBe(2);
    // Its tab's close does not draw the card again, and the store lets the run go.
    r.runs.closed(6);
    expect(runIds()).toEqual([waits]);
    expect(r.runs.tracked()).toBe(1);
    // A later reload (a /rewind that removed its turn) does not bring a closed run back either.
    reload();
    expect(runIds()).toEqual([waits]);
  });

  test("R2-UX-001: a not-sent run whose process still runs (its tab stays open) is not re-appended on a reload, nor by its exit", async () => {
    const r = rig();
    const long = r.start(`echo ${"a".repeat(RUN_COMMAND_MAX_CHARS)}`, 6);
    await r.runs.sendNow(long);
    expect(r.card(long)).toMatchObject({ state: "not-sent", tabOpen: true });
    r.dispatch({ t: "loadStart", sessionId: "s1" });
    r.dispatch({ t: "updates", updates: [{ sessionId: "s1", at: 1, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Newest reply." } } }] });
    r.dispatch({ t: "loadDone", sessionId: "s1", show: false });
    expect(r.items().map((i) => i.kind)).toEqual(["agent"]);
    // The process ends after the card went: nothing draws it again. Its tab is still open, so the store keeps it…
    await r.runs.exited(6, 0);
    expect(r.items().map((i) => i.kind)).toEqual(["agent"]);
    expect(r.runs.tracked()).toBe(1);
    // …until the tab closes, which draws nothing either.
    r.runs.closed(6);
    expect(r.items().map((i) => i.kind)).toEqual(["agent"]);
    expect(r.runs.tracked()).toBe(0);
  });
});

describe("R4-RR-001: a not-sent run stays in the store while its tab is open: Show tab works, and the tab's close reaches the card", () => {
  const long = `echo ${"a".repeat(RUN_COMMAND_MAX_CHARS)}`;
  // Every way into "not sent", each ending with the run's process over and its tab 5 still open.
  const paths: Array<[string, () => Promise<{ r: ReturnType<typeof rig>; runId: string }>]> = [
    ["a keryx without terminalResults", async () => {
      const r = rig({ accepts: false });
      const runId = r.start("bun test", 5);
      await r.runs.exited(5, 0);
      return { r, runId };
    }],
    ["a command over 4096 characters", async () => {
      const r = rig();
      const runId = r.start(long, 5);
      await r.runs.exited(5, 0);
      return { r, runId };
    }],
    ["a results prompt keryx refused", async () => {
      const r = rig();
      const runId = r.start("ls", 5);
      await r.runs.exited(5, 0);
      r.sent[0]!.settle({ kind: "refused", error: "invalid params" });
      await r.settled();
      return { r, runId };
    }],
    ["a reconnect to a keryx without terminalResults", async () => {
      const r = rig({ accepts: null });
      const runId = r.start("ls", 5);
      await r.runs.exited(5, 0);
      r.setAccepts(false);
      r.runs.flush();
      return { r, runId };
    }],
    ["a refused Send output now, then the exit", async () => {
      const r = rig();
      const runId = r.start("bun run dev", 5);
      await r.runs.sendNow(runId);
      r.sent[0]!.settle({ kind: "refused", error: "invalid params" });
      await r.settled();
      await r.runs.exited(5, 0);
      return { r, runId };
    }],
  ];
  for (const [path, reach] of paths) {
    test(`${path}: Show tab still shows the tab; only its close updates the card, and then the store forgets the run`, async () => {
      const { r, runId } = await reach();
      expect(r.card(runId)).toMatchObject({ state: "not-sent", exitCode: 0, tabOpen: true });
      expect(r.runs.tracked()).toBe(1);
      expect(r.runs.showTab(runId)).toBe(true);
      expect(r.shown).toEqual([5]);
      r.runs.closed(5);
      expect(r.card(runId)).toMatchObject({ state: "not-sent", tabOpen: false });
      expect(r.runs.tracked()).toBe(0);
      expect(r.runs.showTab(runId)).toBe(false);
    });
  }
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

  test("R2-FE-004: a close during Send output now's read: that snapshot still goes, once, as read; the hang-up adds nothing", async () => {
    const r = rig();
    const runId = r.start("bun run dev", 5);
    r.tails.set(5, "listening");
    const release = r.holdTail(5);
    const snapshot = r.runs.sendNow(runId);
    r.runs.closed(5);
    expect(r.card(runId)).toMatchObject({ state: "running", tabOpen: false });
    await release();
    await snapshot;
    expect(r.sent.map((p) => p.results)).toEqual([[{ runId, command: "bun run dev", state: "running", durationMs: 0, output: "listening" }]]);
    expect(r.card(runId)).toMatchObject({ state: "sent-while-running", tabOpen: false });
    await r.runs.exited(5, null);
    r.sent[0]!.settle({ kind: "done" });
    await r.settled();
    r.runs.flush();
    expect(r.sent).toHaveLength(1);
    expect(r.tailCalls).toHaveLength(1);
    expect(r.runs.tracked()).toBe(0);
  });

  test("R2-FE-004: the hang-up landing during that read too: the snapshot goes once (saying the tail could not be read), and the hang-up is no result", async () => {
    const r = rig();
    const runId = r.start("bun run dev", 5);
    const release = r.holdTail(5);
    const snapshot = r.runs.sendNow(runId);
    r.runs.closed(5);
    await r.runs.exited(5, null);
    r.failTail.add(5); // the tab is gone by the time its tail is read
    await release();
    await snapshot;
    expect(r.tailCalls).toHaveLength(1);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.results).toEqual([{ runId, command: "bun run dev", state: "running", durationMs: 0, output: "[the output could not be read: no such tab]" }]);
    r.sent[0]!.settle({ kind: "done" });
    await r.settled();
    r.runs.flush();
    expect(r.sent).toHaveLength(1);
    expect(r.runs.tracked()).toBe(0);
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
  TERMINAL_OUTPUT_CUT_LINE: string;
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
    // keryx's second cut keeps the desktop's cut line first only when it matches this text exactly.
    expect(RUN_OUTPUT_CUT).toBe(keryx.TERMINAL_OUTPUT_CUT_LINE);
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
      tail: async (id) => ({ text: id === 1 ? Array.from({ length: 400 }, (_, i) => `line ${i} ${"€".repeat(40)}`).join("\n") : `out ${id}`, truncated: id === 5 }),
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
  const encoder = new TextEncoder();
  /** The bytes a cut output has for the lines after its RUN_OUTPUT_CUT line. */
  const room = RUN_OUTPUT_MAX_BYTES - encoder.encode(`${RUN_OUTPUT_CUT}\n`).length;
  const lines = (n: number) => Array.from({ length: n }, (_, i) => String(i)).join("\n");

  test("keeps the last lines, and says when it cut", () => {
    expect(capRunOutput("a\nb\n")).toBe("a\nb");
    // Up to 200 lines nothing is cut, and nothing is said.
    expect(capRunOutput(lines(RUN_OUTPUT_LINES))).toBe(lines(RUN_OUTPUT_LINES));
    // More (the host is asked for one line more than a result keeps): the first line says earlier output was cut.
    const many = capRunOutput(lines(250)).split("\n");
    expect(many).toHaveLength(RUN_OUTPUT_LINES);
    expect(many[0]).toBe(RUN_OUTPUT_CUT);
    expect(many.slice(1)).toEqual(Array.from({ length: RUN_OUTPUT_LINES - 1 }, (_, i) => String(i + 51)));
  });

  test("R2-TP-003: a byte cut keeps exactly the whole lines that fit beside the cut line, never splitting a character", () => {
    // The cut lands where a line starts: that line and all after it fit exactly, to the last byte.
    const tail = "ж".repeat(room / 2); // 2 bytes each
    const cut = capRunOutput(`${"h".repeat(100)}\n${tail}`);
    expect(cut).toBe(`${RUN_OUTPUT_CUT}\n${tail}`);
    expect(encoder.encode(cut).length).toBe(RUN_OUTPUT_MAX_BYTES);
    // A one-character line one byte before that place would pass the cap by one byte: it is left out.
    const rest = "r".repeat(room - 1);
    expect(capRunOutput(`${"h".repeat(100)}\nq\n${rest}`)).toBe(`${RUN_OUTPUT_CUT}\n${rest}`);
    // Lines of 99 bytes: the cut lands inside one, which is left out; the 163 after it fit, and one more would not.
    const rows = Array.from({ length: RUN_OUTPUT_LINES }, (_, i) => `${String(i).padStart(3, "0")}${"r".repeat(96)}`);
    expect(capRunOutput(rows.join("\n"))).toBe([RUN_OUTPUT_CUT, ...rows.slice(-163)].join("\n"));
    expect(encoder.encode([RUN_OUTPUT_CUT, ...rows.slice(-164)].join("\n")).length).toBeGreaterThan(RUN_OUTPUT_MAX_BYTES);
    // Multi-byte lines: whole lines only, no broken character, within the cap.
    const euros = capRunOutput(Array.from({ length: 150 }, () => "€".repeat(40)).join("\n")).split("\n");
    expect(euros[0]).toBe(RUN_OUTPUT_CUT);
    expect(euros.slice(1).every((l) => l === "€".repeat(40))).toBe(true);
    expect(encoder.encode(euros.join("\n")).length).toBeLessThanOrEqual(RUN_OUTPUT_MAX_BYTES);
    // One line longer than the caps: no whole line fits, so no fragment of it goes; the cut line says why nothing follows.
    expect(capRunOutput(`x${"ж".repeat(RUN_OUTPUT_MAX_BYTES)}`)).toBe(`${RUN_OUTPUT_CUT}\n${RUN_OUTPUT_NOTHING_WHOLE}`);
    expect(RUN_OUTPUT_NOTHING_WHOLE).toBe("[the last line is longer than 16 KiB and was not sent]");
  });

  /** A text whose byte cut lands `at` bytes into `line`, and the text after that line. */
  const cutInside = (line: string, at: number) => {
    const rest = "r".repeat(room + at - line.length - 1);
    return { text: `${"h".repeat(100)}\n${line}\n${rest}`, rest };
  };

  test("SC3-001: a byte cut inside a secret's line leaves that whole line out, so no fragment of it reaches keryx's redaction", () => {
    const token = ["ghp", "A".repeat(36)].join("_");
    const cases: ReadonlyArray<readonly [string, number]> = [
      [`token ${token}`, "token g".length], // inside the ghp_ prefix
      [`API_KEY=${"s".repeat(24)}`, "API_".length], // inside the NAME= label
    ];
    for (const [line, at] of cases) {
      const { text, rest } = cutInside(line, at);
      const out = capRunOutput(text);
      expect(out).toBe(`${RUN_OUTPUT_CUT}\n${rest}`);
      expect(out).not.toContain(line.slice(at, at + 8));
    }
  });

  test("R2-LG-003: a long first line among 200 goes whole: at most 200 lines, the cut line included", () => {
    const short = Array.from({ length: RUN_OUTPUT_LINES - 1 }, (_, i) => `line ${i}`);
    const out = capRunOutput([`{${"x".repeat(20_000)}}`, ...short].join("\n")).split("\n");
    expect(out).toHaveLength(RUN_OUTPUT_LINES);
    expect(out[0]).toBe(RUN_OUTPUT_CUT);
    expect(out.slice(1)).toEqual(short);
  });

  test("LG2-002: output the host already cut starts with the cut line, also under the caps, and within the 200 lines", () => {
    expect(capRunOutput("a\nb", true)).toBe(`${RUN_OUTPUT_CUT}\na\nb`);
    expect(capRunOutput("", true)).toBe(`${RUN_OUTPUT_CUT}\n${RUN_OUTPUT_NOTHING_WHOLE}`);
    const full = capRunOutput(lines(RUN_OUTPUT_LINES), true).split("\n");
    expect(full).toHaveLength(RUN_OUTPUT_LINES);
    expect(full[0]).toBe(RUN_OUTPUT_CUT);
    expect(full.slice(1)).toEqual(Array.from({ length: RUN_OUTPUT_LINES - 1 }, (_, i) => String(i + 1)));
  });
});
