import { describe, expect, test } from "bun:test";
import type { AvailableCommand, CommandResult } from "../acp/types";
import { initialState, pendingQueueSend, reducer, type Action, type CommandItem, type WindowState } from "./reducer";
import { resolveMode, resolveModel, runCommandLine, type RunDeps } from "./commandRunner";

const cmd = (name: string, surface: "text" | "view" | "dialog" | "client" = "text", busy: "run" | "refuse" = "run"): AvailableCommand => ({
  name,
  description: name,
  _meta: { keryx: { group: "G", surface, busy } },
});
const COMMANDS = [
  cmd("tasks"),
  cmd("goal", "text", "refuse"),
  cmd("delegate"),
  cmd("schedules", "view"),
  cmd("schedule", "view"),
  cmd("compact"),
  cmd("rewind", "text", "refuse"),
  cmd("new", "client", "refuse"),
  cmd("resume", "client", "refuse"),
  cmd("interrupt", "client"),
  cmd("mode", "client"),
  cmd("model", "client"),
  cmd("connect", "dialog"),
  cmd("queue", "client"),
];

interface Rig {
  deps: RunDeps;
  calls: Array<{ method: string; params: unknown }>;
  win: () => WindowState;
  log: string[];
  sent: string[];
  /** `startTurn` calls: [sessionId, text]. */
  started: Array<[string, string]>;
}

function rig(over: Partial<RunDeps> = {}, reply: (method: string, params: unknown) => unknown = () => ({ text: "ok" })): Rig {
  let win = reducer({ ...initialState, phase: "ready" }, { t: "created", sessionId: "s1", show: true });
  const calls: Rig["calls"] = [];
  const log: string[] = [];
  const sent: string[] = [];
  const started: Array<[string, string]> = [];
  const dispatch = (a: Action) => {
    win = reducer(win, a);
  };
  const deps: RunDeps = {
    client: {
      request: async <T,>(method: string, params?: unknown) => {
        calls.push({ method, params });
        const r = reply(method, params);
        if (r instanceof Error) throw r;
        return r as T;
      },
    },
    sessionId: "s1",
    busy: false,
    commands: COMMANDS,
    hasCommandMethod: true,
    queue: [],
    dispatch,
    sendPrompt: (t) => {
      sent.push(t);
      return true;
    },
    startTurn: (sid, t) => {
      started.push([sid, t]);
      return true;
    },
    newSession: () => log.push("new"),
    interrupt: () => log.push("interrupt"),
    applyEffects: (_s, e) => log.push(`effects:${e.join(",")}`),
    ui: {
      focusSessions: () => log.push("focus"),
      mode: (a) => log.push(`mode:${a}`),
      model: (a) => log.push(`model:${a}`),
      openProviders: (n, a) => log.push(`providers:${n}:${a}`),
      fillComposer: (t) => log.push(`fill:${t}`),
    },
    ...over,
  };
  return { deps, calls, win: () => win, log, sent, started };
}

const cards = (r: Rig) => r.win().convs.s1!.items.filter((i): i is CommandItem => i.kind === "command");

test("Desktop /routing opens its dialog while explicit subcommands still go to ACP", async () => {
  const r = rig({ commands: [...COMMANDS, cmd("routing", "view")] });
  r.deps.ui.openRouting = () => r.log.push("routing");
  expect(await runCommandLine("/routing", r.deps)).toBe(true);
  expect(r.log).toEqual(["routing"]);
  expect(r.calls).toHaveLength(0);
  await runCommandLine("/routing trust", r.deps);
  expect(r.calls).toEqual([{ method: "_keryx/command", params: { sessionId: "s1", name: "routing", args: "trust" } }]);
});

