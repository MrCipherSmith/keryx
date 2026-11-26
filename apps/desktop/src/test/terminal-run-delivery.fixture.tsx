// Flow 523 through the real `useAcpSession` hook, with keryx and the host faked over Tauri's IPC mocks. Run
// as its own process (terminalRunDelivery.dom.test.tsx); the first argument picks the scenario:
//   (none)          a Run from one session while another is shown, its exit, the one `session/prompt` that
//                   carries the result, and results that wait for a running turn;
//   no-results      a keryx whose initialize lacks `_meta.keryx.terminalResults`;
//   refusals        how keryx's answers to a results prompt land: busy, invalid params, a failed turn,
//                   "unknown session" for a held session, a tab closed before the end, a Telegram turn, a
//                   command in flight (with and without a replay after it), a queued prompt, a released
//                   session, a keryx shutting down, and a reconnect to a keryx without terminalResults;
//   load-order      who takes the turn slot once a load holds a session again: resumed issue questions (sent at
//                   once, or queued behind a Telegram turn) and a review sent as the load resolves go before the
//                   results that waited for it;
//   lost-connection a results prompt with no answer when keryx exits or is restarted: sent again to the next
//                   keryx, which answers success for runs it had already stored. Its replay of the stored note
//                   leaves the card before the reply that followed it (no turn runs), or, when the note ends the
//                   history, before the reply of the turn keryx resumes for it.
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
const SCENARIOS = ["delivery", "no-results", "refusals", "load-order", "lost-connection"] as const;
type Scenario = (typeof SCENARIOS)[number];
// No argument is `delivery`; a name this fixture does not know fails instead of running `delivery` in its place.
const requested = process.argv[2];
const scenario: Scenario = requested === undefined ? "delivery" : (SCENARIOS.find((s) => s === requested) ?? assert.fail(`unknown scenario ${requested}`));
const cwd = "/fixture/runs";
const prompts: Array<{ id: number; params: Json }> = [];
const initializes: Json[] = [];
/** `_keryx/command` requests, answered by the script. */
const commandsHeld: Array<{ id: number; params: Json }> = [];
/** `session/load` requests; answered with `loadAnswer` at once, or by the script while `holdLoads` is set. */
const loads: Array<{ id: number; params: Json }> = [];
let holdLoads = false;
let loadAnswer: Json = {};
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
      ...(scenario === "refusals" || scenario === "load-order" ? { extensions: ["_keryx/command"] } : {}),
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
      return { text: tails.get(Number(a.id)) ?? "", truncated: false };
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
    if (method === "session/load") {
      loads.push({ id, params });
      if (!holdLoads) await reply(id, loadAnswer);
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
/** Prompts the script has taken: `next` takes the one after them, `none` says no other came. */
let seen = 0;
async function next(what: string): Promise<{ id: number; params: Json }> {
  await waitFor(() => prompts.length > seen, what);
  return prompts[seen++]!;
}
function none(): void {
  assert.equal(prompts.length, seen, `no further session/prompt (got ${prompts.length - seen} more)`);
}
const unknownSession = { code: -32002, message: "Unknown ACP session: s1", data: { sessionId: "s1" } };
/** keryx's idle cap releases s1 while `prompt` (a results prompt) is on the wire, then answers "unknown session". */
async function releaseUnder(prompt: { id: number }): Promise<void> {
  await inbound({ method: "_keryx/session_released", params: { sessionId: "s1" } });
  await refuse(prompt.id, unknownSession);
}

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
  const a = await next("a's prompt");
  await refuse(a.id, { code: -32600, message: "session/prompt: session s1 is running a turn", data: { condition: "session-busy" } });
  await waitFor(() => card("echo a")?.state === "waiting" && !session.state.busy, "a waiting after the busy refusal");
  none();
  assert.equal(heldTimers.length, 1);
  await fireHeldTimers();
  const aAgain = await next("a asked again after the pause");
  assert.deepEqual(commandsOf(aAgain), ["echo a"]);
  await reply(aAgain.id, { stopReason: "end_turn" });
  await waitFor(() => card("echo a")?.state === "sent" && !session.state.busy, "a delivered");

  // TP-003: invalid params are final: the card says keryx's reason, and it is never sent again.
  await exit(await run("echo b"), 0);
  const b = await next("b's prompt");
  await refuse(b.id, { code: -32602, message: "terminalResults[0].runId repeats an earlier result's runId" });
  await waitFor(() => card("echo b")?.state === "not-sent" && !session.state.busy, "b not sent");
  assert.match(card("echo b")!.error ?? "", /runId repeats/);

  // TP-003: a turn that failed after keryx stored the result: the card stays sent, the failure is a notice.
  await exit(await run("echo c"), 0);
  const c = await next("c's prompt");
  await refuse(c.id, { code: -32603, message: "the model failed" });
  await waitFor(() => session.state.items.some((i) => i.kind === "notice" && i.text === "the model failed"), "the failure notice");
  assert.equal(card("echo c")!.state, "sent");
  await idle("idle after c");

  // R2-TP-001: "unknown session" for a session the window still holds (no release came first) is final:
  // the card says keryx's reason, and a later turn's end does not send it again.
  await exit(await run("echo u"), 0);
  const u = await next("u's prompt");
  await refuse(u.id, unknownSession);
  await waitFor(() => card("echo u")?.state === "not-sent" && !session.state.busy, "u not sent");
  assert.match(card("echo u")!.error ?? "", /Unknown ACP session/);
  assert.equal(session.sendPrompt("After u", "s1"), true);
  const afterU = await next("the user's turn after u");
  assert.equal(textOf(afterU), "After u");
  await reply(afterU.id, { stopReason: "end_turn" });
  await idle("idle after the turn after u");
  none();

  // TP-003 / AC8: the tab closed before the command ends: closed, and its hang-up sends nothing. The next
  // run's exit is handled after the hang-up, so its prompt shows the hang-up added nothing.
  const d = await run("sleep 60");
  await React.act(async () => bus.notifyTabClosed(d));
  assert.equal(card("sleep 60")!.state, "closed");
  await exit(d, 1);
  await exit(await run("echo e"), 0);
  const e = await next("e's prompt");
  assert.deepEqual(commandsOf(e), ["echo e"]);
  await reply(e.id, { stopReason: "end_turn" });
  await idle("idle after e");

  // TP-003: a Telegram turn holds the session's turn slot: a result waits for it, and goes when it finishes.
  const telegram = (phase: "started" | "finished") => React.act(async () => {
    await inbound({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "_keryx/telegram/turn", source: "telegram", phase, generation: "g1", updateId: 7 } } });
  });
  await telegram("started");
  await waitFor(() => session.state.busy, "the Telegram turn");
  await exit(await run("echo t"), 0);
  await waitFor(() => card("echo t")?.state === "waiting", "t waiting for the Telegram turn");
  await settle();
  none();
  await telegram("finished");
  const t = await next("t sent once the Telegram turn finished");
  assert.deepEqual(commandsOf(t), ["echo t"]);
  await reply(t.id, { stopReason: "end_turn" });
  await idle("idle after t");

  // FE-W1-003: a result that ends while a command runs in the session (keryx holds its turn slot for
  // /compact) waits for the command, and goes when it ends (here a compaction that changed nothing).
  let compacting: Promise<boolean> = Promise.resolve(false);
  await React.act(async () => { compacting = session.runCommand("/compact", ui); });
  await waitFor(() => commandsHeld.length === 1, "the /compact request");
  await exit(await run("echo f"), 0);
  await waitFor(() => card("echo f")?.state === "waiting", "f waiting for the command");
  none();
  await React.act(async () => {
    await reply(commandsHeld[0]!.id, { text: "Nothing to compact." });
    await compacting;
  });
  const f = await next("f sent once the command ended");
  assert.deepEqual(commandsOf(f), ["echo f"]);
  await reply(f.id, { stopReason: "end_turn" });
  await idle("idle after f");

  // R2-FE-005 / TP-003: a compaction that removed messages answers with the `transcript` effect: the window
  // replays the session, which it does not hold while that session/load runs, so the result stays off the
  // wire until the replay is done, and then goes once.
  await React.act(async () => { compacting = session.runCommand("/compact", ui); });
  await waitFor(() => commandsHeld.length === 2, "the second /compact request");
  await exit(await run("echo f2"), 0);
  await waitFor(() => card("echo f2")?.state === "waiting", "f2 waiting for the command");
  holdLoads = true;
  const loadsBefore = loads.length;
  await React.act(async () => {
    await reply(commandsHeld[1]!.id, { text: "Compacted −2 context msgs.", _meta: { keryx: { effects: ["transcript"] } } });
    await compacting;
  });
  await waitFor(() => loads.length === loadsBefore + 1, "the replay's session/load");
  await settle();
  none();
  assert.equal(card("echo f2")?.state, "waiting");
  holdLoads = false;
  await reply(loads.at(-1)!.id, {});
  const f2 = await next("f2 sent once the replay finished");
  assert.deepEqual(commandsOf(f2), ["echo f2"]);
  await reply(f2.id, { stopReason: "end_turn" });
  await idle("idle after f2");
  none();

  // AR-002: a prompt queued while a result waits: when the turn ends the results prompt goes first, the
  // queued prompt after that turn.
  assert.equal(session.sendPrompt("Turn one", "s1"), true);
  const one = await next("the user's turn");
  await React.act(async () => { await session.runCommand("Queued follow-up", ui); });
  await waitFor(() => session.state.queue.length === 1, "the queued prompt");
  await exit(await run("echo g"), 0);
  await waitFor(() => card("echo g")?.state === "waiting", "g waiting for the turn");
  await reply(one.id, { stopReason: "end_turn" });
  const g = await next("the prompt after the turn");
  assert.deepEqual(commandsOf(g), ["echo g"]);
  assert.equal(session.state.queue.length, 1);
  await reply(g.id, { stopReason: "end_turn" });
  const queued = await next("the queued prompt");
  assert.equal(textOf(queued), "Queued follow-up");
  await reply(queued.id, { stopReason: "end_turn" });
  await waitFor(() => !session.state.busy && session.state.queue.length === 0, "idle after the queue");

  // HL2-001: keryx's idle cap releases s1 while its results prompt is on the wire, then answers "unknown
  // session": the result waits, and goes once s1 is held again.
  await exit(await run("echo h"), 0);
  const h = await next("h's prompt");
  await releaseUnder(h);
  await waitFor(() => card("echo h")?.state === "waiting" && !session.state.held, "h waiting while s1 is released");
  none();
  await React.act(async () => { await session.loadSession("s1"); });
  const hAgain = await next("h sent once s1 is held again");
  assert.deepEqual(resultsOf(hAgain).map((r) => r.runId), resultsOf(h).map((r) => r.runId));
  await reply(hAgain.id, { stopReason: "end_turn" });
  await idle("idle after h");

  // HL2-001: keryx shutting down: the result waits, is not asked again on the window's next change, and
  // goes to the next keryx once it holds the session.
  await exit(await run("echo i"), 0);
  const i = await next("i's prompt");
  await refuse(i.id, { code: -32600, message: "session/prompt: keryx acp is shutting down", data: { method: "session/prompt", condition: "shutting-down" } });
  await waitFor(() => card("echo i")?.state === "waiting" && !session.state.busy, "i waiting for the next keryx");
  await React.act(async () => session.notify("info", "the window changed"));
  none();
  assert.equal(heldTimers.length, 0);
  await React.act(async () => session.restart());
  const iAgain = await next("i sent to the restarted keryx");
  assert.deepEqual(commandsOf(iAgain), ["echo i"]);
  await reply(iAgain.id, { stopReason: "end_turn" });
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
  none();
}

