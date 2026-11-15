// Flow 492 T11 (AC11): the TUI quick start. Every row of the plan's state and event matrix has a
// test here. The form logic is a plain controller (no OpenTUI), so the matrix runs against it
// directly; a few tests then drive the real modal on a headless renderer the way the operator does
// (keys only), and the sender is checked against a fake `fetch`.

import { expect, test } from "bun:test";
import { parseQuickStartBody } from "../hub/work/quick-start";
import { QUICK_MODES } from "../hub/work/quick-modes";
import { questionsFor } from "../hub/work/clarify";
import { formatModalFooter } from "./modal-host";
import { loadOpenTui, mountChrome, settle } from "./ops-sidebar.test-helpers";
import {
  createQuickStartForm,
  createQuickStartMemory,
  EDITED_PENDING_NOTICE,
  RETRY_NOTICE,
  type QuickStartForm,
  type QuickStartOutcome,
  type QuickStartSender,
} from "./quick-start-form";
import { createQuickStartSender, isQuickStartCommand, QUICK_START_COMMAND } from "./quick-start-command";
import { openQuickStart, QUICK_START_FOOTER, quickStartLines, tail, windowLines, wrapText } from "./quick-start-modal";
import {
  buildQuickStartRequest,
  parseCriteriaField,
  QUICK_START_REQUEST_FIELDS,
  type QuickStartRequestBody,
} from "./quick-start-request";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

type Key = { name: string; sequence: string };
const key = (name: string, sequence = ""): Key => ({ name, sequence });
const ENTER = key("return", "\r");
const DOWN = key("down");
const RIGHT = key("right");
const BACKSPACE = key("backspace");

function type(form: QuickStartForm, text: string): void {
  for (const ch of text) form.handleKey(key(ch === " " ? "space" : ch, ch));
}

/** A sender that records every call and answers from a script; the last answer repeats. */
function fakeSender(...answers: QuickStartOutcome[]) {
  const calls: Array<{ operationId: string; body: QuickStartRequestBody }> = [];
  const send: QuickStartSender = async (operationId, body) => {
    calls.push({ operationId, body });
    return answers[Math.min(calls.length - 1, answers.length - 1)]!;
  };
  return { calls, send };
}

const ACCEPTED: QuickStartOutcome = { kind: "accepted", flowId: "flow-1", intentId: "intent-1" };

function mintIds() {
  let n = 0;
  return () => `op-${++n}`;
}

/** Mode stays on Quick; Enter x1 moves to the description, which is typed in. */
function filled(form: QuickStartForm, description = "Fix the typo"): void {
  form.handleKey(ENTER);
  type(form, description);
}

/** Walks the focus to the Start button. */
function focusSubmit(form: QuickStartForm): void {
  for (let i = 0; i < 20 && form.state().focus !== "submit"; i++) form.handleKey(DOWN);
}

async function submitViaKeys(form: QuickStartForm): Promise<void> {
  focusSubmit(form);
  form.handleKey(ENTER);
  await form.settled();
}

// ----- the pure request builder (the T12 parity import) -----------------------------------------

test("request builder: the body carries exactly the four fields the route accepts", () => {
  const body = buildQuickStartRequest({ mode: "bug", description: "  Login fails  ", answers: {}, criteria: [] });
  expect(Object.keys(body)).toEqual([...QUICK_START_REQUEST_FIELDS]);
  expect([...QUICK_START_REQUEST_FIELDS]).toEqual(["mode", "description", "answers", "criteria"]);
  expect(body.description).toBe("Login fails");
  // The Hub's own validator accepts it unchanged.
  expect(() => parseQuickStartBody({ ...body })).not.toThrow();
});

test("request builder: one answer per template question in order, blanks recorded as skipped", () => {
  const ids = questionsFor("bug").map((question) => question.id);
  const body = buildQuickStartRequest({
    mode: "bug",
    description: "Login fails",
    answers: { [ids[0]!]: "  click login  ", [ids[1]!]: "   " },
    criteria: ["Add a changelog line", "   "],
  });
  expect(body.answers.map((answer) => answer.q)).toEqual(ids);
  expect(body.answers[0]).toEqual({ q: ids[0]!, a: "click login", skipped: false });
  expect(body.answers[1]).toEqual({ q: ids[1]!, a: null, skipped: true });
  expect(body.answers[2]).toEqual({ q: ids[2]!, a: null, skipped: true });
  expect(body.criteria).toEqual(["Add a changelog line"]);
});

test("request builder: every mode builds a body the Hub validator accepts; an unknown mode is a caller bug", () => {
  for (const mode of QUICK_MODES) {
    const body = buildQuickStartRequest({ mode: mode.id, description: "x", answers: {}, criteria: [] });
    expect(body.mode).toBe(mode.id);
    expect(body.answers).toHaveLength(questionsFor(mode.id).length);
    expect(() => parseQuickStartBody({ ...body })).not.toThrow();
  }
  expect(() => buildQuickStartRequest({ mode: "nope", description: "x", answers: {}, criteria: [] })).toThrow();
});

test("criteria field: sentences split on semicolons, blanks dropped", () => {
  expect(parseCriteriaField(" first ; second;; ;third ")).toEqual(["first", "second", "third"]);
  expect(parseCriteriaField("")).toEqual([]);
});