describe("commands in flight", () => {
  test("the command is tracked for its session while keryx answers, and untracked after (also on error)", async () => {
    const events: string[] = [];
    const track = (sid: string) => {
      events.push(`begin:${sid}`);
      return () => void events.push(`end:${sid}`);
    };
    const ok = rig({ trackCommand: track }, () => {
      events.push("request");
      return { text: "ok" };
    });
    await runCommandLine("/tasks", ok.deps);
    expect(events).toEqual(["begin:s1", "request", "end:s1"]);

    events.length = 0;
    const bad = rig({ trackCommand: track }, () => new Error("boom"));
    expect(await runCommandLine("/tasks", bad.deps)).toBe(false);
    expect(events).toEqual(["begin:s1", "end:s1"]);
  });

  test("a busy-refused command is never tracked (no request)", async () => {
    const events: string[] = [];
    const r = rig({ busy: true, trackCommand: (s) => (events.push(s), () => {}) });
    await runCommandLine("/rewind", r.deps);
    expect(events).toEqual([]);
  });
});

describe("/goal starts a turn (startTurn effect)", () => {
  const goalReply = (): CommandResult => ({ text: "Starting a turn on the goal.\n", _meta: { keryx: { effects: ["startTurn"], prompt: "make the build green" } } });

  test("the prompt keryx answered is sent exactly once, to the session the command ran in, and is not queued or re-sent", async () => {
    const r = rig({}, goalReply);
    expect(await runCommandLine("/goal make the build green", r.deps)).toBe(true);
    expect(r.calls).toEqual([{ method: "_keryx/command", params: { sessionId: "s1", name: "goal", args: "make the build green" } }]);
    expect(r.started).toEqual([["s1", "make the build green"]]);
    // The plain-text path is not taken: nothing else sent, nothing queued.
    expect(r.sent).toHaveLength(0);
    expect(r.win().convs.s1!.queue ?? []).toHaveLength(0);
    expect(r.log).toEqual(["effects:startTurn"]);
    expect(cards(r)).toHaveLength(1);
  });

  test("a refused /goal starts nothing; a turn that cannot start says so", async () => {
    const refused = rig({}, () => ({ text: "/goal: a goal <text> is required", _meta: { keryx: { refused: true } } }) satisfies CommandResult);
    expect(await runCommandLine("/goal", refused.deps)).toBe(true);
    expect(refused.started).toHaveLength(0);

    const blocked = rig({ startTurn: () => false }, goalReply);
    expect(await runCommandLine("/goal x", blocked.deps)).toBe(true);
    const notices = blocked.win().convs.s1!.items.filter((i) => i.kind === "notice");
    expect(notices).toHaveLength(1);
  });

  test("while a turn runs the command is refused before keryx is asked", async () => {
    const r = rig({ busy: true }, goalReply);
    expect(await runCommandLine("/goal x", r.deps)).toBe(false);
    expect(r.calls).toHaveLength(0);
    expect(r.started).toHaveLength(0);
  });
});

