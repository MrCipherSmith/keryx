import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, test, vi } from "vitest";
import i18n from "../src/i18n";
import workEn from "../src/i18n/work.en";
import workRu from "../src/i18n/work.ru";
import { useDraftStore } from "../src/state/drafts";
import { HubContext, type HubContextValue } from "../src/app/hub-context";
import { resetClient } from "../src/api/client";
import { ManagedWorkView } from "../src/features/managed-work/view";
import { clearQuickStartUnresolved } from "../src/features/managed-work/quick-start";
import { demoWorkAdapter } from "../src/features/managed-work/demo";
import { recordOf } from "../src/features/managed-work/model";
import type { WorkRecord } from "../src/features/managed-work/types";
import { QUICK_MODES, buildAnswers, questionsFor } from "../src/features/managed-work/quick-contract";
import { parseQuickStartBody } from "../../../src/hub/work/quick-start";

const capabilities = {
  protocolVersion: 1,
  enabled: true,
  allowedCommands: ["flow.create", "intent.create", "flow.approve-and-start"],
  limits: {},
  features: { managedExecution: false, gitObserver: false, legacyConversion: false },
};

type Step = "ok" | "forbidden" | "conflict" | "network" | "commit-then-network" | "hold";
type Posted = { key: string | null; body: Record<string, unknown> };

/** A stand-in Hub: the real body parser, idempotency by key and digest, and a snapshot that grows with each new Flow. */
function fakeHub(base: WorkRecord[]) {
  const records = [...base];
  const posts: Posted[] = [];
  const operations = new Map<string, { digest: string; response: Record<string, unknown> }>();
  const script: Step[] = [];
  let release: (() => void) | undefined;
  let flowCount = 0;
  const commit = (key: string, body: Record<string, unknown>) => {
    const digest = JSON.stringify(body);
    const known = operations.get(key);
    if (known) {
      if (known.digest !== digest) return Response.json({ error: { code: "idempotency-conflict", message: "changed" } }, { status: 409 });
      return Response.json(known.response);
    }
    flowCount += 1;
    const flow = { ...recordOf(base, "flow", "flow-demo")!, id: "flow-quick-" + flowCount, title: String(body.description) } as WorkRecord;
    records.push(flow);
    const response = { operationId: key, entities: [], eventCursor: "cursor-" + flowCount, receiptId: "receipt-" + flowCount, flowId: flow.id, intentId: "intent-quick-" + flowCount };
    operations.set(key, { digest, response });
    return Response.json(response);
  };
  const handle = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/capabilities")) return Response.json(capabilities);
    if (url.includes("/snapshot")) return Response.json({ records, eventCursor: "cursor", nextCursor: null });
    if (url.endsWith("/quick-start") && init?.method === "POST") {
      const key = new Headers(init.headers).get("Idempotency-Key");
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ key, body });
      try {
        parseQuickStartBody(body);
      } catch {
        return Response.json({ error: { code: "invalid-body", message: "bad body" } }, { status: 400 });
      }
      const step = script.shift() ?? "ok";
      if (step === "forbidden") return Response.json({ error: { code: "human-required", message: "no" } }, { status: 403 });
      if (step === "conflict") return Response.json({ error: { code: "idempotency-conflict", message: "changed" } }, { status: 409 });
      if (step === "network") throw new TypeError("offline");
      if (step === "commit-then-network") {
        commit(key!, body);
        throw new TypeError("offline");
      }
      if (step === "hold") await new Promise<void>((resolve) => (release = resolve));
      return commit(key!, body);
    }
    return Response.json({ error: { code: "not-found" } }, { status: 404 });
  };
  return { posts, script, flows: () => records.filter((r) => r.kind === "flow").length, created: () => flowCount, release: () => release?.(), handle };
}

let hub: ReturnType<typeof fakeHub>;
beforeEach(async () => {
  resetClient();
  clearQuickStartUnresolved();
  useDraftStore.getState().clearAll();
  await i18n.changeLanguage("en");
  hub = fakeHub((await demoWorkAdapter("p").snapshot()).records);
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => hub.handle(input, init));
});

