// Flow 523 through the real `useAcpSession` hook, with keryx and the host faked over Tauri's IPC mocks. Run
// as its own process (terminalRunDelivery.dom.test.tsx); the first argument picks the scenario:
//   (none)       a Run from one session while another is shown, its exit, the one `session/prompt` that
//                carries the result, and results that wait for a running turn;
//   no-results   a keryx whose initialize lacks `_meta.keryx.terminalResults`;
//   refusals     how keryx's answers to a results prompt land: busy, invalid params, a failed turn, a tab
//                closed before the end, a command in flight, a queued prompt, a released session, a keryx
//                shutting down, and a reconnect to a keryx without terminalResults.
// Nothing waits on the wall clock: `settle` yields to the event loop with no delay and every wait is for a
// state; the store's busy retry runs on the test's own clock (`useTestClock`).
import assert from "node:assert/strict";
import { registerDom, unregisterDom } from "./dom";

registerDom();
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { emit } = await import("@tauri-apps/api/event");
const { mockIPC, mockWindows, clearMocks } = await import("@tauri-apps/api/mocks");

type Json = Record<string, unknown>;
type Scenario = "delivery" | "no-results" | "refusals";
const scenario: Scenario = process.argv[2] === "no-results" ? "no-results" : process.argv[2] === "refusals" ? "refusals" : "delivery";
const cwd = "/fixture/runs";
const prompts: Array<{ id: number; params: Json }> = [];
const initializes: Json[] = [];
/** `_keryx/command` requests, answered by the script. */
const commandsHeld: Array<{ id: number; params: Json }> = [];
const opened: Array<{ id: number; cwd: unknown; command: unknown; title: unknown }> = [];
const tails = new Map<number, string>();
let nextTab = 1;
let nextSession = 1;
/** What the next `initialize` says: whether keryx takes Run results, and whether the script answers it itself. */
let takesResultsNow = scenario !== "no-results";
let holdInitialize = false;
let heldInitialize: number | null = null;
const inbound = (message: object) => emit("acp://message", JSON.stringify({ jsonrpc: "2.0", ...message }));
const reply = (id: number, result: object) => inbound({ id, result });
const refuse = (id: number, error: { code: number; message: string; data?: Json }) => inbound({ id, error });
const initializeResult = () => ({
  agentInfo: { version: "1.0.0" },
  _meta: {
    keryx: {
      profile: "shell",
      liveSessions: true,
      ...(takesResultsNow ? { terminalResults: true } : {}),
      ...(scenario === "refusals" ? { extensions: ["_keryx/command"] } : {}),
    },
  },
});

mockWindows("runs");
mockIPC(
  async (cmd, args) => {
    const a = (args ?? {}) as Json;
    if (cmd === "acp_start") return { keryxPath: "/fixture/keryx" };
    if (cmd === "version_check") return { ok: true };
    if (cmd === "pty_open_command") {
      const id = nextTab++;
      opened.push({ id, cwd: a.cwd, command: a.command, title: a.title });
      return { id, title: a.title, owner: "user", cwd: a.cwd, running: true, exitCode: null };
    }
    if (cmd === "pty_tail") {
      // One line more than a result keeps: a full tail shows that earlier output was cut.
      assert.equal(a.lines, 201);
      return tails.get(Number(a.id)) ?? "";
    }
    if (cmd !== "acp_send") return null;
    const { method, params, id } = JSON.parse(String(a.message)) as { method?: string; params: Json; id?: number };
    if (id === undefined || method === undefined) return null;
    // Answered by the script below, as keryx would at the turn's (or the command's) end.
    if (method === "session/prompt") {
      prompts.push({ id, params });
      return null;
    }
    if (method === "_keryx/command") {
      commandsHeld.push({ id, params });
      return null;
    }
    if (method === "initialize") {
      initializes.push(params);
      if (holdInitialize) {
        heldInitialize = id;
        return null;
      }
    }
    const result =
      method === "initialize" ? initializeResult()
      : method === "session/list" ? { sessions: [] }
      : method === "session/new" ? { sessionId: `s${nextSession++}` }
      : {};
    await reply(id, result);
    return null;
  },
  { shouldMockEvents: true },
);