describe("text and view commands", () => {
  test("a text command sends exactly _keryx/command {sessionId, name, args} and adds a card", async () => {
    const r = rig({}, () => ({ text: "t1 running" }));
    const ok = await runCommandLine("/tasks kill t3", r.deps);
    expect(ok).toBe(true);
    expect(r.calls).toEqual([{ method: "_keryx/command", params: { sessionId: "s1", name: "tasks", args: "kill t3" } }]);
    expect(cards(r)).toHaveLength(1);
    expect(cards(r)[0]).toEqual({ kind: "command", id: 1, line: "/tasks kill t3", text: "t1 running", refused: false, view: null });
    expect(r.sent).toHaveLength(0);
  });

  test("a result keryx refused clears the draft (true) and is a refused card", async () => {
    const r = rig({}, () => ({ text: "busy", _meta: { keryx: { refused: true } } }) satisfies CommandResult);
    expect(await runCommandLine("/compact", r.deps)).toBe(true);
    expect(cards(r)[0]?.refused).toBe(true);
    expect(cards(r)[0]?.text).toBe("busy");
  });

  test("an rpc error is shown as a refused card and keeps the draft", async () => {
    const r = rig({}, () => new Error("unknown command: tasks"));
    expect(await runCommandLine("/tasks", r.deps)).toBe(false);
    expect(cards(r)[0]).toEqual({ kind: "command", id: 1, line: "/tasks", text: "unknown command: tasks", refused: true, error: true, view: null });
  });

  test("a draft with confirmAction opens one confirmation and shows no card; Confirm runs the command in place of the form's card", async () => {
    const asked: Array<{ label: string; confirm: string }> = [];
    const confirmAction = { label: "Confirm", confirm: "cadence: every 4 hours", command: "/schedule confirmed --name a -- x" };
    const r = rig({}, (_m, params) => ((params as { args: string }).args.startsWith("confirmed") ? { text: "stored" } : { text: "draft text", _meta: { keryx: { confirmAction } } }));
    r.deps.ui.confirm = async (q) => (asked.push(q), true);
    expect(await runCommandLine("/schedule --name a -- x", r.deps, { replaceId: 5 })).toBe(true);
    expect(asked).toEqual([{ label: "Confirm", confirm: "cadence: every 4 hours" }]);
    expect(r.calls.map((c) => (c.params as { args: string }).args)).toEqual(["--name a -- x", "confirmed --name a -- x"]);
    expect(cards(r).map((c) => c.text)).toEqual(["stored"]);
  });

  test("Cancel on a confirmAction sends nothing and adds no card", async () => {
    const confirmAction = { label: "Confirm", confirm: "card", command: "/schedule confirmed --name a -- x" };
    const r = rig({}, () => ({ text: "draft text", _meta: { keryx: { confirmAction } } }));
    r.deps.ui.confirm = async () => false;
    expect(await runCommandLine("/schedule --name a -- x", r.deps)).toBe(false);
    expect(r.calls).toHaveLength(1);
    expect(cards(r)).toHaveLength(0);
  });

  test("without a confirm dialog (or with a command the app does not know) the text answer is the card", async () => {
    const confirmAction = { label: "Confirm", confirm: "card", command: "/schedule confirmed --name a -- x" };
    const r = rig({}, () => ({ text: "draft text", _meta: { keryx: { confirmAction } } }));
    expect(await runCommandLine("/schedule --name a -- x", r.deps)).toBe(true);
    expect(cards(r)[0]?.text).toBe("draft text");
    const odd = rig({}, () => ({ text: "draft text", _meta: { keryx: { confirmAction: { ...confirmAction, command: "do something" } } } }));
    odd.deps.ui.confirm = async () => true;
    await runCommandLine("/schedule --name a -- x", odd.deps);
    expect(odd.calls).toHaveLength(1);
    expect(cards(odd)[0]?.text).toBe("draft text");
  });

  test("a view result is kept on the card and effects are applied", async () => {
    const view = { title: "Schedules", rows: [{ id: "s1", label: "nightly" }] };
    const r = rig({}, () => ({ text: "", _meta: { keryx: { view, effects: ["tasks", "transcript"] } } }));
    expect(await runCommandLine("/schedules", r.deps)).toBe(true);
    expect(cards(r)[0]?.view).toEqual(view);
    expect(r.log).toEqual(["effects:tasks,transcript"]);
  });

  test("a view's own command replaces its card and shows the masked line", async () => {
    const r = rig();
    await runCommandLine("/tasks a", r.deps);
    await runCommandLine("/tasks kill sk-secret", r.deps, { display: "/tasks kill ••••••", replaceId: 1 });
    expect(cards(r)).toHaveLength(1);
    expect(cards(r)[0]?.line).toBe("/tasks kill ••••••");
    expect(r.calls[1]?.params).toEqual({ sessionId: "s1", name: "tasks", args: "kill sk-secret" });
  });

  test("a command that refuses while busy shows the refusal without a request", async () => {
    const r = rig({ busy: true });
    expect(await runCommandLine("/rewind", r.deps)).toBe(false);
    expect(r.calls).toHaveLength(0);
    expect(cards(r)[0]?.refused).toBe(true);
  });

  test("a command that runs while busy still goes to keryx", async () => {
    const r = rig({ busy: true });
    expect(await runCommandLine("/tasks", r.deps)).toBe(true);
    expect(r.calls).toHaveLength(1);
  });
});