function show(kind: "human" | "agent" = "human") {
  const value: HubContextValue = {
    principal: { id: kind + ":test", kind, role: "operator" },
    projectId: "p",
    scopeKey: 7,
    location: { projectId: "p", tab: "work" },
    navigate: vi.fn(),
    refresh: async () => undefined,
  };
  function Scope() {
    const [location, setLocation] = useState(value.location);
    return (
      <HubContext.Provider value={{ ...value, location, navigate: (patch) => setLocation((old) => ({ ...old, ...patch })) }}>
        <ManagedWorkView />
      </HubContext.Provider>
    );
  }
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Scope />
    </QueryClientProvider>,
  );
}
const open = async () => {
  const button = await screen.findByRole("button", { name: "New task" });
  fireEvent.click(button);
  return screen.findByRole("dialog", { name: "New task" });
};
const describe_ = (text: string) => fireEvent.change(screen.getByLabelText("What needs doing?"), { target: { value: text } });
const submit = () => screen.getByRole("button", { name: "Start task" });
const closed = () => expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

describe("quick start dialog, state and event matrix", () => {
  test("open: the dialog opens with focus on the chosen mode", async () => {
    show();
    const dialog = await open();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const mode = within(dialog).getByRole("radio", { name: /Task/ });
    expect(mode).toBeChecked();
    expect(mode).toHaveFocus();
  });

  test("the button is hidden from a human whose capabilities lack the three commands it composes", async () => {
    const original = capabilities.allowedCommands;
    capabilities.allowedCommands = ["flow.create"];
    try {
      show();
      await screen.findByRole("button", { name: "Refresh" });
      expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
    } finally {
      capabilities.allowedCommands = original;
    }
  });

  test("the button is offered to humans only, never to an agent principal", async () => {
    show("agent");
    await screen.findByText("Connected to work API");
    await screen.findByRole("button", { name: "Refresh" });
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
  });

  test("mode chosen: submit stays disabled until the description has text", async () => {
    show();
    await open();
    expect(submit()).toBeDisabled();
    describe_("   ");
    expect(submit()).toBeDisabled();
    describe_("Fix the login redirect");
    expect(submit()).toBeEnabled();
    describe_("");
    expect(submit()).toBeDisabled();
  });

  test.each(QUICK_MODES.map((mode) => [mode.id] as const))("questions shown: %s has one skippable field per template question", async (id) => {
    show();
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("radio", { name: new RegExp(workEn.quickStart.modes[id]) }));
    const questions = questionsFor(id);
    const fields = within(dialog).getAllByRole("textbox", { name: (name) => questions.some((q) => name === workEn.quickStart.questions[q.id as keyof typeof workEn.quickStart.questions]) });
    expect(fields).toHaveLength(questions.length);
    expect(within(dialog).getAllByRole("checkbox", { name: /^Skip: / })).toHaveLength(questions.length);
    for (const question of questions) expect(within(dialog).getByRole("textbox", { name: workEn.quickStart.questions[question.id as keyof typeof workEn.quickStart.questions] })).toBeInTheDocument();
    for (const criterion of QUICK_MODES.find((mode) => mode.id === id)!.criteriaTemplate) expect(within(dialog).getByText(criterion)).toBeInTheDocument();
  });

  test("submit sends one operation id and disables; a second click sends nothing", async () => {
    hub.script.push("hold");
    show();
    await open();
    describe_("Fix the login redirect");
    fireEvent.change(screen.getByRole("textbox", { name: workEn.quickStart.questions["desired-outcome"] }), { target: { value: "Users land on the page they asked for" } });
    fireEvent.change(screen.getByLabelText("Your own acceptance criteria · one per line"), { target: { value: "Redirect survives a refresh\n\n  Works behind the proxy  " } });
    fireEvent.click(submit());
    await waitFor(() => expect(hub.posts).toHaveLength(1));
    expect(submit()).toBeDisabled();
    fireEvent.click(submit());
    fireEvent.submit(submit().closest("form")!);
    expect(hub.posts).toHaveLength(1);
    const [post] = hub.posts;
    expect(post!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(post!.body).toEqual({
      mode: "task",
      description: "Fix the login redirect",
      answers: buildAnswers("task", { "desired-outcome": "Users land on the page they asked for" }),
      criteria: ["Redirect survives a refresh", "Works behind the proxy"],
    });
    expect(Object.keys(post!.body).sort()).toEqual(["answers", "criteria", "description", "mode"]);
    hub.release();
    await waitFor(closed);
  });

  test("server accepts: the dialog closes and the new Flow is in the work view", async () => {
    show();
    await open();
    describe_("Fix the login redirect");
    fireEvent.click(submit());
    await waitFor(closed);
    expect((await screen.findAllByText("Fix the login redirect")).length).toBeGreaterThan(0);
    expect(hub.created()).toBe(1);
  });

  test("replay: the same operation id returns the stored receipt and creates no second Flow", async () => {
    hub.script.push("commit-then-network");
    show();
    await open();
    describe_("Fix the login redirect");
    fireEvent.click(submit());
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(closed);
    expect(hub.posts).toHaveLength(2);
    expect(hub.posts[1]!.key).toBe(hub.posts[0]!.key);
    expect(hub.created()).toBe(1);
    expect((await screen.findAllByText("Fix the login redirect")).length).toBeGreaterThan(0);
  });

  test.each([
    ["forbidden", "human-required"],
    ["conflict", "idempotency-conflict"],
  ] as const)("server rejects (%s): the error is shown in the dialog and the input is kept", async (step, code) => {
    hub.script.push(step);
    show();
    await open();
    describe_("Fix the login redirect");
    fireEvent.change(screen.getByLabelText("Your own acceptance criteria · one per line"), { target: { value: "Keep me" } });
    fireEvent.click(submit());
    const alert = await within(screen.getByRole("dialog")).findByRole("alert");
    expect(alert).toHaveTextContent(code);
    expect(screen.getByLabelText("What needs doing?")).toHaveValue("Fix the login redirect");
    expect(screen.getByLabelText("Your own acceptance criteria · one per line")).toHaveValue("Keep me");
    expect(submit()).toBeEnabled();
    expect(hub.created()).toBe(0);
    fireEvent.click(submit());
    await waitFor(closed);
    expect(hub.posts).toHaveLength(2);
    expect(hub.posts[1]!.key).not.toBe(hub.posts[0]!.key);
    expect(hub.created()).toBe(1);
  });

  test("network lost: the error offers retry, the input is kept, and retry reuses the same operation id", async () => {
    hub.script.push("network");
    show();
    await open();
    describe_("Fix the login redirect");
    fireEvent.click(submit());
    const alert = await within(screen.getByRole("dialog")).findByRole("alert");
    expect(alert).toHaveTextContent("network-error");
    expect(screen.getByLabelText("What needs doing?")).toHaveValue("Fix the login redirect");
    expect(submit()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(closed);
    expect(hub.posts).toHaveLength(2);
    expect(hub.posts[1]!.key).toBe(hub.posts[0]!.key);
    expect(hub.posts[1]!.body).toEqual(hub.posts[0]!.body);
    expect(hub.created()).toBe(1);
  });

  test("network lost: starting over drops the pending request and uses a new operation id", async () => {
    hub.script.push("network");
    show();
    await open();
    describe_("Fix the login redirect");
    fireEvent.click(submit());
    await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(screen.getByText(workEn.quickStart.startOverWarning)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: workEn.quickStart.startOverConfirm }));
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    describe_("Fix the login redirect again");
    fireEvent.click(submit());
    await waitFor(closed);
    expect(hub.posts[1]!.key).not.toBe(hub.posts[0]!.key);
  });

  test("network lost: Back to retry on the start-over warning goes back to retry with the same operation id", async () => {
    hub.script.push("network");
    show();
    await open();
    describe_("Fix the login redirect");
    fireEvent.click(submit());
    await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    fireEvent.click(screen.getByRole("button", { name: workEn.quickStart.startOverKeep }));
    expect(screen.queryByText(workEn.quickStart.startOverWarning)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(closed);
    expect(hub.posts[1]!.key).toBe(hub.posts[0]!.key);
    expect(hub.created()).toBe(1);
  });

  test("an unresolved request survives closing the dialog and unmounting the view: retry replays the same operation id", async () => {
    hub.script.push("commit-then-network");
    const first = show();
    await open();
    describe_("Fix the login redirect");
    fireEvent.click(submit());
    await screen.findByRole("button", { name: "Retry" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    closed();
    first.unmount();
    show();
    await open();
    expect(screen.getByLabelText("What needs doing?")).toHaveValue("Fix the login redirect");
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(closed);
    expect(hub.posts).toHaveLength(2);
    expect(hub.posts[1]!.key).toBe(hub.posts[0]!.key);
    expect(hub.created()).toBe(1);
  });

  test("a request still in flight when the view unmounts comes back as an interrupted operation, never a blank error", async () => {
    hub.script.push("hold");
    const first = show();
    await open();
    describe_("Fix the login redirect");
    fireEvent.click(submit());
    await waitFor(() => expect(hub.posts).toHaveLength(1));
    first.unmount();
    show();
    await open();
    const alert = await within(screen.getByRole("dialog")).findByRole("alert");
    expect(alert).toHaveTextContent(workEn.quickStart.interrupted);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(closed);
    hub.release();
    expect(hub.posts[1]!.key).toBe(hub.posts[0]!.key);
    expect(hub.created()).toBe(1);
  });

  test("signing out forgets an unresolved operation, so the next principal never sees it", async () => {
    hub.script.push("network");
    const first = show();
    await open();
    describe_("Fix the login redirect");
    fireEvent.click(submit());
    await screen.findByRole("button", { name: "Retry" });
    first.unmount();
    clearQuickStartUnresolved();
    useDraftStore.getState().clearAll();
    show();
    await open();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("What needs doing?")).toHaveValue("");
  });

  test("focus stays inside the dialog after the Retry notice unmounts", async () => {
    hub.script.push("network");
    show();
    const dialog = await open();
    describe_("Fix the login redirect");
    fireEvent.click(submit());
    await screen.findByRole("button", { name: "Retry" });
    screen.getByRole("button", { name: "Start over" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    fireEvent.click(screen.getByRole("button", { name: workEn.quickStart.startOverConfirm }));
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(document.body);
  });

  test("while a request is unresolved, Tab never leaves the dialog even though the form fields are disabled", async () => {
    hub.script.push("network");
    show();
    const dialog = await open();
    describe_("Fix the login redirect");
    fireEvent.click(submit());
    await screen.findByRole("button", { name: "Retry" });
    const enabled = [...dialog.querySelectorAll<HTMLElement>("button, input, textarea, select")].filter((el) => !el.matches(":disabled"));
    expect(enabled.length).toBeGreaterThan(0);
    const last = enabled[enabled.length - 1]!;
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(enabled[0]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(closed);
  });

  test("Escape closes without sending, keeps the draft, and returns focus to the button", async () => {
    show();
    await open();
    describe_("Fix the login redirect");
    fireEvent.change(screen.getByRole("textbox", { name: workEn.quickStart.questions["desired-outcome"] }), { target: { value: "Draft answer" } });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    closed();
    expect(hub.posts).toHaveLength(0);
    expect(screen.getByRole("button", { name: "New task" })).toHaveFocus();
    await open();
    expect(screen.getByLabelText("What needs doing?")).toHaveValue("Fix the login redirect");
    expect(screen.getByRole("textbox", { name: workEn.quickStart.questions["desired-outcome"] })).toHaveValue("Draft answer");
    expect(hub.posts).toHaveLength(0);
  });

  test("a submitted draft is cleared, so the next dialog starts empty", async () => {
    show();
    await open();
    describe_("Fix the login redirect");
    fireEvent.click(submit());
    await waitFor(closed);
    await open();
    expect(screen.getByLabelText("What needs doing?")).toHaveValue("");
  });

  test("skipped form: skipping every question is sent as skipped true with a null answer", async () => {
    show();
    await open();
    describe_("Fix the login redirect");
    fireEvent.change(screen.getByRole("textbox", { name: workEn.quickStart.questions["desired-outcome"] }), { target: { value: "Typed but then skipped" } });
    fireEvent.click(screen.getByRole("button", { name: "Skip all questions" }));
    for (const field of screen.getAllByRole("checkbox", { name: /^Skip: / })) expect(field).toBeChecked();
    fireEvent.click(submit());
    await waitFor(closed);
    expect(hub.posts[0]!.body.answers).toEqual(questionsFor("task").map((q) => ({ q: q.id, a: null, skipped: true })));
  });

  test("skipping one question keeps the others answered", async () => {
    show();
    await open();
    describe_("Fix the login redirect");
    fireEvent.change(screen.getByRole("textbox", { name: workEn.quickStart.questions["desired-outcome"] }), { target: { value: "Answered" } });
    fireEvent.change(screen.getByRole("textbox", { name: workEn.quickStart.questions.constraints }), { target: { value: "Dropped" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Skip: " + workEn.quickStart.questions.constraints }));
    expect(screen.getByRole("textbox", { name: workEn.quickStart.questions.constraints })).toBeDisabled();
    fireEvent.click(submit());
    await waitFor(closed);
    expect(hub.posts[0]!.body.answers).toEqual([
      { q: "desired-outcome", a: "Answered", skipped: false },
      { q: "constraints", a: null, skipped: true },
      { q: "done-check", a: null, skipped: true },
    ]);
  });
});

describe("quick start dialog, keyboard", () => {
  const controls = (dialog: HTMLElement) =>
    [...dialog.querySelectorAll<HTMLElement>("button, input, textarea, select, [tabindex]")].filter((el) => !el.hasAttribute("disabled"));

  test("tab order follows the form: mode, description, questions with their skip, criteria, then actions", async () => {
    show();
    const dialog = await open();
    describe_("Fix the login redirect");
    const order = controls(dialog).map((el) => el.getAttribute("aria-label") ?? (el as HTMLInputElement).labels?.[0]?.textContent ?? el.textContent ?? "");
    const at = (text: string) => order.findIndex((entry) => entry.includes(text));
    expect(controls(dialog).every((el) => !(Number(el.getAttribute("tabindex")) > 0))).toBe(true);
    const sequence = ["Quick", "Task", "What needs doing?", "Skip all questions", workEn.quickStart.questions["desired-outcome"], "Skip: " + workEn.quickStart.questions["desired-outcome"], "Your own acceptance criteria", "Cancel", "Start task"].map(at);
    expect(sequence.every((index) => index >= 0)).toBe(true);
    expect([...sequence]).toEqual([...sequence].sort((a, b) => a - b));
  });

  test("tab wraps inside the dialog in both directions", async () => {
    show();
    const dialog = await open();
    describe_("Fix the login redirect");
    // An unchecked radio is not a tab stop: its group is entered at the checked one.
    const all = controls(dialog).filter((el) => !(el instanceof HTMLInputElement && el.type === "radio" && !el.checked));
    const first = all[0]!;
    const last = all[all.length - 1]!;
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  test("Enter in the description submits once it has text, and does nothing while empty", async () => {
    show();
    await open();
    const field = screen.getByLabelText("What needs doing?");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(hub.posts).toHaveLength(0);
    describe_("Fix the login redirect");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(closed);
    expect(hub.posts).toHaveLength(1);
  });

  test("Escape inside a field closes the dialog without sending", async () => {
    show();
    await open();
    describe_("Fix the login redirect");
    fireEvent.keyDown(screen.getByLabelText("What needs doing?"), { key: "Escape" });
    closed();
    expect(hub.posts).toHaveLength(0);
  });
});

describe("quick start strings", () => {
  const leaves = (value: unknown, prefix = ""): Record<string, string> => {
    if (typeof value === "string") return { [prefix]: value };
    if (typeof value !== "object" || value === null) throw new Error("Unsupported locale value");
    return Object.assign({}, ...Object.entries(value).map(([key, item]) => leaves(item, prefix ? prefix + "." + key : key)));
  };
  const variables = (text: string) => [...text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((match) => match[1]).sort();

  test("RU and EN define the same non-empty keys with the same variables", () => {
    const en = leaves(workEn.quickStart);
    const ru = leaves(workRu.quickStart);
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim()).not.toBe("");
      expect(ru[key]!.trim()).not.toBe("");
      expect(variables(ru[key]!)).toEqual(variables(value));
    }
  });

  test("every shared mode and template question has a label in both languages", () => {
    for (const [name, dictionary] of [["en", workEn], ["ru", workRu]] as const) {
      const strings = leaves(dictionary.quickStart);
      for (const mode of QUICK_MODES) {
        expect(strings["modes." + mode.id], name + " mode " + mode.id).toBeTruthy();
        for (const question of questionsFor(mode.id)) expect(strings["questions." + question.id], name + " question " + question.id).toBeTruthy();
      }
    }
  });

  test("every template criterion has a translation, and the Russian dialog shows it while the Hub keeps the canonical text", async () => {
    const ru = leaves(workRu.quickStart);
    const en = leaves(workEn.quickStart);
    for (const mode of QUICK_MODES) {
      mode.criteriaTemplate.forEach((criterion, index) => {
        expect(en["criteriaTemplates." + mode.id + "." + index], "en " + mode.id + " " + index).toBe(criterion);
        expect(ru["criteriaTemplates." + mode.id + "." + index], "ru " + mode.id + " " + index).toBeTruthy();
      });
    }
    await i18n.changeLanguage("ru");
    show();
    fireEvent.click(await screen.findByRole("button", { name: workRu.quickStart.open }));
    const dialog = await screen.findByRole("dialog");
    const task = QUICK_MODES.find((mode) => mode.id === "task")!;
    expect(within(dialog).getByText(ru["criteriaTemplates.task.0"]!)).toBeInTheDocument();
    expect(within(dialog).queryByText(task.criteriaTemplate[0]!)).not.toBeInTheDocument();
    expect(within(dialog).getByText(workRu.quickStart.templateCriteriaNote)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(workRu.quickStart.description), { target: { value: "Починить вход" } });
    fireEvent.click(within(dialog).getByRole("button", { name: workRu.quickStart.submit }));
    await waitFor(closed);
    // The template is not sent: the Hub prepends its own English wording, so what is stored never depends on the UI language.
    expect(hub.posts[0]!.body.criteria).toEqual([]);
    await i18n.changeLanguage("en");
  });

  test.each(["en", "ru"])("the open dialog in %s shows no untranslated key", async (language) => {
    await i18n.changeLanguage(language);
    show();
    const button = await screen.findByRole("button", { name: language === "en" ? "New task" : workRu.quickStart.open });
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog");
    for (const mode of QUICK_MODES) {
      fireEvent.click(within(dialog).getByRole("radio", { name: new RegExp(leaves(language === "en" ? workEn.quickStart : workRu.quickStart)["modes." + mode.id]) }));
      expect(dialog.textContent).not.toMatch(/quickStart\./);
    }
    fireEvent.change(within(dialog).getByLabelText(language === "en" ? "What needs doing?" : workRu.quickStart.description), { target: { value: "x" } });
    fireEvent.click(within(dialog).getByRole("button", { name: language === "en" ? "Start task" : workRu.quickStart.submit }));
    await waitFor(closed);
    await i18n.changeLanguage("en");
  });
});
