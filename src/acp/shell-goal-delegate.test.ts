// `/goal` and `/delegate` over `keryx acp --profile shell` (specification §3.9.5a):
// `/goal` answers the turn text for the client to send (effect `startTurn`) and is refused while a
// turn runs; `/delegate` asks for approval as `session/request_permission`, streams the run as
// `_keryx/subagent` events with `runtime: "external"`, and stops on `session/cancel`.

import { afterEach, expect, test } from "bun:test";
import { canonicalExternalAgentId } from "../harness/external/registry";
import type { ExternalRunHandle } from "../harness/external/supervise";
import type { CreateRunExternalOptions, RunExternalFn } from "../harness/run-external-factory";
import { ACP_AGENT_METHODS, ACP_CLIENT_METHODS } from "./protocol";
import { KERYX_ACP_EXTENSION_METHODS as M } from "./profile";
import type { Frame } from "./server-harness.test-helpers";
import { shellHarness, toolRound, type ShellHarness } from "./shell-profile.test-helpers";

const TIMEOUT_MS = 30_000;
const open: ShellHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.end();
});

type KeryxMeta = { effects?: string[]; refused?: boolean; prompt?: string };
async function command(h: ShellHarness, sessionId: string, name: string, args: string): Promise<{ text: string; meta: KeryxMeta; id: number }> {
  const id = h.request(M.command, { sessionId, name, args });
  const reply = await h.waitFor((f) => f.id === id);
  if (reply.result === undefined) throw new Error(`${name}: ${JSON.stringify(reply.error)}`);
  return { text: reply.result["text"] as string, meta: ((reply.result["_meta"] as { keryx?: KeryxMeta } | undefined)?.keryx ?? {}) as KeryxMeta, id };
}

test("/goal answers the exact turn text with the startTurn effect, and the goal's own slate is opened", async () => {
  const h = shellHarness();
  open.push(h);
  await h.initialize();
  const { sessionId } = await h.newSession();
  const reply = await command(h, sessionId, "goal", "  make the build green  ");
  expect(reply.meta.refused).toBeUndefined();
  expect(reply.meta.effects).toEqual(["startTurn"]);
  expect(reply.meta.prompt).toBe("make the build green");
  // The command itself is not a turn: no prompt response, no user message update.
  expect(h.frames.some((f) => f.method === ACP_CLIENT_METHODS.sessionUpdate && JSON.stringify(f.params).includes("user_message"))).toBe(false);
}, TIMEOUT_MS);

test("/goal without text, with --auto, or with a rejected --workspace is refused and starts no turn", async () => {
  const h = shellHarness();
  open.push(h);
  await h.initialize();
  const { sessionId } = await h.newSession();
  for (const args of ["", "ship it --auto", "ship it --workspace no-such-workspace"]) {
    const reply = await command(h, sessionId, "goal", args);
    expect(reply.meta.refused).toBe(true);
    expect(reply.meta.effects).toBeUndefined();
    expect(reply.meta.prompt).toBeUndefined();
  }
}, TIMEOUT_MS);

test("/goal is refused while a turn runs, with the shell's own wording", async () => {
  const h = shellHarness({ rounds: [toolRound("s1", "shell_exec", { command: "echo hi" })] });
  open.push(h);
  await h.initialize();
  const { sessionId } = await h.newSession();
  const promptId = h.prompt(sessionId, "run something");
  const ask = await h.waitFor((f) => f.method === ACP_CLIENT_METHODS.sessionRequestPermission);
  const reply = await command(h, sessionId, "goal", "ship it");
  expect(reply.meta.refused).toBe(true);
  expect(reply.text).toBe("main is busy: command deferred");
  expect(reply.meta.prompt).toBeUndefined();
  h.respond(ask.id, { result: { outcome: { outcome: "selected", optionId: "reject_once" } } });
  await h.waitFor((f) => f.id === promptId && f.method === undefined);
}, TIMEOUT_MS);

interface FakeRun {
  readonly requests: Parameters<RunExternalFn>[0][];
  readonly killed: { count: number };
}

/** A run port whose run emits two events, then waits for `release()` or a kill. */
function fakeRunPort(): { make: (options: CreateRunExternalOptions) => RunExternalFn; run: FakeRun; release: () => void } {
  const run: FakeRun = { requests: [], killed: { count: 0 } };
  let release: () => void = () => undefined;
  const make = (options: CreateRunExternalOptions): RunExternalFn => async (request) => {
    run.requests.push(request);
    const id = request.workerId;
    const handle: ExternalRunHandle = {
      streaming: false,
      writeStdin: () => false,
      kill: () => {
        run.killed.count += 1;
        release();
      },
    };
    options.observer?.onSpawned?.(id, handle);
    options.observer?.onEvent?.(id, { kind: "child_started" });
    options.observer?.onEvent?.(id, { kind: "tool_call", name: "read_file", detail: "a.ts" });
    options.observer?.onEvent?.(id, { kind: "assistant_text", text: "looked at a.ts" });
    await new Promise<void>((resolve) => {
      release = resolve;
      if (request.task.includes("instant")) resolve();
    });
    return run.killed.count > 0
      ? { status: "Error", output: "killed", isError: true }
      : { status: "Completed", output: "found 3 issues", isError: false };
  };
  return { make, run, release: () => release() };
}

type Fleet = { sessionId: string; event: { kind: string; id: string; status?: string; runtime?: string; parentToolCallId?: string; detail?: string; entry?: { kind: string; text: string } } };
const fleet = (h: ShellHarness): Fleet[] => h.frames.filter((f) => f.method === M.subagent).map((f) => f.params as unknown as Fleet);
const asks = (h: ShellHarness): Frame[] => h.frames.filter((f) => f.method === ACP_CLIENT_METHODS.sessionRequestPermission);