describe("fallback without the extension", () => {
  test("the command goes as prompt text and no request is made", async () => {
    const r = rig({ hasCommandMethod: false });
    expect(await runCommandLine("/tasks kill t3", r.deps)).toBe(true);
    expect(r.sent).toEqual(["/tasks kill t3"]);
    expect(r.calls).toHaveLength(0);
    expect(cards(r)).toHaveLength(0);
  });

  test("while a turn runs the fallback line is queued", async () => {
    const r = rig({ hasCommandMethod: false, busy: true });
    await runCommandLine("/tasks", r.deps);
    expect(r.win().convs.s1!.queue.map((q) => q.text)).toEqual(["/tasks"]);
  });
});

describe("plain text", () => {
  test("text with a leading space is not a command: it goes to the model", async () => {
    const r = rig();
    expect(await runCommandLine(" /new", r.deps)).toBe(true);
    expect(r.sent).toEqual([" /new"]);
    expect(r.log).toEqual([]);
  });

  test("an unadvertised /word is text for the model", async () => {
    const r = rig();
    await runCommandLine("/unknown x", r.deps);
    expect(r.sent).toEqual(["/unknown x"]);
  });

  test("normal text while a turn runs is queued, not sent", async () => {
    const r = rig({ busy: true });
    expect(await runCommandLine("next thing", r.deps)).toBe(true);
    expect(r.sent).toHaveLength(0);
    expect(r.win().convs.s1!.queue.map((q) => q.text)).toEqual(["next thing"]);
  });
});

describe("client commands", () => {
  test("/new starts a session and never calls _keryx/command", async () => {
    const r = rig();
    expect(await runCommandLine("/new", r.deps)).toBe(true);
    expect(r.log).toEqual(["new"]);
    expect(r.calls).toHaveLength(0);
  });

  test("/new refuses while a turn runs (busy: refuse)", async () => {
    const r = rig({ busy: true });
    expect(await runCommandLine("/new", r.deps)).toBe(false);
    expect(r.log).toEqual([]);
  });

  test("resume, interrupt, mode, model and connect act on the app", async () => {
    const r = rig({ busy: true });
    await runCommandLine("/interrupt", r.deps);
    await runCommandLine("/mode trust", r.deps);
    await runCommandLine("/model", r.deps);
    await runCommandLine("/connect openai", r.deps);
    expect(r.log).toEqual(["interrupt", "mode:trust", "model:", "providers:connect:openai"]);
    const idle = rig();
    await runCommandLine("/resume", idle.deps);
    expect(idle.log).toEqual(["focus"]);
    expect(r.calls).toHaveLength(0);
  });

  test("mode and model arguments resolve by id or name", () => {
    const modes = { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "auto", name: "Auto" }] };
    expect(resolveMode(modes, "AUTO")).toBe("auto");
    expect(resolveMode(modes, "nope")).toBeNull();
    const option = { id: "model", name: "Model", type: "select", currentValue: "a", options: [{ group: "g", name: "G", options: [{ value: "m1", name: "Sonnet" }] }, { value: "m2", name: "Opus" }] };
    expect(resolveModel(option, "sonnet")).toBe("m1");
    expect(resolveModel(option, "m2")).toBe("m2");
    expect(resolveModel(option, "x")).toBeNull();
  });
});