// ----- matrix: closed / open -----------------------------------------------------------------------

test("matrix closed + open: the form starts on the mode, with every mode offered and nothing to send yet", () => {
  const { send, calls } = fakeSender(ACCEPTED);
  const form = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds() });
  const state = form.state();
  expect(state.phase).toBe("editing");
  expect(state.focus).toBe("mode");
  expect(state.mode).toBe("quick");
  expect(state.canSubmit).toBe(false);
  expect(calls).toHaveLength(0);
});

test("matrix closed + open: the command token is /task and nothing else", () => {
  expect(QUICK_START_COMMAND).toBe("/task");
  expect(isQuickStartCommand("/task")).toBe(true);
  expect(isQuickStartCommand("  /task  ")).toBe(true);
  expect(isQuickStartCommand("/tasks")).toBe(false);
  expect(isQuickStartCommand("/flows")).toBe(false);
});

// ----- matrix: mode chosen -------------------------------------------------------------------------

test("matrix mode chosen + type description: submit is enabled only for a non-empty description", () => {
  const form = createQuickStartForm({ send: fakeSender(ACCEPTED).send, onAccepted: () => {}, newOperationId: mintIds() });
  form.handleKey(ENTER);
  expect(form.state().focus).toBe("description");
  expect(form.state().canSubmit).toBe(false);
  type(form, "   ");
  expect(form.state().canSubmit).toBe(false);
  type(form, "Fix it");
  expect(form.state().canSubmit).toBe(true);
  for (let i = 0; i < "Fix it".length + 3; i++) form.handleKey(BACKSPACE);
  expect(form.state().description).toBe("");
  expect(form.state().canSubmit).toBe(false);
});

test("matrix mode chosen + type description: pressing Start with an empty description sends nothing", async () => {
  const { send, calls } = fakeSender(ACCEPTED);
  const form = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds() });
  await submitViaKeys(form);
  expect(calls).toHaveLength(0);
  expect(form.state().phase).toBe("editing");
});

test("matrix mode chosen + questions shown: one slot per template question, switching mode swaps them", () => {
  const form = createQuickStartForm({ send: fakeSender(ACCEPTED).send, onAccepted: () => {}, newOperationId: mintIds() });
  const questionSlots = (): string[] => form.state().slots.filter((slot) => slot.startsWith("question:"));
  expect(questionSlots()).toEqual(questionsFor("quick").map((question) => `question:${question.id}`));
  // Right on the mode slot walks the modes; Left walks back.
  form.handleKey(RIGHT);
  expect(form.state().mode).toBe("bug");
  expect(questionSlots()).toEqual(questionsFor("bug").map((question) => `question:${question.id}`));
  form.handleKey(RIGHT);
  form.handleKey(RIGHT);
  expect(form.state().mode).toBe("epic");
  expect(questionSlots()).toHaveLength(4);
  form.handleKey(key("left"));
  expect(form.state().mode).toBe("task");
  // Slot order: mode, description, questions, criteria, submit.
  expect(form.state().slots[0]).toBe("mode");
  expect(form.state().slots[1]).toBe("description");
  expect(form.state().slots.at(-2)).toBe("criteria");
  expect(form.state().slots.at(-1)).toBe("submit");
});

test("matrix mode chosen + questions shown: each question is keyboard-answerable and skippable by leaving it blank", async () => {
  const { send, calls } = fakeSender(ACCEPTED);
  const form = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds() });
  filled(form, "Fix the typo");
  form.handleKey(ENTER); // description -> first question
  const first = questionsFor("quick")[0]!.id;
  expect(form.state().focus).toBe(`question:${first}`);
  type(form, "the title");
  form.handleKey(ENTER); // -> second question, left blank
  form.handleKey(ENTER); // -> criteria
  expect(form.state().focus).toBe("criteria");
  await submitViaKeys(form);
  const [a, b] = calls[0]!.body.answers;
  expect(a).toEqual({ q: first, a: "the title", skipped: false });
  expect(b!.skipped).toBe(true);
});

// ----- matrix: form filled + submit ----------------------------------------------------------------

test("matrix form filled + submit: one request with one operation id, and the same shape the web sends", async () => {
  const { send, calls } = fakeSender(ACCEPTED);
  const form = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds() });
  form.handleKey(RIGHT); // bug
  filled(form, "Login fails");
  focusSubmit(form);
  form.handleKey(ENTER);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.operationId).toBe("op-1");
  expect(calls[0]!.body).toEqual(buildQuickStartRequest({ mode: "bug", description: "Login fails", answers: {}, criteria: [] }));
  expect(Object.keys(calls[0]!.body)).toEqual([...QUICK_START_REQUEST_FIELDS]);
  await form.settled();
});

test("matrix form filled + submit: while the request is in flight the form is submitting and a second press sends nothing", async () => {
  let release: (outcome: QuickStartOutcome) => void = () => {};
  const calls: string[] = [];
  const send: QuickStartSender = (operationId) => {
    calls.push(operationId);
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const form = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds() });
  filled(form);
  focusSubmit(form);
  form.handleKey(ENTER);
  expect(form.state().phase).toBe("submitting");
  expect(form.state().canSubmit).toBe(false);
  // Enter again, and any typing: all swallowed, nothing sent, nothing edited.
  expect(form.handleKey(ENTER)).toBe(true);
  expect(form.handleKey(key("a", "a"))).toBe(true);
  expect(form.state().description).toBe("Fix the typo");
  expect(calls).toEqual(["op-1"]);
  release(ACCEPTED);
  await form.settled();
  expect(form.state().phase).toBe("done");
});

