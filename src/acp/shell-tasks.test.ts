// AC16 (specification §8): `_keryx/tasks/list|output|kill` and `_keryx/tasks/event` over the real
// pipe, against real short processes started through `shell_exec` (the registry the tool
// supervises is the one the requests read); private tasks hidden, driven through a real registry.

import { afterEach, expect, test } from "bun:test";
import { createJobRegistry, type BackgroundJobEvent } from "../harness/tool/builtin/background-job-registry";
import { KERYX_ACP_EXTENSION_METHODS as M } from "./profile";
import type { Frame } from "./server-harness.test-helpers";
import { createTasksHandlers, taskEventSink } from "./shell-tasks";
import { driveTurn, shellHarness, toolRound, type ShellHarness } from "./shell-profile.test-helpers";

const open: ShellHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.end();
});

async function call(h: ShellHarness, method: string, params: Record<string, unknown>): Promise<Frame> {
  const id = h.request(method, params);
  return h.waitFor((f) => f.id === id && f.method === undefined);
}

const taskEvents = (h: ShellHarness): { sessionId: string; event: Record<string, unknown> }[] =>
  h.frames.filter((f) => f.method === M.tasksEvent).map((f) => f.params as unknown as { sessionId: string; event: Record<string, unknown> });

/** A session whose model starts one background command, approved, and the task id it was given. */
async function startTask(command: string, description: string): Promise<{ h: ShellHarness; sessionId: string; taskId: string }> {
  const h = shellHarness({
    rounds: [
      toolRound("c1", "shell_exec", { command, background: true, description }),
      [{ kind: "text_delta", text: "started" }, { kind: "model_end" }],
    ],
  });
  open.push(h);
  await h.initialize();
  const { sessionId } = await h.newSession();
  await driveTurn(h, sessionId, "start it");
  const listed = (await call(h, M.tasksList, { sessionId })).result as { tasks: { jobId: string }[] };
  const taskId = listed.tasks[0]?.jobId;
  if (taskId === undefined) throw new Error("the task was not listed");
  return { h, sessionId, taskId };
}

test("list names the running task; start and phase are pushed, output chunks never are", async () => {
  const { h, sessionId, taskId } = await startTask("echo $((6*7))-out; sleep 30", "nap");
  const listed = (await call(h, M.tasksList, { sessionId })).result as { tasks: Record<string, unknown>[] };
  expect(listed.tasks).toHaveLength(1);
  expect(listed.tasks[0]).toMatchObject({
    jobId: taskId,
    command: "echo $((6*7))-out; sleep 30",
    status: "running",
    phase: "background",
    description: "nap",
  });
  expect(typeof listed.tasks[0]?.["startedAt"]).toBe("string");

  const events = taskEvents(h).filter((e) => e.event["jobId"] === taskId);
  expect(events.map((e) => e.event["type"])).toEqual(["start", "phase"]);
  expect(events.every((e) => e.sessionId === sessionId)).toBe(true);
  expect(events[0]?.event).toMatchObject({ type: "start", command: "echo $((6*7))-out; sleep 30", description: "nap" });
  // Output was produced ("42-out", which the command computes, so it is not in the command text); none of it was pushed.
  expect(taskEvents(h).some((e) => e.event["type"] === "output")).toBe(false);
  expect(JSON.stringify(h.frames.filter((f) => f.method === M.tasksEvent))).not.toContain("42-out");
});

test("output reads from an explicit cursor and never moves one for the next reader", async () => {
  const { h, sessionId, taskId } = await startTask("echo $((6*7))-out; sleep 30", "nap");
  const first = (await call(h, M.tasksOutput, { sessionId, taskId })).result as { output: string; nextCursor: number; missed: number; status: string };
  expect(first.output).toContain("42-out");
  expect(first.missed).toBe(0);
  expect(first.status).toBe("running");
  expect(first.nextCursor).toBeGreaterThan(0);
  // The same read again returns the same bytes: no shared cursor advanced.
  expect(((await call(h, M.tasksOutput, { sessionId, taskId, since: 0 })).result as { output: string }).output).toBe(first.output);
  const rest = (await call(h, M.tasksOutput, { sessionId, taskId, since: first.nextCursor })).result as { output: string; nextCursor: number };
  expect(rest.output).toBe("");
  expect(rest.nextCursor).toBe(first.nextCursor);
  const bad = await call(h, M.tasksOutput, { sessionId, taskId, since: -1 });
  expect(bad.error?.code).toBe(-32602);
});