test("/delegate asks to run (execute, allow once or reject once only), then streams the run as external subagent events and reports", async () => {
  const port = fakeRunPort();
  const h = shellHarness({ serverOptions: { makeRunExternal: port.make } });
  open.push(h);
  await h.initialize();
  const { sessionId } = await h.newSession();
  const commandId = h.request(M.command, { sessionId, name: "delegate", args: "claude audit the parser" });

  const ask = await h.waitFor((f) => f.method === ACP_CLIENT_METHODS.sessionRequestPermission);
  const params = ask.params as unknown as {
    sessionId: string;
    toolCall: { kind: string; rawInput: { agent: string; task: string } };
    options: { kind: string }[];
  };
  expect(params.sessionId).toBe(sessionId);
  expect(params.toolCall.kind).toBe("execute");
  expect(params.toolCall.rawInput).toMatchObject({ agent: canonicalExternalAgentId("claude"), task: "audit the parser" });
  expect(params.options.map((option) => option.kind)).toEqual(["allow_once", "reject_once"]);
  // Nothing runs before the answer.
  expect(port.run.requests).toHaveLength(0);

  h.respond(ask.id, { result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
  await h.waitFor((f) => f.method === M.subagent && (f.params as unknown as Fleet).event.kind === "log");
  port.release();
  const reply = await h.waitFor((f) => f.id === commandId);
  const result = reply.result as { text: string; _meta: { keryx: KeryxMeta } };
  expect(result._meta.keryx.refused).toBeUndefined();
  expect(result.text).toContain("Completed: found 3 issues");

  expect(port.run.requests).toHaveLength(1);
  expect(port.run.requests[0]).toMatchObject({ task: "audit the parser", mode: "read_only" });
  const events = fleet(h);
  expect(events.every((e) => e.sessionId === sessionId && e.event.parentToolCallId === undefined)).toBe(true);
  const upserts = events.filter((e) => e.event.kind === "upsert");
  expect(upserts.every((e) => e.event.runtime === "external")).toBe(true);
  expect(upserts[0]?.event.status).toBe("running");
  expect(upserts.at(-1)?.event.status).toBe("done");
  const logs = events.filter((e) => e.event.kind === "log").map((e) => e.event.entry);
  expect(logs.some((entry) => entry?.kind === "tool" && entry.text === "read_file: a.ts")).toBe(true);
  expect(logs.some((entry) => entry?.kind === "text" && entry.text === "looked at a.ts")).toBe(true);
}, TIMEOUT_MS);

test("/delegate rejected is refused and nothing runs; a bad usage line is refused without asking", async () => {
  const port = fakeRunPort();
  const h = shellHarness({ serverOptions: { makeRunExternal: port.make } });
  open.push(h);
  await h.initialize();
  const { sessionId } = await h.newSession();

  const usage = await command(h, sessionId, "delegate", "claude");
  expect(usage.meta.refused).toBe(true);
  expect(usage.text).toContain("needs both an agent and a task");
  expect(asks(h)).toHaveLength(0);

  const commandId = h.request(M.command, { sessionId, name: "delegate", args: "claude audit the parser" });
  const ask = await h.waitFor((f) => f.method === ACP_CLIENT_METHODS.sessionRequestPermission);
  h.respond(ask.id, { result: { outcome: { outcome: "selected", optionId: "reject_once" } } });
  const reply = await h.waitFor((f) => f.id === commandId);
  const result = reply.result as { text: string; _meta: { keryx: KeryxMeta } };
  expect(result._meta.keryx.refused).toBe(true);
  expect(result.text).toContain("was not approved");
  expect(port.run.requests).toHaveLength(0);
  expect(fleet(h)).toHaveLength(0);
}, TIMEOUT_MS);

test("session/cancel stops a running /delegate, and withdraws one still waiting for approval", async () => {
  const port = fakeRunPort();
  const h = shellHarness({ serverOptions: { makeRunExternal: port.make } });
  open.push(h);
  await h.initialize();
  const { sessionId } = await h.newSession();

  // Running: cancel kills the child, and the command answers.
  const runningId = h.request(M.command, { sessionId, name: "delegate", args: "claude audit the parser" });
  const ask = await h.waitFor((f) => f.method === ACP_CLIENT_METHODS.sessionRequestPermission);
  h.respond(ask.id, { result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
  await h.waitFor((f) => f.method === M.subagent && (f.params as unknown as Fleet).event.kind === "log");
  h.notify(ACP_AGENT_METHODS.sessionCancel, { sessionId });
  const reply = await h.waitFor((f) => f.id === runningId);
  expect(port.run.killed.count).toBe(1);
  expect((reply.result as { text: string }).text).toContain("stopped");
  expect(fleet(h).filter((e) => e.event.kind === "upsert").at(-1)?.event.status).toBe("failed");

  // Waiting for approval: cancel answers the command without ever running anything.
  const before = port.run.requests.length;
  const waitingId = h.request(M.command, { sessionId, name: "delegate", args: "claude second task" });
  await h.waitFor((f) => f.method === ACP_CLIENT_METHODS.sessionRequestPermission && f.id !== ask.id);
  h.notify(ACP_AGENT_METHODS.sessionCancel, { sessionId });
  const second = await h.waitFor((f) => f.id === waitingId);
  expect((second.result as { _meta: { keryx: KeryxMeta } })._meta.keryx.refused).toBe(true);
  expect(port.run.requests).toHaveLength(before);
}, TIMEOUT_MS);