// ----- matrix: submitting + accept / replay --------------------------------------------------------

test("matrix submitting + server accepts: the Flow is named to the host and the form is done", async () => {
  const accepted: Array<{ flowId: string; intentId: string }> = [];
  const form = createQuickStartForm({
    send: fakeSender(ACCEPTED).send,
    onAccepted: (flowId, intentId) => accepted.push({ flowId, intentId }),
    newOperationId: mintIds(),
  });
  filled(form);
  await submitViaKeys(form);
  expect(accepted).toEqual([{ flowId: "flow-1", intentId: "intent-1" }]);
  expect(form.state().phase).toBe("done");
  expect(form.state().error).toBeUndefined();
});

test("matrix submitting + replay (same id): the same receipt comes back and no second Flow is made", async () => {
  // A server that is idempotent on the operation id, the way the Hub's route is.
  const flows = new Map<string, QuickStartOutcome>();
  const send: QuickStartSender = async (operationId, body) => {
    if (!flows.has(operationId)) flows.set(operationId, { kind: "accepted", flowId: `flow-for-${operationId}`, intentId: "i" });
    void body;
    return flows.get(operationId)!;
  };
  // First attempt's answer is lost on the wire; the retry carries the same id.
  let attempt = 0;
  const flaky: QuickStartSender = async (operationId, body) => {
    const outcome = await send(operationId, body);
    attempt += 1;
    return attempt === 1 ? { kind: "network", message: "connection reset" } : outcome;
  };
  const accepted: string[] = [];
  const form = createQuickStartForm({ send: flaky, onAccepted: (flowId) => accepted.push(flowId), newOperationId: mintIds() });
  filled(form);
  await submitViaKeys(form);
  await submitViaKeys(form);
  expect(flows.size).toBe(1);
  expect(accepted).toEqual(["flow-for-op-1"]);
});

// ----- matrix: submitting + rejects / network ------------------------------------------------------

test("matrix submitting + server rejects (4xx): error shown, every input kept, form editable again", async () => {
  const { send } = fakeSender({ kind: "rejected", status: 400, code: "invalid-body", message: "description is required" });
  const form = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds() });
  form.handleKey(RIGHT);
  filled(form, "Login fails");
  form.handleKey(ENTER);
  type(form, "click login");
  await submitViaKeys(form);
  const state = form.state();
  expect(state.phase).toBe("editing");
  expect(state.error).toEqual({ kind: "rejected", message: "description is required", retry: false });
  expect(state.mode).toBe("bug");
  expect(state.description).toBe("Login fails");
  expect(Object.values(state.answers)).toContain("click login");
});

test("matrix submitting + server rejects (4xx): the next attempt uses a fresh operation id", async () => {
  const { send, calls } = fakeSender({ kind: "rejected", status: 400, code: "invalid-body", message: "no" }, ACCEPTED);
  const form = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds() });
  filled(form);
  await submitViaKeys(form);
  await submitViaKeys(form);
  expect(calls.map((call) => call.operationId)).toEqual(["op-1", "op-2"]);
  expect(form.state().phase).toBe("done");
});

test("matrix submitting + server rejects (4xx): a signed-in-human refusal is explained in plain words", async () => {
  const { send } = fakeSender({ kind: "rejected", status: 403, code: "human-required", message: "Only a signed-in human can start work" });
  const form = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds() });
  filled(form);
  await submitViaKeys(form);
  const message = form.state().error?.message ?? "";
  expect(message).toContain("signed-in human");
  expect(message).toContain("web");
  expect(form.state().error?.retry).toBe(false);
});

test("matrix submitting + network lost: error offers a retry and the retry reuses the same operation id", async () => {
  const { send, calls } = fakeSender({ kind: "network", message: "connection refused" }, ACCEPTED);
  const accepted: string[] = [];
  const form = createQuickStartForm({ send, onAccepted: (flowId) => accepted.push(flowId), newOperationId: mintIds() });
  filled(form);
  await submitViaKeys(form);
  expect(form.state().phase).toBe("editing");
  expect(form.state().error).toMatchObject({ kind: "network", retry: true });
  expect(form.state().error?.message).toContain("connection refused");
  expect(form.state().description).toBe("Fix the typo");
  await submitViaKeys(form);
  expect(calls.map((call) => call.operationId)).toEqual(["op-1", "op-1"]);
  expect(calls[1]!.body).toEqual(calls[0]!.body);
  expect(accepted).toEqual(["flow-1"]);
});

test("matrix submitting + network lost: editing the form before the retry makes a new operation id", async () => {
  const { send, calls } = fakeSender({ kind: "network", message: "reset" }, ACCEPTED);
  const form = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds() });
  filled(form);
  await submitViaKeys(form);
  form.handleKey(key("up")); // back to editing: description is two slots up from submit
  while (form.state().focus !== "description") form.handleKey(key("up"));
  type(form, "!");
  await submitViaKeys(form);
  expect(calls.map((call) => call.operationId)).toEqual(["op-1", "op-2"]);
});