async function loadOrder(): Promise<void> {
  // R2-RR-001: a result waits for s1 while keryx's idle cap holds it released; the load that holds it again
  // answers that issue questions wait. The questions are resumed first; the result goes after that turn.
  await exit(await run("echo h"), 0);
  const h = await next("h's prompt");
  await releaseUnder(h);
  await waitFor(() => card("echo h")?.state === "waiting" && !session.state.held, "h waiting while s1 is released");
  loadAnswer = { _meta: { keryx: { pendingIssueQuestions: true } } };
  await React.act(async () => { await session.loadSession("s1"); });
  const resume = await next("the resumed issue questions");
  assert.deepEqual(resume.params._meta, { keryx: { resumeIssueQuestions: true } });
  await settle();
  none();
  assert.equal(card("echo h")?.state, "waiting");
  await reply(resume.id, { stopReason: "end_turn" });
  const hAgain = await next("h after the resumed turn");
  assert.deepEqual(resultsOf(hAgain).map((r) => r.runId), resultsOf(h).map((r) => r.runId));
  await reply(hAgain.id, { stopReason: "end_turn" });
  await idle("idle after h");

  // R2-RR-001: a review sent as soon as the load resolves (App's startSessionReview, which says
  // REVIEW_SESSION_BUSY when this send is refused) gets the slot; the result that waited goes after it.
  loadAnswer = {};
  await exit(await run("echo r"), 0);
  const r = await next("r's prompt");
  await releaseUnder(r);
  await waitFor(() => card("echo r")?.state === "waiting" && !session.state.held, "r waiting while s1 is released");
  let reviewSent = false;
  await React.act(async () => {
    await session.loadSession("s1");
    reviewSent = session.sendPrompt("Review the pull request.", "s1");
  });
  assert.equal(reviewSent, true);
  const review = await next("the review turn");
  assert.equal(textOf(review), "Review the pull request.");
  await settle();
  none();
  await reply(review.id, { stopReason: "end_turn" });
  const rAgain = await next("r after the review turn");
  assert.deepEqual(commandsOf(rAgain), ["echo r"]);
  await reply(rAgain.id, { stopReason: "end_turn" });
  await idle("idle after r");
  none();

  // R3-LG-001: the questions are queued behind a Telegram turn that holds the slot when the load ends (a
  // compaction replays the session while the turn runs): when the turn finishes, the queued resume goes before
  // the result that waited for the load, as it does when it is sent at once.
  loadAnswer = {};
  const ui = { focusSessions() {}, mode() {}, model() {}, openProviders() {}, fillComposer() {} };
  await inbound({ method: "session/update", params: { sessionId: "s1", update: {
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "compact", description: "Compact the history", _meta: { keryx: { surface: "text" } } }],
  } } });
  await waitFor(() => session.state.commands.some((c) => c.name === "compact"), "the compact command");
  const telegram = (phase: "started" | "finished") => React.act(async () => {
    await inbound({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "_keryx/telegram/turn", source: "telegram", phase, generation: "g2", updateId: 8 } } });
  });
  await telegram("started");
  await waitFor(() => session.state.busy, "the Telegram turn");
  let compacting: Promise<boolean> = Promise.resolve(false);
  await React.act(async () => { compacting = session.runCommand("/compact", ui); });
  await waitFor(() => commandsHeld.length === 1, "the /compact request");
  await exit(await run("echo q"), 0);
  await waitFor(() => card("echo q")?.state === "waiting", "q waiting");
  loadAnswer = { _meta: { keryx: { pendingIssueQuestions: true } } };
  await React.act(async () => {
    await reply(commandsHeld[0]!.id, { text: "Compacted −2 context msgs.", _meta: { keryx: { effects: ["transcript"] } } });
    await compacting;
  });
  await waitFor(() => session.state.held && loads.length > 0, "the replay done");
  await settle();
  none();
  assert.equal(card("echo q")?.state, "waiting");
  await telegram("finished");
  // The replay dropped the window's copy of the turn, so its end changes no state of the window: any change
  // of the window runs the arbiter (the notice is that change).
  await React.act(async () => session.notify("info", "the window changed"));
  const resumeQueued = await next("the queued issue questions");
  assert.deepEqual(resumeQueued.params._meta, { keryx: { resumeIssueQuestions: true } });
  await settle();
  none();
  assert.equal(card("echo q")?.state, "waiting");
  await reply(resumeQueued.id, { stopReason: "end_turn" });
  const qAgain = await next("q after the resumed turn");
  assert.deepEqual(commandsOf(qAgain), ["echo q"]);
  await reply(qAgain.id, { stopReason: "end_turn" });
  await idle("idle after q");
  none();
}

