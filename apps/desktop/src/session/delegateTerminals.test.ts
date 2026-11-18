import { describe, expect, test } from "bun:test";
import type { PtyTab } from "../platform/panels";
import { createDelegateTerminals, taskOf, type DelegateLaunch } from "./delegateTerminals";
import { initialState, reducer, type Action } from "./reducer";

const launch: DelegateLaunch = { runId: "ext:1", agentId: "claude-cli", title: "Claude · fix the build", argv: ["claude", "--", "fix the build"], cwd: "/proj" };
const tab = (id: number): PtyTab => ({ id, title: launch.title, owner: "user", cwd: "/proj", running: true, exitCode: null });

function rig(opts: { failOpen?: string } = {}) {
  const exits: string[] = [];
  let win = reducer({ ...initialState, phase: "ready" }, { t: "created", sessionId: "s1", show: true });
  const opened: DelegateLaunch[] = [];
  const shown: PtyTab[] = [];
  let next = 1;
  const d = createDelegateTerminals({
    openRun: async (l) => {
      if (opts.failOpen) throw new Error(opts.failOpen);
      opened.push(l);
      return tab(next++);
    },
    showTab: (t) => void shown.push(t),
    dispatch: (a: Action) => {
      win = reducer(win, a);
    },
    notifyExit: (sessionId, runId) => void exits.push(`${sessionId}/${runId}`),
  });
  const agents = () => win.convs.s1!.subagents;
  return { d, opened, shown, agents, exits };
}

describe("/delegate in the terminal: the run as a subagent", () => {
  test("start opens the tab with the argv as given, shows it, and registers a running external subagent", async () => {
    const r = rig();
    await r.d.start("s1", launch);
    expect(r.opened).toEqual([launch]);
    expect(r.shown.map((t) => t.id)).toEqual([1]);
    expect(r.agents()).toHaveLength(1);
    expect(r.agents()[0]).toMatchObject({
      id: "ext:1",
      label: "Claude · fix the build",
      runtime: "external",
      status: "running",
      task: "fix the build",
      agentId: "claude-cli",
    });
    expect(taskOf(launch)).toBe("fix the build");
  });

  test("exit 0 is done; a non-zero exit is failed with its code; a signal says so; a later exit changes nothing", async () => {
    const ok = rig();
    await ok.d.start("s1", launch);
    ok.d.exited(1, 0);
    expect(ok.agents()[0]).toMatchObject({ status: "done", detail: "exit 0" });
    ok.d.exited(1, 5);
    expect(ok.agents()[0]!.status).toBe("done");

    const bad = rig();
    await bad.d.start("s1", launch);
    bad.d.exited(1, 2);
    expect(bad.agents()[0]).toMatchObject({ status: "failed", detail: "exit 2" });

    const sig = rig();
    await sig.d.start("s1", launch);
    sig.d.exited(1, null);
    expect(sig.agents()[0]!.status).toBe("failed");
  });

  test("closing the tab while running ends it failed 'closed'; the hang-up exit that follows is ignored; a finished run stays finished", async () => {
    const r = rig();
    await r.d.start("s1", launch);
    r.d.closed(1);
    expect(r.agents()[0]).toMatchObject({ status: "failed", detail: "closed" });
    r.d.exited(1, null);
    expect(r.agents()[0]).toMatchObject({ status: "failed", detail: "closed" });

    const done = rig();
    await done.d.start("s1", launch);
    done.d.exited(1, 0);
    done.d.closed(1);
    expect(done.agents()[0]).toMatchObject({ status: "done", detail: "exit 0" });
  });

  test("a process that ends before its tab id is known is not lost", async () => {
    let win = reducer({ ...initialState, phase: "ready" }, { t: "created", sessionId: "s1", show: true });
    let d!: ReturnType<typeof createDelegateTerminals>;
    d = createDelegateTerminals({
      openRun: async () => {
        d.exited(1, 3);
        return tab(1);
      },
      showTab: () => {},
      dispatch: (a) => {
        win = reducer(win, a);
      },
    });
    await d.start("s1", launch);
    expect(win.convs.s1!.subagents[0]).toMatchObject({ status: "failed", detail: "exit 3" });
  });

  test("focus shows the tab while it is open; once closed it does not, and unknown runs are not focusable", async () => {
    const r = rig();
    await r.d.start("s1", launch);
    r.shown.length = 0;
    expect(r.d.focus("ext:1")).toBe(true);
    expect(r.shown.map((t) => t.id)).toEqual([1]);
    r.d.closed(1);
    expect(r.d.focus("ext:1")).toBe(false);
    expect(r.d.focus("nope")).toBe(false);
    expect(r.shown).toHaveLength(1);
  });

  test("a program that cannot start is a failed entry and the error is raised", async () => {
    const r = rig({ failOpen: "no such program" });
    let raised = "";
    await r.d.start("s1", launch).catch((e: Error) => void (raised = e.message));
    expect(raised).toBe("no such program");
    expect(r.agents()[0]!.status).toBe("failed");
    expect(r.agents()[0]!.detail).toContain("no such program");
  });
});