// ----- matrix: any + Escape ------------------------------------------------------------------------

test("matrix any + Escape: the form never consumes Escape, so the host closes it; the draft is readable", () => {
  const { send, calls } = fakeSender(ACCEPTED);
  const form = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds() });
  filled(form, "half a thought");
  expect(form.handleKey(key("escape", "\u001b"))).toBe(false);
  expect(calls).toHaveLength(0);
  const draft = form.draft();
  expect(draft.description).toBe("half a thought");
  const again = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds(), initial: draft });
  expect(again.state().description).toBe("half a thought");
  expect(again.state().mode).toBe("quick");
});

// ----- matrix: form filled + questions skipped -----------------------------------------------------

test("matrix form filled + questions skipped: every question is recorded as skipped, none dropped", async () => {
  const { send, calls } = fakeSender(ACCEPTED);
  const form = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds() });
  form.handleKey(RIGHT);
  form.handleKey(RIGHT); // task
  filled(form, "Add the export button");
  await submitViaKeys(form);
  const answers = calls[0]!.body.answers;
  expect(answers).toHaveLength(questionsFor("task").length);
  expect(answers.every((answer) => answer.skipped && answer.a === null)).toBe(true);
});

// ----- keys the host would otherwise take ----------------------------------------------------------

test("keys: typing in a text field is claimed (so `x` is a letter, not close) while the mode and Start slots leave `x` to the host", () => {
  const form = createQuickStartForm({ send: fakeSender(ACCEPTED).send, onAccepted: () => {}, newOperationId: mintIds() });
  expect(form.handleKey(key("x", "x"))).toBe(false); // on the mode slot
  form.handleKey(ENTER);
  expect(form.handleKey(key("x", "x"))).toBe(true); // in the description
  expect(form.state().description).toBe("x");
});

test("keys: a pasted line lands in the field with its line breaks flattened", () => {
  const form = createQuickStartForm({ send: fakeSender(ACCEPTED).send, onAccepted: () => {}, newOperationId: mintIds() });
  form.handleKey(ENTER);
  form.handleKey(key("", "first\nsecond"));
  expect(form.state().description).toBe("first second");
});

test("keys: Up wraps from the first slot to Start and Down wraps back", () => {
  const form = createQuickStartForm({ send: fakeSender(ACCEPTED).send, onAccepted: () => {}, newOperationId: mintIds() });
  form.handleKey(key("up"));
  expect(form.state().focus).toBe("submit");
  form.handleKey(DOWN);
  expect(form.state().focus).toBe("mode");
});

// ----- the sender ----------------------------------------------------------------------------------

function recordingFetch(respond: (request: Request) => Response | Promise<Response>) {
  const seen: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
  const fetchFn = async (request: Request): Promise<Response> => {
    seen.push({ url: request.url, method: request.method, headers: request.headers, body: await request.clone().text() });
    return respond(request);
  };
  return { seen, fetchFn };
}

const BODY: QuickStartRequestBody = buildQuickStartRequest({ mode: "quick", description: "Fix it", answers: {}, criteria: [] });

test("sender: POSTs the body to the project's quick-start route with the operation id and the bearer token", async () => {
  const { seen, fetchFn } = recordingFetch(
    () => new Response(JSON.stringify({ operationId: "op-1", status: "committed", flowId: "flow-9", intentId: "intent-9" }), { status: 200 }),
  );
  const send = createQuickStartSender({ baseUrl: "http://localhost:4000", projectId: "my proj", headers: { Authorization: "Bearer t0k" }, fetch: fetchFn });
  const outcome = await send("op-1", BODY);
  expect(outcome).toEqual({ kind: "accepted", flowId: "flow-9", intentId: "intent-9" });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.method).toBe("POST");
  expect(new URL(seen[0]!.url).pathname).toBe("/hub/work/v1/projects/my%20proj/quick-start");
  expect(seen[0]!.headers.get("Idempotency-Key")).toBe("op-1");
  expect(seen[0]!.headers.get("Authorization")).toBe("Bearer t0k");
  expect(seen[0]!.headers.get("Content-Type")).toBe("application/json");
  expect(JSON.parse(seen[0]!.body)).toEqual(BODY);
});

test("sender: a 4xx is a rejection carrying the Hub's code and message", async () => {
  const { fetchFn } = recordingFetch(
    () => new Response(JSON.stringify({ error: { code: "human-required", message: "Only a signed-in human can start work", retryable: false } }), { status: 403 }),
  );
  const send = createQuickStartSender({ baseUrl: "http://localhost:4000", projectId: "p", fetch: fetchFn });
  expect(await send("op-1", BODY)).toEqual({ kind: "rejected", status: 403, code: "human-required", message: "Only a signed-in human can start work" });
});