const { useAcpSession } = await import("../session/useAcpSession");
const { BUSY_RETRY_MS } = await import("../session/terminalRuns");
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
/** One turn of the event loop with no delay: what is already due (IPC replies, frames, effects) runs. */
const settle = () => React.act(async () => { await new Promise<void>((r) => setTimeout(r, 0)); });
async function waitFor(check: () => boolean, what: string) {
  for (let i = 0; i < 500 && !check(); i++) await settle();
  assert.ok(check(), `never reached: ${what}`);
}
const exit = (id: number, code: number) => React.act(async () => { await emit("panel://pty-exit", { id, code }); });
type Card = { command: string; state: string; error?: string };
const cards = () => session.state.items.filter((i) => i.kind === "terminalRun") as Card[];
const card = (command: string): Card | undefined => cards().find((c) => c.command === command);
const resultsOf = (p: { params: Json }) => ((p.params._meta as { keryx: { terminalResults: Json[] } }).keryx.terminalResults);
const commandsOf = (p: { params: Json }) => resultsOf(p).map((r) => r.command);
const textOf = (p: { params: Json }) => (p.params.prompt as Array<{ text?: unknown }>)[0]?.text;
/** A Run from s1's transcript; resolves the tab the panel opened for it. */
async function run(command: string): Promise<number> {
  const before = opened.length;
  await React.act(async () => bus.runInTerminal(command, { sessionId: "s1" }));
  await waitFor(() => opened.length === before + 1, `the tab of ${command}`);
  return opened[before]!.id;
}
const idle = (what: string) => waitFor(() => !session.state.busy, what);

/** Timers of BUSY_RETRY_MS or longer (the store's busy retry) are held here and fired by the test on its own clock. */
const heldTimers: Array<{ fire: () => void; ms: number }> = [];
let clockOffset = 0;
function useTestClock(): void {
  const realNow = Date.now.bind(Date);
  Date.now = () => realNow() + clockOffset;
  const realSetTimeout = window.setTimeout.bind(window);
  const held = (handler: TimerHandler, ms?: number, ...args: unknown[]): number => {
    if (typeof handler !== "function" || (ms ?? 0) < BUSY_RETRY_MS) return realSetTimeout(handler, ms, ...args);
    heldTimers.push({ fire: () => void Reflect.apply(handler, undefined, args), ms: ms ?? 0 });
    return 0;
  };
  Object.defineProperty(window, "setTimeout", { value: held, configurable: true, writable: true });
}
async function fireHeldTimers(): Promise<void> {
  for (const timer of heldTimers.splice(0)) {
    clockOffset += timer.ms;
    await React.act(async () => timer.fire());
  }
}

async function delivery(): Promise<void> {
  await React.act(async () => { await session.newSession(); });
  await waitFor(() => session.state.sessionId === "s2", "s2 shown");

  // A Run clicked in s1's transcript while s2 is shown.
  const tab = await run("bun test");
  assert.deepEqual(opened[0], { id: tab, cwd, command: "bun test", title: "bun test" });
  tails.set(tab, "FAIL  2 tests\n");
  await exit(tab, 3);

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
  const a = await run("make a");
  const b = await run("make b");
  await exit(b, 0);
  await waitFor(() => card("make b")?.state === "waiting", "make b waiting");
  await exit(a, 1);
  await waitFor(() => card("make a")?.state === "waiting", "make a waiting");
  assert.equal(prompts.length, 2);
  await reply(userTurn.id, { stopReason: "end_turn" });
  await waitFor(() => prompts.length === 3, "the batched results prompt");
  assert.deepEqual(resultsOf(prompts[2]!).map((r) => [r.command, r.exitCode]), [["make b", 0], ["make a", 1]]);
  await reply(prompts[2]!.id, { stopReason: "end_turn" });
  await idle("idle");
  // Nothing more can go: only a waiting result is ever sent, and none waits.
  assert.deepEqual(cards().map((c) => c.state), ["sent", "sent", "sent"]);
  assert.equal(prompts.length, 3);
  assert.equal(session.state.items.filter((i) => i.kind === "user").length, 1); // "Keep going" only
}

async function noResults(): Promise<void> {
  // AC8: this keryx cannot take results: nothing is sent, no turn starts, the card says so.
  await React.act(async () => { await session.newSession(); });
  await waitFor(() => session.state.sessionId === "s2", "s2 shown");
  const tab = await run("bun test");
  tails.set(tab, "FAIL  2 tests\n");
  await React.act(async () => { await session.loadSession("s1"); });
  await exit(tab, 3);
  // The card turns not-sent in the same step that would otherwise have sent it.
  await waitFor(() => session.state.sessionId === "s1" && card("bun test")?.state === "not-sent", "the not-sent card");
  assert.equal(prompts.length, 0);
  assert.equal(session.marks.s1?.busy, false);
  assert.match(card("bun test")!.error ?? "", /does not take run results/);
}

