// Flow 523 through the real `useAcpSession` hook, with keryx and the host faked over Tauri's IPC mocks: a
// Run from one session while another is shown, its exit, the one `session/prompt` that carries the
// result, and results that wait for a running turn. Run as its own process (terminalRunDelivery.dom.test.tsx).
// `no-results` as the first argument plays a keryx whose initialize lacks `_meta.keryx.terminalResults`.
import assert from "node:assert/strict";
import { registerDom, unregisterDom } from "./dom";

registerDom();
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { emit } = await import("@tauri-apps/api/event");
const { mockIPC, mockWindows, clearMocks } = await import("@tauri-apps/api/mocks");

type Json = Record<string, unknown>;
const takesResults = process.argv[2] !== "no-results";
const cwd = "/fixture/runs";
const prompts: Array<{ id: number; params: Json }> = [];
const opened: Json[] = [];
const tails = new Map<number, string>();
let nextTab = 1;
let nextSession = 1;
const inbound = (message: object) => emit("acp://message", JSON.stringify({ jsonrpc: "2.0", ...message }));
const reply = (id: number, result: object) => inbound({ id, result });

mockWindows("runs");
mockIPC(
  async (cmd, args) => {
    const a = (args ?? {}) as Json;
    if (cmd === "acp_start") return { keryxPath: "/fixture/keryx" };
    if (cmd === "version_check") return { ok: true };
    if (cmd === "pty_open_command") {
      opened.push({ cwd: a.cwd, command: a.command, title: a.title });
      return { id: nextTab++, title: a.title, owner: "user", cwd: a.cwd, running: true, exitCode: null };
    }
    if (cmd === "pty_tail") {
      assert.equal(a.lines, 200);
      return tails.get(Number(a.id)) ?? "";
    }
    if (cmd !== "acp_send") return null;
    const { method, params, id } = JSON.parse(String(a.message)) as { method?: string; params: Json; id?: number };
    if (method === "session/prompt" && id !== undefined) {
      prompts.push({ id, params }); // answered by the script below, as keryx would at the turn's end
      return null;
    }
    if (id !== undefined && method !== undefined) {
      const keryx = { profile: "shell", liveSessions: true, ...(takesResults ? { terminalResults: true } : {}) };
      const result =
        method === "initialize" ? { agentInfo: { version: "1.0.0" }, _meta: { keryx } }
        : method === "session/list" ? { sessions: [] }
        : method === "session/new" ? { sessionId: `s${nextSession++}` }
        : {};
      await reply(id, result);
    }
    return null;
  },
  { shouldMockEvents: true },
);

const { useAcpSession } = await import("../session/useAcpSession");
const bus = await import("../panels/panelBus");
const { ptyOpenCommand } = await import("../platform/panels");

let session!: ReturnType<typeof useAcpSession>;
function Workspace() {
  session = useAcpSession(cwd);
  return <output>{session.state.sessionId}</output>;
}
// The terminal panel's part (TerminalPanel.tsx, covered by RunButton.dom.test.tsx): a tab of its own per Run.
const offRuns = bus.onRunRequest((r) => {
  void ptyOpenCommand(cwd, r.command, bus.runTabTitle(r.command), 80, 24).then(
    (t) => bus.runOpened(r, t),
    (e: unknown) => bus.runFailed(r, String(e)),
  );
});

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const tick = () => React.act(async () => { await new Promise((r) => setTimeout(r, 10)); });
async function waitFor(check: () => boolean, what: string) {
  for (let i = 0; i < 200 && !check(); i++) await tick();
  assert.ok(check(), `timed out waiting for ${what}`);
}
const exit = (id: number, code: number) => React.act(async () => { await emit("panel://pty-exit", { id, code }); });
const cards = () => session.state.items.filter((i) => i.kind === "terminalRun") as Array<{ command: string; state: string; error?: string }>;
const resultsOf = (p: { params: Json }) => ((p.params._meta as { keryx: { terminalResults: Json[] } }).keryx.terminalResults);