test("sender: a 5xx, a dropped connection and an unreadable answer are all network outcomes (the id is kept)", async () => {
  const five = createQuickStartSender({
    baseUrl: "http://localhost:4000",
    projectId: "p",
    fetch: async () => new Response("bad gateway", { status: 502 }),
  });
  expect((await five("op-1", BODY)).kind).toBe("network");
  const dropped = createQuickStartSender({
    baseUrl: "http://localhost:4000",
    projectId: "p",
    fetch: async () => {
      throw new Error("ECONNRESET");
    },
  });
  const outcome = await dropped("op-1", BODY);
  expect(outcome.kind).toBe("network");
  const garbled = createQuickStartSender({
    baseUrl: "http://localhost:4000",
    projectId: "p",
    fetch: async () => new Response("not json", { status: 200 }),
  });
  expect((await garbled("op-1", BODY)).kind).toBe("network");
});

test("sender: a 4xx with an unreadable body is still a rejection, never a crash", async () => {
  const send = createQuickStartSender({
    baseUrl: "http://localhost:4000",
    projectId: "p",
    fetch: async () => new Response("<html>", { status: 404 }),
  });
  const outcome = await send("op-1", BODY);
  expect(outcome).toMatchObject({ kind: "rejected", status: 404 });
});

test("sender: plain http to a non-local host is refused before anything is sent", async () => {
  const { seen, fetchFn } = recordingFetch(() => new Response("{}"));
  expect(() => createQuickStartSender({ baseUrl: "http://hub.example.com", projectId: "p", fetch: fetchFn })).toThrow();
  expect(seen).toHaveLength(0);
});

// ----- the pure drawing --------------------------------------------------------------------------

const plain = (state: Parameters<typeof quickStartLines>[0], width = 80): string =>
  quickStartLines(state, width).map((line) => line.segments.map((segment) => segment.text).join("")).join("\n");

test("lines: every state says what Start does, and a rejection or retry is spelled out under it", async () => {
  const { send } = fakeSender({ kind: "network", message: "connection refused" });
  const form = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds() });
  expect(plain(form.state())).toContain("describe the task first");
  filled(form);
  expect(plain(form.state())).toContain("[ Start ]");
  expect(plain(form.state())).not.toContain("describe the task first");
  await submitViaKeys(form);
  expect(plain(form.state())).toContain("connection refused");
  expect(plain(form.state())).toContain("retry");
});

test("lines: a skipped question reads as skipped and an answered one shows its text", () => {
  const form = createQuickStartForm({ send: fakeSender(ACCEPTED).send, onAccepted: () => {}, newOperationId: mintIds() });
  filled(form);
  form.handleKey(ENTER);
  type(form, "the title");
  form.handleKey(DOWN);
  form.handleKey(DOWN);
  const text = plain(form.state());
  expect(text).toContain("the title");
  expect(text).toContain("(skipped)");
});

test("lines: windowLines keeps the focused field on screen when the body is shorter than the form", () => {
  const form = createQuickStartForm({ send: fakeSender(ACCEPTED).send, onAccepted: () => {}, newOperationId: mintIds() });
  focusSubmit(form);
  const lines = quickStartLines(form.state(), 80);
  const slice = windowLines(lines, 6);
  expect(slice).toHaveLength(6);
  expect(slice.some((line) => line.focus)).toBe(true);
  expect(windowLines(lines, lines.length + 5)).toHaveLength(lines.length);
  form.handleKey(DOWN); // wraps to the mode, the very top
  expect(windowLines(quickStartLines(form.state(), 80), 6)[0]!.id).toBe("mode");
});

test("lines: windowLines keeps the whole error on screen after a failed Start", () => {
  const form = createQuickStartForm({ send: fakeSender({ kind: "network", message: "x ".repeat(120) }).send, onAccepted: () => {}, newOperationId: mintIds() });
  filled(form);
  const lines = quickStartLines({ ...form.state(), error: { kind: "network", message: "x ".repeat(120), retry: true }, focus: "submit" }, 60);
  const errors = lines.filter((line) => line.id.startsWith("error-"));
  expect(errors.length).toBeGreaterThan(1);
  const slice = windowLines(lines, 10);
  expect(slice).toHaveLength(10);
  expect(slice.some((line) => line.focus)).toBe(true);
  expect(slice.map((line) => line.id)).toContain(errors[errors.length - 1]!.id);
});

test("lines: windowLines keeps the focus on screen when the error is further below than the window reaches", () => {
  const form = createQuickStartForm({ send: fakeSender(ACCEPTED).send, onAccepted: () => {}, newOperationId: mintIds() });
  filled(form);
  const message = "x ".repeat(120);
  const lines = quickStartLines({ ...form.state(), error: { kind: "network", message, retry: true }, focus: "mode" }, 60);
  const slice = windowLines(lines, 10);
  expect(slice).toHaveLength(10);
  expect(slice.some((line) => line.focus)).toBe(true);
  expect(slice[0]!.id).toBe("mode");
});

test("lines: with focus on an answer and an error showing, the question text above the answer stays on screen", () => {
  const form = createQuickStartForm({ send: fakeSender(ACCEPTED).send, onAccepted: () => {}, newOperationId: mintIds() });
  form.handleKey(RIGHT); // bug: three questions
  filled(form, "Login fails");
  form.handleKey(ENTER); // first question
  const lines = quickStartLines({ ...form.state(), error: { kind: "network", message: "x ".repeat(60), retry: true } }, 60);
  const focusAt = lines.findIndex((line) => line.focus);
  expect(lines[focusAt - 1]!.id.startsWith("q-")).toBe(true);
  const slice = windowLines(lines, 8);
  expect(slice).toContain(lines[focusAt - 1]!);
  expect(slice).toContain(lines[focusAt]!);
});

