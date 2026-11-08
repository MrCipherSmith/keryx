import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { useState } from "react";
import type { LiveShellDelivery, LiveShellDetail, LiveShellSummary } from "../../../src/remote-control/live-shell";
import { resetClient } from "../src/api/client";
import { HubContext, type HubContextValue } from "../src/app/hub-context";
import { LiveShells } from "../src/features/remote/live-shells";
import i18n from "../src/i18n";
import { useDraftStore } from "../src/state/drafts";
import { renderHub } from "./hub-render";

const projectId = "p";
const listPath = "/hub/v2/projects/p/live-shells";
const shell: LiveShellSummary = {
  id: "shell", title: "Terminal conversation", machineName: "geekom",
  checkoutId: "fixture", busy: false, stopTurnId: null,
};
const context: HubContextValue = {
  projectId, scopeKey: 1,
  principal: { id: "human:test", kind: "human", role: "operator" },
  location: { tab: "sessions", projectId },
  navigate: () => undefined, refresh: async () => undefined,
};

let detail: LiveShellDetail;
let sends: string[];
let reads: (string | null)[];
let releases: number;
let loseReceipt: boolean;
let messageStatus: LiveShellDelivery["status"];
let operations: Map<string, LiveShellDelivery>;
let claims: string[];
let owner: string | null;
let stops: { key: string; turnId: string }[];
let chatOperations: Array<{ route: string; payload: unknown }>;

beforeEach(async () => {
  resetClient();
  useDraftStore.getState().clearAll();
  await i18n.changeLanguage("en");
  detail = {
    shell, controllerHeld: false, delivery: null,
    messages: [{ role: "user", text: "Already said in the terminal" }, { role: "assistant", text: "Previously answered here" }],
  };
  sends = [];
  reads = [];
  releases = 0;
  loseReceipt = false;
  messageStatus = "applied";
  operations = new Map();
  claims = [];
  owner = null;
  stops = [];
  chatOperations = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "https://hub.invalid");
    const path = url.pathname;
    if (path === listPath) return Response.json({ shells: [detail.shell] });
    if (path === listPath + "/shell") {
      const id = url.searchParams.get("operationId");
      reads.push(id);
      return Response.json({ ...detail, controllerHeld: !!owner, delivery: id ? operations.get(id) ?? null : detail.delivery });
    }
    const body = JSON.parse(String(init?.body)) as { clientId: string; text?: string; turnId?: string };
    if (path === listPath + "/shell/claim") {
      claims.push(body.clientId);
      if (owner && owner !== body.clientId) return Response.json({ error: { code: "controller-conflict" } }, { status: 409 });
      owner = body.clientId;
      return Response.json({ ok: true });
    }
    if (path === listPath + "/shell/release") {
      releases++;
      if (owner === body.clientId) owner = null;
      return Response.json({ ok: true });
    }
    if (path === listPath + "/shell/message") {
      if (owner !== body.clientId) return Response.json({ error: { code: "controller-conflict" } }, { status: 409 });
      const key = new Headers(init?.headers).get("Idempotency-Key")!;
      const operationId = "operation-" + key;
      if (!operations.has(operationId)) {
        detail.delivery = { id: operationId, kind: "message", status: messageStatus };
        operations.set(operationId, detail.delivery);
        if (messageStatus === "applied") detail.messages = [...detail.messages, { role: "user", text: body.text! }];
      }
      sends.push(key);
      if (loseReceipt && sends.length === 1) throw new TypeError("connection lost after acceptance");
      return Response.json({ operationId });
    }
    if (path === listPath + "/shell/stop") {
      const key = new Headers(init?.headers).get("Idempotency-Key")!;
      stops.push({ key, turnId: body.turnId! });
      const operationId = "operation-" + key;
      if (!operations.has(operationId)) {
        expect(body.turnId).toBe(detail.shell.stopTurnId);
        detail.delivery = { id: operationId, kind: "stop", status: "applied" };
        operations.set(operationId, detail.delivery);
      }
      if (loseReceipt && stops.length === 1) {
        detail.shell = { ...shell, busy: true, stopTurnId: "turn-B" };
        throw new TypeError("connection lost after acceptance");
      }
      return Response.json({ operationId });
    }
    const route = path.slice((listPath + "/shell/").length);
    if (route === "invoke" || route === "select-model" || route === "answer-approval" || route === "answer-question") {
      if (owner !== body.clientId) return Response.json({ error: { code: "controller-conflict" } }, { status: 409 });
      const key = new Headers(init?.headers).get("Idempotency-Key")!;
      const operationId = "operation-" + key;
      chatOperations.push({ route, payload: body });
      const output = route === "invoke" ? "Command output from terminal" : undefined;
      detail.delivery = { id: operationId, kind: route, status: "applied", ...(output ? { output } : {}) };
      operations.set(operationId, detail.delivery);
      if (route === "select-model" && detail.context?.model) detail.context.model.currentId = "next-model";
      if (route === "answer-approval" && detail.context) delete detail.context.approval;
      if (route === "answer-question" && detail.context) delete detail.context.question;
      return Response.json({ operationId });
    }
    return Response.json({}, { status: 404 });
  });
});