describe("/queue", () => {
  const queued = (texts: string[]) => texts.map((text, i) => ({ id: i + 10, text }));

  test("with no args it lists the queue in a card", async () => {
    const r = rig({ queue: queued(["one", "two"]) });
    await runCommandLine("/queue", r.deps);
    expect(cards(r)[0]?.text).toBe("1. one\n2. two");
  });

  test("remove N drops that entry", async () => {
    const r = rig({ busy: true });
    await runCommandLine("a", r.deps);
    await runCommandLine("b", r.deps);
    const live = { ...r.deps, queue: r.win().convs.s1!.queue };
    await runCommandLine("/queue remove 1", live);
    expect(r.win().convs.s1!.queue.map((q) => q.text)).toEqual(["b"]);
  });

  test("edit N moves the text into the composer and out of the queue", async () => {
    const r = rig({ busy: true });
    await runCommandLine("a", r.deps);
    await runCommandLine("/queue edit 1", { ...r.deps, queue: r.win().convs.s1!.queue });
    expect(r.log).toEqual(["fill:a"]);
    expect(r.win().convs.s1!.queue).toHaveLength(0);
  });

  test("force N makes it next and cancels the running turn", async () => {
    const r = rig({ busy: true });
    await runCommandLine("a", r.deps);
    await runCommandLine("b", r.deps);
    await runCommandLine("/queue force 2", { ...r.deps, queue: r.win().convs.s1!.queue });
    expect(r.win().convs.s1!.queue.map((q) => q.text)).toEqual(["b", "a"]);
    expect(r.log).toEqual(["interrupt"]);
  });

  test("a bad number is refused and keeps the draft", async () => {
    const r = rig({ queue: queued(["one"]) });
    expect(await runCommandLine("/queue remove 5", r.deps)).toBe(false);
    expect(cards(r)[0]?.refused).toBe(true);
  });
});

describe("queue state", () => {
  const busyConv = () => {
    let w = reducer({ ...initialState, phase: "ready" }, { t: "created", sessionId: "s1", show: true });
    w = reducer(w, { t: "busy", sessionId: "s1", busy: true });
    return w;
  };

  test("prompts queued while busy are sent in order as each turn ends", () => {
    let w = busyConv();
    w = reducer(w, { t: "queueAdd", sessionId: "s1", text: "first" });
    w = reducer(w, { t: "queueAdd", sessionId: "s1", text: "second" });
    // Still running: nothing to send.
    expect(pendingQueueSend(w.convs.s1!, false)).toBeNull();
    // The turn ends.
    w = reducer(w, { t: "busy", sessionId: "s1", busy: false });
    expect(pendingQueueSend(w.convs.s1!, true)).toBeNull(); // the turn is still being torn down
    const a = pendingQueueSend(w.convs.s1!, false);
    expect(a?.text).toBe("first");
    w = reducer(w, { t: "queueShift", sessionId: "s1" });
    w = reducer(w, { t: "busy", sessionId: "s1", busy: true });
    expect(pendingQueueSend(w.convs.s1!, false)).toBeNull();
    w = reducer(w, { t: "busy", sessionId: "s1", busy: false });
    expect(pendingQueueSend(w.convs.s1!, false)?.text).toBe("second");
  });

  test("a session that is not held sends nothing; blank text is never queued", () => {
    let w = busyConv();
    w = reducer(w, { t: "queueAdd", sessionId: "s1", text: "   " });
    expect(w.convs.s1!.queue).toHaveLength(0);
    w = reducer(w, { t: "queueAdd", sessionId: "s1", text: "x" });
    w = reducer(w, { t: "released", sessionId: "s1" });
    expect(pendingQueueSend(w.convs.s1!, false)).toBeNull();
  });

  test("a command card lives in the transcript and a replace keeps its place", () => {
    let w = busyConv();
    w = reducer(w, { t: "command", sessionId: "s1", card: { line: "/a", text: "1", refused: false, view: null } });
    w = reducer(w, { t: "command", sessionId: "s1", card: { line: "/b", text: "2", refused: false, view: null } });
    w = reducer(w, { t: "command", sessionId: "s1", card: { line: "/a2", text: "3", refused: false, view: null }, replaceId: 1 });
    expect(w.convs.s1!.items.map((i) => (i.kind === "command" ? `${i.id}:${i.line}` : i.kind))).toEqual(["1:/a2", "2:/b"]);
  });
});