test("lines: while a request is sending nothing is focused and the window follows the Sending row", () => {
  let release: (outcome: QuickStartOutcome) => void = () => {};
  const send: QuickStartSender = () => new Promise((resolve) => (release = resolve));
  const form = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds() });
  form.handleKey(RIGHT);
  filled(form, "Login fails");
  focusSubmit(form);
  form.handleKey(ENTER);
  expect(form.state().phase).toBe("submitting");
  const lines = quickStartLines(form.state(), 60);
  expect(lines.some((line) => line.focus)).toBe(false);
  expect(windowLines(lines, 6).map((line) => line.id)).toContain("start");
  release(ACCEPTED);
});

test("lines: an error taller than the window is cut to the rows given and ends in an ellipsis", () => {
  const state = { ...createQuickStartForm({ send: fakeSender(ACCEPTED).send, onAccepted: () => {} }).state() };
  const withError = { ...state, error: { kind: "network" as const, message: "word ".repeat(200), retry: true } };
  const errorRows = (max?: number) => quickStartLines(withError, 40, max).filter((line) => line.id.startsWith("error-"));
  expect(errorRows().length).toBeGreaterThan(4);
  const cut = errorRows(4);
  expect(cut).toHaveLength(4);
  expect(cut[3]!.segments[0]!.text.endsWith("…")).toBe(true);
  expect(cut[3]!.segments[0]!.text.length).toBeLessThanOrEqual(38);
});

test("pending: a reopened form on the same body starts on Start with the retry notice in the window", async () => {
  const earlier = createQuickStartForm({ send: fakeSender({ kind: "network", message: "reset" }).send, onAccepted: () => {}, newOperationId: mintIds() });
  filled(earlier);
  await submitViaKeys(earlier);
  const reopened = createQuickStartForm({
    send: fakeSender(ACCEPTED).send,
    onAccepted: () => {},
    initial: earlier.draft(),
    initialPending: earlier.pendingOperation()!,
  });
  expect(reopened.state().focus).toBe("submit");
  expect(reopened.state().error).toEqual({ kind: "network", message: RETRY_NOTICE, retry: true });
  const lines = quickStartLines(reopened.state(), 60);
  const slice = windowLines(lines, 8);
  expect(slice.some((line) => line.focus)).toBe(true);
  expect(slice.some((line) => line.id.startsWith("error-"))).toBe(true);
});

test("pending: a reopened form whose body has moved on warns instead of promising a replay, and editing back restores the retry", async () => {
  const earlier = createQuickStartForm({ send: fakeSender({ kind: "network", message: "reset" }).send, onAccepted: () => {}, newOperationId: mintIds() });
  filled(earlier, "Fix it");
  await submitViaKeys(earlier);
  const form = createQuickStartForm({
    send: fakeSender(ACCEPTED).send,
    onAccepted: () => {},
    initial: { ...earlier.draft(), description: "Fix it now" },
    initialPending: earlier.pendingOperation()!,
  });
  expect(form.state().focus).toBe("mode");
  expect(form.state().error).toEqual({ kind: "network", message: EDITED_PENDING_NOTICE, retry: false });
  while (form.state().focus !== "description") form.handleKey(DOWN);
  for (let i = 0; i < 4; i++) form.handleKey(BACKSPACE); // "Fix it now" -> "Fix it"
  expect(form.state().description).toBe("Fix it");
  expect(form.state().error).toEqual({ kind: "network", message: RETRY_NOTICE, retry: true });
});

test("pending: editing after a lost connection keeps the unresolved operation's notice instead of clearing it", async () => {
  const form = createQuickStartForm({ send: fakeSender({ kind: "network", message: "reset" }).send, onAccepted: () => {}, newOperationId: mintIds() });
  filled(form);
  await submitViaKeys(form);
  while (form.state().focus !== "description") form.handleKey(key("up"));
  type(form, "!");
  expect(form.state().error).toEqual({ kind: "network", message: EDITED_PENDING_NOTICE, retry: false });
});

test("size: a body the Hub would refuse is stopped in the form, with the Hub's own reason, and nothing is sent", async () => {
  const { send, calls } = fakeSender(ACCEPTED);
  const form = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds() });
  filled(form, "x".repeat(10001));
  await submitViaKeys(form);
  expect(calls).toHaveLength(0);
  expect(form.state().phase).toBe("editing");
  expect(form.state().error).toMatchObject({ kind: "rejected", retry: false });
  expect(form.state().error?.message).toContain("10000");
  expect(form.pendingOperation()).toBeUndefined();
  // Shortening the text lets it through, on a fresh id.
  while (form.state().focus !== "description") form.handleKey(key("up"));
  for (let i = 0; i < 10001 - 5; i++) form.handleKey(BACKSPACE);
  await submitViaKeys(form);
  expect(calls).toHaveLength(1);
});