describe("the exit is reported to keryx (it stops watching the turn-done file)", () => {
  test("a process exit, once; a close of a still-running run; nothing for a tab that already ended", async () => {
    const r = rig();
    await r.d.start("s1", launch);
    r.d.exited(1, 0);
    r.d.closed(1);
    expect(r.exits).toEqual(["s1/ext:1"]);
    expect(r.agents()[0]!.status).toBe("done");

    const second = rig();
    await second.d.start("s1", { ...launch, runId: "ext:2" });
    second.d.closed(1);
    expect(second.exits).toEqual(["s1/ext:2"]);
    expect(second.agents()[0]).toMatchObject({ status: "failed", detail: "closed" });
  });
  test("a run that could not start is reported too", async () => {
    const r = rig({ failOpen: "no such program" });
    await r.d.start("s1", launch).catch(() => {});
    expect(r.exits).toEqual(["s1/ext:1"]);
  });
});

describe("auto-close: only a model-started run's tab closes", () => {
  const modelLaunch: DelegateLaunch = { ...launch, runId: "ext:m", autoClose: true };
  function closingRig() {
    const closed: number[] = [];
    let changes = 0;
    let win = reducer({ ...initialState, phase: "ready" }, { t: "created", sessionId: "s1", show: true });
    let next = 1;
    const d = createDelegateTerminals({
      openRun: async () => tab(next++),
      showTab: () => {},
      closeTab: (t) => void closed.push(t.id),
      onChange: () => void (changes += 1),
      dispatch: (a: Action) => {
        win = reducer(win, a);
      },
    });
    return { d, closed, agents: () => win.convs.s1!.subagents, changes: () => changes };
  }
  test("finish on a model-started run marks it done 'returned' and closes the tab; the exit that follows is not a failure", async () => {
    const r = closingRig();
    await r.d.start("s1", modelLaunch);
    expect(r.d.isOpen("ext:m")).toBe(true);
    r.d.finish("ext:m");
    expect(r.closed).toEqual([1]);
    expect(r.agents()[0]).toMatchObject({ status: "done", detail: "returned" });
    expect(r.d.isOpen("ext:m")).toBe(false);
    r.d.exited(1, null);
    r.d.closed(1);
    expect(r.agents()[0]).toMatchObject({ status: "done", detail: "returned" });
    expect(r.closed).toEqual([1]);
  });
  test("a human-started run stays open: finish is ignored", async () => {
    const r = closingRig();
    await r.d.start("s1", launch);
    r.d.finish("ext:1");
    expect(r.closed).toEqual([]);
    expect(r.d.isOpen("ext:1")).toBe(true);
    expect(r.agents()[0]!.status).toBe("running");
  });
  test("a finish that arrives before the tab exists closes it as soon as it does", async () => {
    let d!: ReturnType<typeof createDelegateTerminals>;
    const closed: number[] = [];
    d = createDelegateTerminals({
      openRun: async () => {
        d.finish("ext:m");
        return tab(7);
      },
      showTab: () => {},
      closeTab: (t) => void closed.push(t.id),
      dispatch: () => {},
    });
    await d.start("s1", modelLaunch);
    expect(closed).toEqual([7]);
  });
  test("no turn hook (agy): the process exit ends a model-started run and closes its tab; a human run's tab stays", async () => {
    const r = closingRig();
    await r.d.start("s1", modelLaunch);
    r.d.exited(1, 0);
    expect(r.agents()[0]).toMatchObject({ status: "done", detail: "exit 0" });
    expect(r.closed).toEqual([1]);
    const human = closingRig();
    await human.d.start("s1", launch);
    human.d.exited(1, 0);
    expect(human.closed).toEqual([]);
  });
});