test("kill stops the task as the operator, reports it, and the exit is pushed", async () => {
  const { h, sessionId, taskId } = await startTask("sleep 30", "nap");
  const reply = await call(h, M.tasksKill, { sessionId, taskId });
  expect(reply.result).toEqual({ status: "killed" });
  const exit = await h.waitFor((f) => f.method === M.tasksEvent && (f.params as unknown as { event: { type: string } }).event.type === "exit");
  expect((exit.params as unknown as { event: Record<string, unknown> }).event).toMatchObject({ type: "exit", jobId: taskId, status: "killed", killReason: "operator" });
  const listed = (await call(h, M.tasksList, { sessionId })).result as { tasks: { status: string; killReason?: string }[] };
  expect(listed.tasks[0]).toMatchObject({ status: "killed", killReason: "operator" });
  // Killing a task that is already over is not an error.
  expect((await call(h, M.tasksKill, { sessionId, taskId })).result).toEqual({ status: "killed" });
});

test("an unknown session is -32002 (the connection's own not-found), an unknown task -32602", async () => {
  const { h, sessionId, taskId } = await startTask("sleep 30", "nap");
  for (const method of [M.tasksList, M.tasksOutput, M.tasksKill]) {
    const reply = await call(h, method, { sessionId: "no-such-session", taskId });
    expect(reply.error?.code).toBe(-32002);
  }
  for (const method of [M.tasksOutput, M.tasksKill]) {
    const reply = await call(h, method, { sessionId, taskId: "no-such-task" });
    expect(reply.error?.code).toBe(-32602);
  }
  expect((await call(h, M.tasksList, {})).error?.code).toBe(-32602);
});

test("the editor profile does not serve them, and a request before initialize is refused", async () => {
  const editor = shellHarness({ profile: "editor" });
  open.push(editor);
  await editor.initialize();
  expect((await call(editor, M.tasksList, { sessionId: "x" })).error?.code).toBe(-32601);
  const early = shellHarness();
  open.push(early);
  expect((await call(early, M.tasksList, { sessionId: "x" })).error?.code).toBe(-32600);
});

test("a private task is never pushed, listed, read or killed: it answers as an unknown one", async () => {
  const sent: { method: string; params: unknown }[] = [];
  const registry = createJobRegistry({
    cwd: process.cwd(),
    onEvent: taskEventSink("s1", () => registry, (method, params) => sent.push({ method, params })),
  });
  const handlers = createTasksHandlers({ requireInitialized: () => {}, jobsOf: (id) => (id === "s1" ? registry : undefined) }).requests;
  try {
    const hidden = await registry.start("sleep 30", { visibility: "private", description: "checkpoint" });
    const shown = await registry.start("sleep 30", { description: "visible" });
    if (!hidden.ok || !shown.ok) throw new Error("could not start the tasks");

    const listed = (await handlers[M.tasksList]?.({ sessionId: "s1" })) as { tasks: { jobId: string }[] };
    expect(listed.tasks.map((t) => t.jobId)).toEqual([shown.jobId]);
    // The private task's start and phase never left; the visible one's did.
    const pushed = sent.map((s) => (s.params as { event: BackgroundJobEvent }).event.jobId);
    expect(pushed).not.toContain(hidden.jobId);
    expect(pushed).toContain(shown.jobId);
    for (const method of [M.tasksOutput, M.tasksKill]) {
      await expect(handlers[method]?.({ sessionId: "s1", taskId: hidden.jobId })).rejects.toMatchObject({ code: -32602 });
    }
    // Still running: the refused kill touched nothing.
    expect(registry.get(hidden.jobId, { includePrivate: true })?.status).toBe("running");
    sent.length = 0;
    await registry.kill(hidden.jobId, "operator", { includePrivate: true });
    expect(sent).toEqual([]);
  } finally {
    await registry.sweepAll();
  }
});

test("a view command answers with its structured view in _meta.keryx.view", async () => {
  const h = shellHarness();
  open.push(h);
  await h.initialize();
  const { sessionId } = await h.newSession();
  const reply = await call(h, M.command, { sessionId, name: "schedules" });
  const view = (reply.result as { _meta: { keryx: { view?: { title: string } } } })._meta.keryx.view;
  expect(typeof view?.title).toBe("string");
});