test("size: a criterion over the cap and a form past the criteria cap are refused", async () => {
  const { send, calls } = fakeSender(ACCEPTED);
  const form = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds(), initial: { mode: "quick", description: "Fix it", answers: {}, criteria: "y".repeat(4001) } });
  await submitViaKeys(form);
  expect(form.state().error?.message).toContain("4000");
  const many = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds(), initial: { mode: "quick", description: "Fix it", answers: {}, criteria: Array.from({ length: 201 }, (_, i) => "c" + i).join(";") } });
  await submitViaKeys(many);
  expect(many.state().error?.message).toContain("200");
  expect(calls).toHaveLength(0);
});

test("memory: a lost connection survives a close, and the next form replays the same operation id", async () => {
  const memory = createQuickStartMemory();
  const ids = mintIds();
  const first = createQuickStartForm({ send: fakeSender({ kind: "network", message: "reset" }).send, onAccepted: () => {}, newOperationId: ids, ...memory.options() });
  memory.attach(first);
  filled(first);
  await submitViaKeys(first);
  const second = fakeSender(ACCEPTED);
  const reopened = createQuickStartForm({ send: second.send, onAccepted: () => {}, newOperationId: ids, ...memory.options() });
  expect(reopened.state().description).toBe("Fix the typo");
  await submitViaKeys(reopened);
  expect(second.calls.map((call) => call.operationId)).toEqual(["op-1"]);
});

test("memory: an accepted request leaves nothing behind", async () => {
  const memory = createQuickStartMemory();
  const form = createQuickStartForm({ send: fakeSender(ACCEPTED).send, onAccepted: () => {}, newOperationId: mintIds() });
  memory.attach(form);
  filled(form);
  await submitViaKeys(form);
  expect(memory.options()).toEqual({});
  expect(memory.options()).toEqual({});
});

test("memory: nothing is carried before any form exists", () => {
  expect(createQuickStartMemory().options()).toEqual({});
});

test("memory: a request still in flight at close is read when the next form opens, not as it stood at close", async () => {
  const memory = createQuickStartMemory();
  let release: (outcome: QuickStartOutcome) => void = () => {};
  const send: QuickStartSender = () => new Promise((resolve) => (release = resolve));
  const first = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds() });
  memory.attach(first);
  filled(first);
  focusSubmit(first);
  first.handleKey(ENTER); // the modal closes here, with the request still out
  expect(memory.options().initialPending?.operationId).toBe("op-1");
  release({ kind: "rejected", status: 400, code: "invalid-body", message: "no" });
  await first.settled();
  const next = memory.options();
  expect(next.initialPending).toBeUndefined();
  expect(next.initial?.description).toBe("Fix the typo");
});

test("memory: reopening while the first request is out still learns that request's outcome", async () => {
  for (const outcome of [ACCEPTED, { kind: "rejected", status: 400, code: "invalid-body", message: "no" } as QuickStartOutcome]) {
    const memory = createQuickStartMemory();
    let release: (outcome: QuickStartOutcome) => void = () => {};
    const send: QuickStartSender = () => new Promise((resolve) => (release = resolve));
    const first = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds() });
    memory.attach(first);
    filled(first);
    focusSubmit(first);
    first.handleKey(ENTER);
    const second = createQuickStartForm({ send: fakeSender(ACCEPTED).send, onAccepted: () => {}, newOperationId: mintIds(), ...memory.options() });
    memory.attach(second);
    expect(second.pendingOperation()?.operationId).toBe("op-1");
    release(outcome);
    await first.settled();
    const next = memory.options();
    if (outcome.kind === "accepted") expect(next).toEqual({});
    else {
      expect(next.initialPending).toBeUndefined();
      expect(next.initial?.description).toBe("Fix the typo");
    }
  }
});

test("pending: a form handed an unresolved operation replays the same id for the same body and mints a new one for a changed body", async () => {
  const first = fakeSender({ kind: "network", message: "connection reset" });
  const ids = mintIds();
  const earlier = createQuickStartForm({ send: first.send, onAccepted: () => {}, newOperationId: ids });
  filled(earlier);
  await submitViaKeys(earlier);
  const pending = earlier.pendingOperation()!;
  expect(pending.operationId).toBe("op-1");

  const second = fakeSender(ACCEPTED, ACCEPTED);
  const reopened = createQuickStartForm({ send: second.send, onAccepted: () => {}, newOperationId: ids, initial: earlier.draft(), initialPending: pending });
  expect(reopened.state().error?.retry).toBe(true);
  await submitViaKeys(reopened);
  expect(second.calls.map((call) => call.operationId)).toEqual(["op-1"]);
  expect(reopened.pendingOperation()).toBeUndefined();

  const edited = createQuickStartForm({ send: second.send, onAccepted: () => {}, newOperationId: ids, initial: { ...earlier.draft(), description: "A different body" }, initialPending: pending });
  await submitViaKeys(edited);
  expect(second.calls.map((call) => call.operationId)).toEqual(["op-1", "op-2"]);
});

test("lines: tail keeps the end of a long value and wrapText never exceeds the width", () => {
  expect(tail("abcdef", 4)).toBe("…def");
  expect(tail("abc", 4)).toBe("abc");
  const wrapped = wrapText("one two three four five six seven eight nine ten", 12);
  expect(wrapped.every((line) => line.length <= 12)).toBe(true);
  expect(wrapped.join(" ")).toBe("one two three four five six seven eight nine ten");
  expect(wrapText("x".repeat(30), 12).every((line) => line.length <= 12)).toBe(true);
});