async function lostConnection(): Promise<void> {
  // R2-HL-002: keryx exits while a results prompt has no answer. The prompt may never have reached it: the
  // result waits (the card does not say sent, and no turn failure is reported), and goes again to the next
  // keryx once it holds s1. That keryx had stored it: it answers that every run was a duplicate, which is
  // delivered.
  await exit(await run("echo x"), 0);
  const x = await next("x's prompt");
  await React.act(async () => { await emit("acp://exit", { code: 1, stderrTail: "killed" }); });
  await waitFor(() => card("echo x")?.state === "waiting" && session.state.phase === "exited", "x waiting after keryx exited");
  assert.equal(session.state.items.some((i) => i.kind === "notice" && i.level === "error"), false);
  await React.act(async () => session.restart());
  const xAgain = await next("x sent again to the restarted keryx");
  assert.deepEqual(resultsOf(xAgain), resultsOf(x));
  await reply(xAgain.id, { stopReason: "end_turn", _meta: { keryx: { terminalResults: { stored: 0, duplicates: [resultsOf(x)[0]!.runId] } } } });
  await waitFor(() => card("echo x")?.state === "sent" && !session.state.busy, "x delivered");

  // R2-HL-002: the user restarts keryx while a results prompt has no answer: the window's client is
  // replaced before the old one's rejection runs. The same: it waits, and goes to the new keryx.
  await exit(await run("echo y"), 0);
  const y = await next("y's prompt");
  await React.act(async () => session.restart());
  const yAgain = await next("y sent again after the restart");
  assert.deepEqual(resultsOf(yAgain), resultsOf(y));
  await reply(yAgain.id, { stopReason: "end_turn" });
  await waitFor(() => card("echo y")?.state === "sent" && !session.state.busy, "y delivered");
  await settle();
  none();

  /** The transcript in order: a run card by its command, an agent message by its text, anything else by its kind. */
  const order = () => session.state.items.map((i) =>
    i.kind === "terminalRun" ? (i as unknown as Card).command : i.kind === "agent" ? (i as unknown as { text: string }).text : i.kind);
  /** keryx exits while `command`'s results prompt has no answer; the restarted keryx's load of s1 is held. */
  async function lostThenRestarted(command: string): Promise<{ id: number; params: Json }> {
    await exit(await run(command), 0);
    const sent = await next(`${command}'s prompt`);
    await React.act(async () => { await emit("acp://exit", { code: 1, stderrTail: "killed" }); });
    await waitFor(() => card(command)?.state === "waiting" && session.state.phase === "exited", `${command} waiting after keryx exited`);
    holdLoads = true;
    const loadsBefore = loads.length;
    await React.act(async () => session.restart());
    await waitFor(() => loads.length === loadsBefore + 1, "the restarted keryx's load of s1");
    return sent;
  }
  const replayNote = (command: string, result: Json | undefined) => inbound({ method: "session/update", params: { sessionId: "s1", update: {
    sessionUpdate: "user_message_chunk", content: { type: "text", text: `$ ${command}` }, _meta: { keryx: { terminalResult: result } },
  } } });
  const agentChunk = (text: string) => inbound({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });

  // R3-FE-001, no turn: keryx had stored z's note and recorded the follow-up turn (its continuation line and
  // reply), then exited before answering. The restarted keryx replays all of it. The re-sent result is a
  // duplicate whose note no longer ends the history: keryx answers at once, runs no turn, streams nothing.
  // The card takes the note's place and stays there, before that reply.
  const z = await lostThenRestarted("echo z");
  const [zResult] = resultsOf(z);
  await replayNote("echo z", zResult);
  await inbound({ method: "session/update", params: { sessionId: "s1", update: {
    sessionUpdate: "user_message_chunk", content: { type: "text", text: "The commands you proposed ran in the operator's terminal." },
    _meta: { keryx: { terminalContinuation: true } },
  } } });
  await agentChunk("z printed nothing.");
  holdLoads = false;
  await reply(loads.at(-1)!.id, {});
  const zAgain = await next("z sent again to the restarted keryx");
  assert.deepEqual(resultsOf(zAgain), resultsOf(z));
  await reply(zAgain.id, { stopReason: "end_turn", _meta: { keryx: { terminalResults: { stored: 0, duplicates: [zResult!.runId] } } } });
  await waitFor(() => card("echo z")?.state === "sent" && !session.state.busy, "z delivered");
  // z's card in its note's place, before the reply; x and y (their tabs still open) kept at the end.
  assert.deepEqual(order(), ["echo z", "z printed nothing.", "echo x", "echo y"]);
  await settle();
  none();

  // R3-LG-005, the resumed turn: keryx had stored w's note and exited inside the follow-up turn, which it
  // records only at its end. The restarted keryx replays the note alone, so the re-sent duplicate's note ends
  // the history: keryx runs that turn now. Its reply streams while the re-sent prompt is open, and the answer
  // names the duplicate. The card stays in its note's place, and the reply follows it.
  const w = await lostThenRestarted("echo w");
  const [wResult] = resultsOf(w);
  await replayNote("echo w", wResult);
  holdLoads = false;
  await reply(loads.at(-1)!.id, {});
  const wAgain = await next("w sent again to the restarted keryx");
  assert.deepEqual(resultsOf(wAgain), resultsOf(w));
  await waitFor(() => card("echo w")?.state === "sent" && session.state.busy, "w sent again, its turn open");
  await agentChunk("w printed nothing either.");
  await waitFor(() => order().includes("w printed nothing either."), "the resumed turn's reply");
  await reply(wAgain.id, { stopReason: "end_turn", _meta: { keryx: { terminalResults: { stored: 0, duplicates: [wResult!.runId], resumed: true } } } });
  await waitFor(() => !session.state.busy, "the resumed turn's end");
  // w's card in its note's place, the reply after it; the cards kept from before the reload (their tabs
  // still open) sit between them, at the end of the replay.
  assert.deepEqual(order(), ["echo w", "echo z", "echo x", "echo y", "w printed nothing either."]);
  assert.equal(session.state.items.some((i) => i.kind === "user"), false);
  none();
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
  else if (scenario === "refusals") await refusals();
  else if (scenario === "load-order") await loadOrder();
  else await lostConnection();
} finally {
  offRuns();
  await React.act(async () => root.unmount());
  clearMocks();
  await unregisterDom();
}