try {
  await React.act(async () => root.render(<Workspace />));
  await waitFor(() => session.state.phase === "ready" && session.state.sessionId === "s1", "s1");
  await React.act(async () => { await session.newSession(); });
  await waitFor(() => session.state.sessionId === "s2", "s2 shown");

  // A Run clicked in s1's transcript while s2 is shown.
  await React.act(async () => bus.runInTerminal("bun test", { sessionId: "s1", source: "message" }));
  await waitFor(() => opened.length === 1, "the run tab");
  assert.deepEqual(opened[0], { cwd, command: "bun test", title: "bun test" });
  tails.set(1, "FAIL  2 tests\n");
  await exit(1, 3);

  if (!takesResults) {
    // AC8: this keryx cannot take results: nothing is sent, no turn starts, the card says so.
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(prompts.length, 0);
    assert.equal(session.marks.s1?.busy, false);
    await React.act(async () => { await session.loadSession("s1"); });
    await waitFor(() => session.state.sessionId === "s1", "s1 shown");
    assert.deepEqual(cards().map((c) => c.state), ["not-sent"]);
    assert.match(cards()[0]!.error ?? "", /does not take run results/);
  } else {
    // AC3: exactly one session/prompt to s1 with the six fields, and the follow-up turn runs on its own.
    await waitFor(() => prompts.length === 1, "the results prompt");
    const first = prompts[0]!;
    assert.equal(first.params.sessionId, "s1");
    assert.deepEqual(Object.keys(first.params).sort(), ["_meta", "prompt", "sessionId"]);
    assert.ok(Array.isArray(first.params.prompt));
    assert.deepEqual(Object.keys((first.params._meta as { keryx: Json }).keryx), ["terminalResults"]);
    const [entry] = resultsOf(first);
    assert.deepEqual(Object.keys(entry!).sort(), ["command", "durationMs", "exitCode", "output", "runId", "state"]);
    assert.equal(entry!.command, "bun test");
    assert.equal(entry!.state, "exited");
    assert.equal(entry!.exitCode, 3);
    assert.equal(entry!.output, "FAIL  2 tests");
    assert.ok(Number.isSafeInteger(entry!.durationMs) && (entry!.durationMs as number) >= 0);
    assert.match(String(entry!.runId), /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(session.state.sessionId, "s2");
    assert.equal(session.marks.s1?.busy, true);
    await inbound({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Two tests fail." } } } });
    await reply(first.id, { stopReason: "end_turn" });
    await waitFor(() => session.marks.s1?.busy === false, "the follow-up turn's end");

    // s1: the card sent, no user bubble, the agent's reply after it.
    await React.act(async () => { await session.loadSession("s1"); });
    await waitFor(() => session.state.sessionId === "s1" && session.state.items.length === 2, "s1 with the reply");
    assert.deepEqual(session.state.items.map((i) => i.kind), ["terminalRun", "agent"]);
    assert.deepEqual(cards().map((c) => c.state), ["sent"]);

    // AC4: two results that end while the user's turn runs go in ONE prompt when it ends.
    assert.equal(session.sendPrompt("Keep going", "s1"), true);
    await waitFor(() => prompts.length === 2, "the user's prompt");
    const userTurn = prompts[1]!;
    assert.equal(userTurn.params._meta, undefined);
    await React.act(async () => {
      bus.runInTerminal("make a", { sessionId: "s1", source: "tool" });
      bus.runInTerminal("make b", { sessionId: "s1", source: "message" });
    });
    await waitFor(() => opened.length === 3, "two run tabs");
    await exit(3, 0);
    await waitFor(() => cards().some((c) => c.command === "make b" && c.state === "waiting"), "make b waiting");
    await exit(2, 1);
    await waitFor(() => cards().some((c) => c.command === "make a" && c.state === "waiting"), "make a waiting");
    assert.equal(prompts.length, 2);
    await reply(userTurn.id, { stopReason: "end_turn" });
    await waitFor(() => prompts.length === 3, "the batched results prompt");
    assert.deepEqual(resultsOf(prompts[2]!).map((r) => [r.command, r.exitCode]), [["make b", 0], ["make a", 1]]);
    await reply(prompts[2]!.id, { stopReason: "end_turn" });
    await waitFor(() => !session.state.busy, "idle");
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(prompts.length, 3);
    assert.equal(session.state.items.filter((i) => i.kind === "user").length, 1); // "Keep going" only
  }
} finally {
  offRuns();
  await React.act(async () => root.unmount());
  clearMocks();
  await unregisterDom();
}