// ----- the modal, on a headless renderer -----------------------------------------------------------

otuiTest("modal: opens on the mode with every mode, the questions and the footer on screen", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { height: 50 });
  const form = createQuickStartForm({ send: fakeSender(ACCEPTED).send, onAccepted: () => {}, newOperationId: mintIds() });
  const modal = openQuickStart(otui.core, h.chrome, { form, renderer: h.renderer });
  try {
    expect(modal).toBeDefined();
    await settle(h);
    const frame = h.captureCharFrame();
    for (const mode of QUICK_MODES) expect(frame).toContain(mode.label);
    for (const question of questionsFor("quick")) expect(frame).toContain(question.text);
    expect(frame).toContain("/task");
    expect(frame).toContain("Start");
    expect(frame).toContain(formatModalFooter(QUICK_START_FOOTER));
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("modal: keys alone drive it from mode to accepted, and the host closes it", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { height: 50 });
  const { send, calls } = fakeSender(ACCEPTED);
  const accepted: string[] = [];
  const form = createQuickStartForm({ send, onAccepted: (flowId) => accepted.push(flowId), newOperationId: mintIds() });
  let closed = 0;
  const modal = openQuickStart(otui.core, h.chrome, {
    form,
    renderer: h.renderer,
    onClosed: () => {
      closed += 1;
    },
  });
  try {
    await settle(h);
    await h.mockInput.pressKey("ARROW_RIGHT"); // bug
    await h.mockInput.pressEnter(); // -> description
    await h.mockInput.typeText("Login fails after reset");
    await settle(h);
    expect(h.captureCharFrame()).toContain("Login fails after reset");
    // Bug has three questions: description, 3 questions, criteria, Start is five Downs away.
    for (let i = 0; i < 5; i++) await h.mockInput.pressKey("ARROW_DOWN");
    await h.mockInput.pressEnter();
    await settle(h);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.mode).toBe("bug");
    expect(calls[0]!.body.description).toBe("Login fails after reset");
    expect(accepted).toEqual(["flow-1"]);
    expect(closed).toBe(1);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("modal: a rejection stays on screen with the input kept", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { height: 50 });
  const { send } = fakeSender({ kind: "rejected", status: 400, code: "invalid-body", message: "description is required" });
  const form = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds() });
  const modal = openQuickStart(otui.core, h.chrome, { form, renderer: h.renderer });
  try {
    await settle(h);
    await h.mockInput.pressEnter();
    await h.mockInput.typeText("Keep me");
    // Quick has two questions: description, 2 questions, criteria, Start is four Downs away.
    for (let i = 0; i < 4; i++) await h.mockInput.pressKey("ARROW_DOWN");
    await h.mockInput.pressEnter();
    await settle(h);
    const frame = h.captureCharFrame();
    expect(frame).toContain("description is required");
    expect(frame).toContain("Keep me");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("modal: Escape closes without sending and the typed draft survives in the form", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { height: 50, kittyKeyboard: true });
  const { send, calls } = fakeSender(ACCEPTED);
  const form = createQuickStartForm({ send, onAccepted: () => {}, newOperationId: mintIds() });
  let closed = 0;
  const modal = openQuickStart(otui.core, h.chrome, {
    form,
    renderer: h.renderer,
    onClosed: () => {
      closed += 1;
    },
  });
  try {
    await settle(h);
    await h.mockInput.pressEnter();
    await h.mockInput.typeText("not yet");
    h.mockInput.pressEscape();
    await settle(h);
    expect(closed).toBe(1);
    expect(calls).toHaveLength(0);
    expect(form.draft().description).toBe("not yet");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("modal: every repaint destroys the rows it replaced, not just detaches them", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { height: 50 });
  const form = createQuickStartForm({ send: fakeSender(ACCEPTED).send, onAccepted: () => {}, newOperationId: mintIds() });
  const proto = otui.core.BoxRenderable.prototype as unknown as { destroyRecursively: (this: { id: string }, ...rest: unknown[]) => unknown };
  const hadOwn = Object.prototype.hasOwnProperty.call(proto, "destroyRecursively");
  const original = proto.destroyRecursively;
  const destroyed: string[] = [];
  proto.destroyRecursively = function (this: { id: string }, ...rest: unknown[]) {
    destroyed.push(this.id);
    return original.apply(this, rest);
  };
  let modal: ReturnType<typeof openQuickStart>;
  try {
    modal = openQuickStart(otui.core, h.chrome, { form, renderer: h.renderer });
    await settle(h);
    expect(destroyed).not.toContain("qs-mode-0");
    await h.mockInput.pressKey("ARROW_DOWN");
    await settle(h);
    expect(destroyed).toContain("qs-mode-0");
    const afterOne = destroyed.length;
    await h.mockInput.pressKey("ARROW_DOWN");
    await settle(h);
    expect(destroyed.length).toBeGreaterThan(afterOne);
  } finally {
    if (hadOwn) proto.destroyRecursively = original;
    else delete (proto as { destroyRecursively?: unknown }).destroyRecursively;
    modal?.close();
    h.destroy();
  }
});