describe("/delegate opens a terminal (openTerminal effect)", () => {
  const launch = { runId: "ext:1", agentId: "claude-cli", title: "Claude · fix the build", argv: ["claude", "--", "fix the build"], cwd: "/p" };
  const reply = (): CommandResult => ({ text: "opened\n", _meta: { keryx: { effects: ["openTerminal"], terminal: launch } } });

  test("the launch keryx answered goes to openTerminal for the session the command ran in", async () => {
    const opened: Array<[string, unknown]> = [];
    const r = rig({ openTerminal: (s, l) => void opened.push([s, l]) }, reply);
    expect(await runCommandLine("/delegate claude fix the build", r.deps)).toBe(true);
    expect(opened).toEqual([["s1", launch]]);
    expect(r.sent).toHaveLength(0);
  });

  test("a refused /delegate opens nothing", async () => {
    const opened: unknown[] = [];
    const r = rig({ openTerminal: (_s, l) => void opened.push(l) }, () => ({ text: "refused", _meta: { keryx: { refused: true, terminal: launch, effects: ["openTerminal"] } } }) satisfies CommandResult);
    await runCommandLine("/delegate claude x", r.deps);
    expect(opened).toHaveLength(0);
  });
});

test("Desktop /review opens configuration for this session with or without a target, even while busy", async () => {
  const drafts: unknown[] = [];
  const r = rig({ busy: true, prepareReview: (id, hints) => drafts.push({ id, ...hints }) });
  for (const command of ["/review", "/review #23", "/review https://github.com/acme/project/pull/45/"]) {
    expect(await runCommandLine(command, r.deps)).toBe(true);
  }
  expect(drafts).toEqual([{ id: "s1" }, { id: "s1", target: "#23" }, { id: "s1", target: "https://github.com/acme/project/pull/45" }]);
  expect(await runCommandLine("/review https://example.org/pull/42", r.deps)).toBe(false);
  expect(drafts).toHaveLength(3);
  expect(r.sent).toEqual([]);
  expect(r.started).toEqual([]);
  expect(r.calls).toEqual([]);
});

test("direct Desktop review launch requests open configuration before the chat turn", async () => {
  const drafts: unknown[] = [];
  const r = rig({ busy: true, prepareReview: (sessionId, hints) => drafts.push({ sessionId, ...hints }) });
  for (const line of [
    "Запусти адаптивное ревью https://github.com/acme/project/pull/9108 с review-orchestrator",
    "Запусти фоновое ревью этого PR в Keryx",
    "Run an adaptive review for #12 using review-orchestrator.",
  ]) expect(await runCommandLine(line, r.deps)).toBe(true);
  expect(drafts).toEqual([
    { sessionId: "s1", target: "https://github.com/acme/project/pull/9108" },
    { sessionId: "s1" },
    { sessionId: "s1", target: "#12" },
  ]);
  expect(r.sent).toEqual([]);
  expect(r.calls).toEqual([]);
  expect(r.win().convs.s1?.queue).toEqual([]);
});

test("questions, mixed work, and direct inline reviews remain ordinary prompts", async () => {
  const drafts: unknown[] = [];
  const r = rig({ prepareReview: (_sessionId, hints) => drafts.push(hints) });
  const lines = [
    "Как запустить адаптивное ревью #12 с review-orchestrator?",
    "Запусти ревью #12 и исправь замечания",
    "Запусти ревью #12 прямо в этой сессии",
    "Сделай ревью этого кода",
    "> Запусти адаптивное ревью #12",
  ];
  for (const line of lines) expect(await runCommandLine(line, r.deps)).toBe(true);
  expect(drafts).toEqual([]);
  expect(r.sent).toEqual(lines);
  const otherHost = rig();
  await runCommandLine("Запусти адаптивное ревью #12", otherHost.deps);
  expect(otherHost.sent).toEqual(["Запусти адаптивное ревью #12"]);
});
