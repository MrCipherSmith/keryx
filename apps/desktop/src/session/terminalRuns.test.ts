import { describe, expect, test } from "bun:test";
import type { PtyTab } from "../platform/panels";
import { initialState, reducer, type Action, type Item, type TerminalRunItem } from "./reducer";
import {
  capRunOutput,
  createTerminalRuns,
  RESULTS_PER_PROMPT,
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
    const runId = runs.requested(command, { sessionId: sid, source: "message" });
    runs.opened(runId, tab(tabId));
    return runId;
  };
  const settled = () => new Promise<void>((r) => setTimeout(r, 0));
  return {
    runs, sent, idle, tails, tailCalls, failTail, shown, later, items, card, start, settled,
    advance: (ms: number) => void (clock += ms),
    setAccepts: (v: boolean | null) => void (accepts = v),
    win: () => win,
    dispatch: (a: Action) => void (win = reducer(win, a)),
  };
}

describe("a Run is a tracked run of the session that showed the button", () => {
  test("the click adds a starting card; the open tab makes it running with Show tab", () => {
    const r = rig();
    const runId = r.runs.requested("bun test", { sessionId: "s1", source: "tool" });
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
    expect(r.tailCalls).toEqual([[5, RUN_OUTPUT_LINES]]);
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
    const runId = r.runs.requested("bun test", { sessionId: "s1", source: "message" });
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
    const runId = r.runs.requested("false", { sessionId: "s1", source: "message" });
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

describe("capRunOutput", () => {
  test("keeps the last 200 lines, then the last 16 KiB of UTF-8, never splitting a character", () => {
    expect(capRunOutput("a\nb\n")).toBe("a\nb");
    const many = Array.from({ length: 250 }, (_, i) => String(i)).join("\n");
    expect(capRunOutput(many).split("\n")).toEqual(Array.from({ length: 200 }, (_, i) => String(i + 50)));
    const wide = "ж".repeat(RUN_OUTPUT_MAX_BYTES); // 2 bytes each
    const cut = capRunOutput(`x${wide}`);
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(RUN_OUTPUT_MAX_BYTES);
    expect(cut).toBe("ж".repeat(RUN_OUTPUT_MAX_BYTES / 2));
    expect(capRunOutput("€".repeat(6000)).includes("�")).toBe(false);
  });
});