function ShellBrowser({ scopeKey = context.scopeKey }: { scopeKey?: number }) {
  const [location, setLocation] = useState(context.location);
  return <HubContext.Provider value={{
    ...context, scopeKey, location,
    navigate: patch => setLocation(previous => ({ ...previous, ...patch })),
  }}>
    <LiveShells projectId={projectId} />
  </HubContext.Provider>;
}

async function openChat() {
  renderHub(<ShellBrowser />, context);
  fireEvent.click(await screen.findByRole("button", { name: "Connect to Terminal conversation" }));
  expect(await screen.findByText("Already said in the terminal")).toBeInTheDocument();
  expect(screen.getByText("Previously answered here")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Claim control" })).not.toBeInTheDocument();
  return screen.getByRole("textbox", { name: "Message" });
}

test("connects to the existing terminal history and releases only the browser on disconnect", async () => {
  const composer = await openChat();
  expect(claims).toHaveLength(0);
  expect(screen.queryByText("Usage")).not.toBeInTheDocument();
  fireEvent.change(composer, { target: { value: "From Hub" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByText("From Hub", { selector: "pre" })).toBeInTheDocument();
  await waitFor(() => expect(composer).toHaveValue(""));
  expect(reads).toContain("operation-" + sends[0]);
  expect(claims).toHaveLength(1);
  fireEvent.click(screen.getByLabelText("Session actions"));
  fireEvent.click(screen.getByRole("button", { name: "Disconnect from shell" }));
  expect(await screen.findByRole("button", { name: "Connect to Terminal conversation" })).toBeInTheDocument();
  expect(releases).toBe(1);
});

test("updates one assistant preview and replaces it with one completed reply", async () => {
  await openChat();
  detail.shell = { ...shell, busy: true, stopTurnId: "stream-turn" };
  detail.preview = "First words";
  const partial = await screen.findByText("First words", {}, { timeout: 2_500 });
  expect(partial.closest("li")).toHaveAttribute("data-chat-stream", "true");
  detail.preview = "First words and more";
  const extended = await screen.findByText("First words and more", {}, { timeout: 2_500 });
  expect(extended.closest("li")).toBe(partial.closest("li"));
  detail.shell = shell;
  delete detail.preview;
  detail.messages = [...detail.messages, { role: "assistant", text: "First words and more, done." }];
  const final = await screen.findByText("First words and more, done.", {}, { timeout: 2_500 });
  expect(final.closest("li")).not.toHaveAttribute("data-chat-stream");
  expect(screen.queryByText("First words and more")).not.toBeInTheDocument();
});

test("retries an uncertain send with the same operation key and clears the draft only after acknowledgement", async () => {
  loseReceipt = true;
  const composer = await openChat();
  fireEvent.change(composer, { target: { value: "One message only" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByRole("button", { name: "Retry the same request" })).toBeEnabled();
  expect(composer).toHaveValue("One message only");
  fireEvent.click(screen.getByRole("button", { name: "Retry the same request" }));
  await waitFor(() => expect(composer).toHaveValue(""));
  expect(sends).toHaveLength(2);
  expect(sends[0]).toBe(sends[1]);
  expect(detail.messages.filter(message => message.text === "One message only")).toHaveLength(1);
});

test("keeps rejected text editable once the shell reports it was rejected", async () => {
  messageStatus = "rejected";
  const composer = await openChat();
  fireEvent.change(composer, { target: { value: "Keep this draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByText("The shell rejected the request.")).toBeInTheDocument();
  await waitFor(() => expect(composer).not.toHaveAttribute("readonly"));
  expect(composer).toHaveValue("Keep this draft");
  expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
});

test("only the matching operation acknowledgement can clear the draft", async () => {
  messageStatus = "pending";
  const composer = await openChat();
  fireEvent.change(composer, { target: { value: "My own pending message" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByText("Waiting for the shell to accept the request.")).toBeInTheDocument();
  const id = "operation-" + sends[0];
  detail.delivery = { id: "another-tabs-operation", kind: "message", status: "applied" };
  await waitFor(() => expect(reads.filter(value => value === id).length).toBeGreaterThan(1), { timeout: 2_500 });
  expect(composer).toHaveValue("My own pending message");
  expect(screen.queryByText("The shell accepted the request.")).not.toBeInTheDocument();
  operations.set(id, { id, kind: "message", status: "applied" });
  await waitFor(() => expect(composer).toHaveValue(""), { timeout: 2_500 });
  expect(screen.getByText("The shell accepted the request.")).toBeInTheDocument();
});

test("another browser using the same operator can read history and claim after release", async () => {
  const first = await openChat();
  fireEvent.change(first, { target: { value: "Take control by sending" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(first).toHaveValue(""));
  const other = renderHub(<ShellBrowser scopeKey={2} />, context);
  const browser = within(other.container);
  fireEvent.click(await browser.findByRole("button", { name: "Connect to Terminal conversation" }));
  expect(await browser.findByText("Previously answered here")).toBeInTheDocument();
  expect(browser.getByText(/Another browser holds control/)).toBeVisible();
  fireEvent.change(browser.getByRole("textbox", { name: "Message" }), { target: { value: "Keep in other browser" } });
  expect(browser.getByRole("button", { name: "Send message" })).toBeDisabled();
  fireEvent.click(screen.getAllByLabelText("Session actions")[0]);
  fireEvent.click(screen.getByRole("button", { name: "Release control" }));
  const send = browser.getByRole("button", { name: "Send message" });
  await waitFor(() => expect(send).toBeEnabled(), { timeout: 2_500 });
  fireEvent.click(send);
  await waitFor(() => expect(browser.getByRole("textbox", { name: "Message" })).toHaveValue(""));
  expect(claims).toHaveLength(2);
  expect(claims[0]).not.toBe(claims[1]);
});

test("retries a lost Stop receipt for the original turn even when the shell has started another", async () => {
  detail.shell = { ...shell, busy: true, stopTurnId: "turn-A" };
  loseReceipt = true;
  await openChat();
  fireEvent.click(screen.getByRole("button", { name: "Stop response" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry the same request" }));
  expect(await screen.findByText("The shell accepted the request.")).toBeInTheDocument();
  expect(stops).toEqual([
    { key: expect.any(String), turnId: "turn-A" },
    { key: stops[0]?.key, turnId: "turn-A" },
  ]);
});

test("slash commands return output to history, models change on acknowledgement and usage shows measured counts", async () => {
  const usage = { tokensIn: 1234, tokensOut: 24, cacheRead: 200, cacheWrite: 10, activeMs: 3500 };
  detail.context = {
    model: { currentId: "current-model", candidates: [
      { id: "current-model", label: "Provider / current" },
      { id: "next-model", label: "Provider / next" },
    ] },
    commands: [{ name: "status", description: "Show terminal status" }],
    usage: { turn: usage, session: usage },
  };
  const composer = await openChat();
  fireEvent.keyDown(composer, { key: "/" });
  expect(screen.getByRole("searchbox", { name: "Search Keryx commands" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: /\/status/ }));
  expect(await within(screen.getByRole("region", { name: "History" })).findByText("Command output from terminal")).toBeVisible();
  expect(composer).toHaveValue("");
  const model = screen.getByRole("combobox", { name: "Model" });
  fireEvent.change(model, { target: { value: "next-model" } });
  await waitFor(() => expect(model).toHaveValue("next-model"));
  fireEvent.click(screen.getByText("Usage"));
  expect(screen.getAllByText("1,234")).toHaveLength(2);
  expect(screen.getAllByText("3.5 s")).toHaveLength(2);
  expect(chatOperations).toEqual([
    { route: "invoke", payload: { clientId: expect.any(String), name: "status" } },
    { route: "select-model", payload: { clientId: expect.any(String), candidateId: "next-model" } },
  ]);
});

test("the pending shell approval sits above the composer and answers the exact question", async () => {
  detail.context = { phase: "waiting-input", approval: {
    id: "approval-A", tool: "shell_exec", summary: "pwd", reason: "Command execution needs approval", canAnswer: true,
  } };
  detail.shell = { ...shell, busy: true, stopTurnId: "turn-A" };
  const composer = await openChat();
  const dock = composer.closest(".chat-dock") as HTMLElement;
  expect(within(dock).getByText("Command execution needs approval")).toBeVisible();
  const approve = within(dock).getByRole("button", { name: "Allow once" });
  expect(approve.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(approve);
  await waitFor(() => expect(within(dock).queryByRole("button", { name: "Allow once" })).not.toBeInTheDocument());
  expect(chatOperations).toEqual([{
    route: "answer-approval", payload: { clientId: expect.any(String), approvalId: "approval-A", decision: "allow" },
  }]);
});

test("a shell question accepts an answer from the browser without a separate claim", async () => {
  detail.context = { phase: "waiting-input", question: {
    id: "question-A", text: "Which plan should I use?", canAnswer: true,
    options: [{ label: "Plan A", description: "Read the files" }, { label: "Plan B", description: "Run the test" }],
  } };
  detail.shell = { ...shell, busy: true, stopTurnId: "turn-A" };
  const composer = await openChat();
  const dock = composer.closest(".chat-dock") as HTMLElement;
  expect(within(dock).getByText("Which plan should I use?")).toBeVisible();
  fireEvent.click(within(dock).getByRole("button", { name: /Plan B/ }));
  await waitFor(() => expect(within(dock).queryByText("Which plan should I use?")).not.toBeInTheDocument());
  expect(chatOperations).toEqual([{
    route: "answer-question", payload: { clientId: expect.any(String), questionId: "question-A", answer: { option: 1 } },
  }]);
});

test("renders a terminal reply with a Markdown table as a table", async () => {
  detail.messages.push({ role: "assistant", text: "| PR | State |\n| --- | --- |\n| 1154 | Merged |" });
  await openChat();
  const table = within(screen.getByRole("region", { name: "History" })).getByRole("table");
  expect(within(table).getByRole("columnheader", { name: "State" })).toBeVisible();
  expect(within(table).getByRole("cell", { name: "Merged" })).toBeVisible();
});