async function refusals(): Promise<void> {
  useTestClock();
  const ui = { focusSessions() {}, mode() {}, model() {}, openProviders() {}, fillComposer() {} };
  await inbound({ method: "session/update", params: { sessionId: "s1", update: {
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "compact", description: "Compact the history", _meta: { keryx: { surface: "text", busy: "refuse" } } }],
  } } });
  await waitFor(() => session.state.commands.some((c) => c.name === "compact"), "the compact command");

  // TP-003: a busy refusal puts the result back to waiting; the re-ask after the pause delivers it.
  await exit(await run("echo a"), 0);
  await waitFor(() => prompts.length === 1, "a's prompt");
  await refuse(prompts[0]!.id, { code: -32600, message: "session/prompt: session s1 is running a turn", data: { condition: "session-busy" } });
  await waitFor(() => card("echo a")?.state === "waiting" && !session.state.busy, "a waiting after the busy refusal");
  assert.equal(prompts.length, 1);
  assert.equal(heldTimers.length, 1);
  await fireHeldTimers();
  await waitFor(() => prompts.length === 2, "a asked again after the pause");
  assert.deepEqual(commandsOf(prompts[1]!), ["echo a"]);
  await reply(prompts[1]!.id, { stopReason: "end_turn" });
  await waitFor(() => card("echo a")?.state === "sent" && !session.state.busy, "a delivered");

  // TP-003: invalid params are final: the card says keryx's reason, and it is never sent again.
  await exit(await run("echo b"), 0);
  await waitFor(() => prompts.length === 3, "b's prompt");
  await refuse(prompts[2]!.id, { code: -32602, message: "terminalResults[0].runId repeats an earlier result's runId" });
  await waitFor(() => card("echo b")?.state === "not-sent" && !session.state.busy, "b not sent");
  assert.match(card("echo b")!.error ?? "", /runId repeats/);

  // TP-003: a turn that failed after keryx stored the result: the card stays sent, the failure is a notice.
  await exit(await run("echo c"), 0);
  await waitFor(() => prompts.length === 4, "c's prompt");
  await refuse(prompts[3]!.id, { code: -32603, message: "the model failed" });
  await waitFor(() => session.state.items.some((i) => i.kind === "notice" && i.text === "the model failed"), "the failure notice");
  assert.equal(card("echo c")!.state, "sent");
  await idle("idle after c");

  // TP-003 / AC8: the tab closed before the command ends: closed, and its hang-up sends nothing. The next
  // run's exit is handled after the hang-up, so its prompt shows the hang-up added nothing.
  const d = await run("sleep 60");
  await React.act(async () => bus.notifyTabClosed(d));
  assert.equal(card("sleep 60")!.state, "closed");
  await exit(d, 1);
  await exit(await run("echo e"), 0);
  await waitFor(() => prompts.length === 5, "e's prompt");
  assert.deepEqual(commandsOf(prompts[4]!), ["echo e"]);
  await reply(prompts[4]!.id, { stopReason: "end_turn" });
  await idle("idle after e");

  // FE-W1-003: a result that ends while a command runs in the session (keryx holds its turn slot for
  // /compact) waits for the command, and goes when it ends.
  let compacting: Promise<boolean> = Promise.resolve(false);
  await React.act(async () => { compacting = session.runCommand("/compact", ui); });
  await waitFor(() => commandsHeld.length === 1, "the /compact request");
  await exit(await run("echo f"), 0);
  await waitFor(() => card("echo f")?.state === "waiting", "f waiting for the command");
  assert.equal(prompts.length, 5);
  await React.act(async () => {
    await reply(commandsHeld[0]!.id, { text: "Compacted." });
    await compacting;
  });
  await waitFor(() => prompts.length === 6, "f sent once the command ended");
  assert.deepEqual(commandsOf(prompts[5]!), ["echo f"]);
  await reply(prompts[5]!.id, { stopReason: "end_turn" });
  await idle("idle after f");

  // AR-002: a prompt queued while a result waits: when the turn ends the results prompt goes first, the
  // queued prompt after that turn.
  assert.equal(session.sendPrompt("Turn one", "s1"), true);
  await waitFor(() => prompts.length === 7, "the user's turn");
  await React.act(async () => { await session.runCommand("Queued follow-up", ui); });
  await waitFor(() => session.state.queue.length === 1, "the queued prompt");
  await exit(await run("echo g"), 0);
  await waitFor(() => card("echo g")?.state === "waiting", "g waiting for the turn");
  await reply(prompts[6]!.id, { stopReason: "end_turn" });
  await waitFor(() => prompts.length === 8, "the prompt after the turn");
  assert.deepEqual(commandsOf(prompts[7]!), ["echo g"]);
  assert.equal(session.state.queue.length, 1);
  await reply(prompts[7]!.id, { stopReason: "end_turn" });
  await waitFor(() => prompts.length === 9, "the queued prompt");
  assert.equal(textOf(prompts[8]!), "Queued follow-up");
  await reply(prompts[8]!.id, { stopReason: "end_turn" });
  await waitFor(() => !session.state.busy && session.state.queue.length === 0, "idle after the queue");

  // HL2-001: keryx's idle cap releases s1 while its results prompt is on the wire, then answers "unknown
  // session": the result waits, and goes once s1 is held again.
  await exit(await run("echo h"), 0);
  await waitFor(() => prompts.length === 10, "h's prompt");
  const h = resultsOf(prompts[9]!)[0]!.runId;
  await inbound({ method: "_keryx/session_released", params: { sessionId: "s1" } });
  await refuse(prompts[9]!.id, { code: -32002, message: "Unknown ACP session: s1", data: { sessionId: "s1" } });
  await waitFor(() => card("echo h")?.state === "waiting" && !session.state.held, "h waiting while s1 is released");
  assert.equal(prompts.length, 10);
  await React.act(async () => { await session.loadSession("s1"); });
  await waitFor(() => prompts.length === 11, "h sent once s1 is held again");
  assert.deepEqual(resultsOf(prompts[10]!).map((r) => r.runId), [h]);
  await reply(prompts[10]!.id, { stopReason: "end_turn" });
  await idle("idle after h");

  // HL2-001: keryx shutting down: the result waits, is not asked again on the window's next change, and
  // goes to the next keryx once it holds the session.
  await exit(await run("echo i"), 0);
  await waitFor(() => prompts.length === 12, "i's prompt");
  await refuse(prompts[11]!.id, { code: -32600, message: "session/prompt: keryx acp is shutting down", data: { method: "session/prompt", condition: "shutting-down" } });
  await waitFor(() => card("echo i")?.state === "waiting" && !session.state.busy, "i waiting for the next keryx");
  await React.act(async () => session.notify("info", "the window changed"));
  assert.equal(prompts.length, 12);
  assert.equal(heldTimers.length, 0);
  await React.act(async () => session.restart());
  await waitFor(() => prompts.length === 13, "i sent to the restarted keryx");
  assert.deepEqual(commandsOf(prompts[12]!), ["echo i"]);
  await reply(prompts[12]!.id, { stopReason: "end_turn" });
  await idle("idle after i");

  // TP-003: a result that ends while keryx restarts waits for its initialize; a keryx without
  // terminalResults gets nothing, and the card says so.
  takesResultsNow = false;
  holdInitialize = true;
  await React.act(async () => session.restart());
  await waitFor(() => heldInitialize !== null, "the held initialize");
  await exit(await run("echo j"), 0);
  await waitFor(() => card("echo j")?.state === "waiting", "j waiting for initialize");
  holdInitialize = false;
  await reply(heldInitialize!, initializeResult());
  await waitFor(() => card("echo j")?.state === "not-sent", "j not sent to a keryx without terminalResults");
  assert.match(card("echo j")!.error ?? "", /does not take run results/);
  assert.equal(prompts.length, 13);
}

try {
  await React.act(async () => root.render(<Workspace />));
  await waitFor(() => session.state.phase === "ready" && session.state.sessionId === "s1", "s1");
  // RR-001: this client says it returns Run results, next to the terminal it runs /delegate in.
  const keryx = (initializes[0]?.clientCapabilities as { _meta?: { keryx?: Json } } | undefined)?._meta?.keryx;
  assert.equal(keryx?.terminal, true);
  assert.equal(keryx?.terminalResults, true);
  if (scenario === "delivery") await delivery();
  else if (scenario === "no-results") await noResults();
  else await refusals();
} finally {
  offRuns();
  await React.act(async () => root.unmount());
  clearMocks();
  await unregisterDom();
}
