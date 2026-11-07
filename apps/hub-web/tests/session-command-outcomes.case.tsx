import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, test, vi } from "vitest";
import i18n from "../src/i18n";
import { HubContext, type HubContextValue } from "../src/app/hub-context";
import { SessionsView } from "../src/features/remote";
import { useDraftStore } from "../src/state/drafts";
import { resetClient } from "../src/api/client";
import { navigate, useLocation } from "../src/app/navigation";
import { sessionFixture, machineFixture } from "./remote-fixtures";
import type { Control } from "../src/api/remote";
// The real Commands panel runs here; only the network is faked. The machine clock on the messages is
// deliberately far from the browser clock: placement must follow the history cursor, not the clocks.
const entry = (commandName: string) => ({
  commandName, summary: commandName, handlerId: commandName,
  inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
  resultSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
  mutationClass: "read", states: ["idle", "busy", "paused"], busyPolicy: "read-only", confirmation: "none",
  availability: "available", reason: "none",
}) as unknown as Control["CommandCatalogueEntry"];
const outcome = (operationId: string, commandName: string, status: string) =>
  ({ operationId, sessionId: "s", commandName, status, errorCode: null, result: null }) as unknown as Control["CommandOutcome"];
const message = (n: number, role: "human" | "assistant", createdAt: string, text: string) =>
  ({ messageId: "m" + n, role, text, createdAt, historyCursor: n, runId: null }) as unknown as Control["SessionMessage"];
let messages: Control["SessionMessage"][] = [];
let claimed = false;
let appliedOperations = new Set<string>();
let invokeCount = 0;
let pagedHistory = false;
let failHistory = false;
let onInvoke: (() => void) | undefined;
const fetched: string[] = [];
function Harness() {
  const location = useLocation();
  const ctx = { projectId: "p", principal: { id: "human:test", kind: "human", role: "operator" }, scopeKey: 2, location, navigate, refresh: async () => undefined } as HubContextValue;
  return <HubContext.Provider value={ctx}><SessionsView /></HubContext.Provider>;
}
beforeEach(async () => {
  resetClient();
  useDraftStore.getState().clearAll();
  await i18n.changeLanguage("en");
  claimed = false;
  invokeCount = 0;
  pagedHistory = false;
  failHistory = false;
  onInvoke = undefined;
  fetched.length = 0;
  appliedOperations = new Set();
  // The machine's clock is years ahead of this browser.
  messages = [message(1, "human", "2099-01-01T00:00:00Z", "first message")];
  navigate({ projectId: "p", tab: "sessions", sessionId: "s" }, true);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = String(url);
    fetched.push(path);
    if (path.endsWith("/controller/claim")) { claimed = true; return Response.json({ receiptId: "claimed", sessionVersion: 3, lease: sessionFixture.controller }); }
    if (path.includes("/controller-claims/")) return Response.json({ applied: claimed });
    if (path.endsWith("/machines?projectId=p")) return Response.json({ machines: [machineFixture] });
    if (path.endsWith("/chat-consent")) return Response.json({ profileConsentVersion: 7 });
    if (path.endsWith("/flows")) return Response.json({ flows: [] });
    // In each page messages are chronological, but newer pages arrive before older pages.
    if (path.endsWith("/sessions/s/history?before=latest")) {
      if (failHistory) return Response.json({ error: { code: "unavailable", message: "history down" } }, { status: 503 });
      const page = pagedHistory ? messages.slice(-2) : messages;
      return Response.json({ messages: page, cursor: page[0]?.historyCursor ?? 0, hasMore: pagedHistory, historyVersion: 1, retainedFromCursor: 0, gap: false });
    }
    if (path.endsWith("/sessions/s/history?before=4")) return Response.json({ messages: messages.slice(0, 3), cursor: 1, hasMore: false, historyVersion: 1, retainedFromCursor: 0, gap: false });
    if (path.endsWith("/sessions/s/queue")) return Response.json({ items: [], queueVersion: 0, cursor: 0, hasMore: false });
    if (path.endsWith("/sessions/s/routing")) return Response.json({ version: 1, policyDigest: "a".repeat(64), capabilityDigest: "a".repeat(64), candidates: [], profileIds: [] });
    if (path.endsWith("/sessions/s/commands")) return Response.json({ catalogueVersion: 1, catalogueDigest: "a".repeat(64), capabilityDigest: "a".repeat(64), entries: [entry("status"), entry("help")] });
    if (path.endsWith("/commands/invoke") && init?.method === "POST") {
      const { commandName } = JSON.parse(String(init.body)) as { commandName: string };
      onInvoke?.();
      return Response.json(outcome("op-" + commandName + "-" + ++invokeCount, commandName, "queued"));
    }
    const operation = /\/operations\/([^/?]+)$/.exec(path);
    if (operation) return Response.json(outcome(operation[1], operation[1].split("-")[1], appliedOperations.has(operation[1]) ? "applied" : "queued"));
    if (path.endsWith("/sessions/s")) return Response.json({ ...sessionFixture, version: claimed ? 3 : 2, controller: claimed ? sessionFixture.controller : null, historyCursor: messages.length });
    return Response.json({ error: { code: "not-found", message: "no" } }, { status: 404 });
  });
});
async function open(client: QueryClient) {
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
  await screen.findByText(pagedHistory ? "msg 5" : "first message");
  fireEvent.click(screen.getByRole("button", { name: "Claim control" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Release control" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Native command catalogue" }));
  await screen.findByRole("option", { name: "status · available" });
}
async function invoke(name: string) {
  fireEvent.change(screen.getByLabelText("Command"), { target: { value: name } });
  const rebase = screen.queryByRole("button", { name: "Use current versions" });
  if (rebase) fireEvent.click(rebase);
  const button = screen.getByRole("button", { name: "Invoke command" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await screen.findByText("/" + name);
}
const order = () => screen.getAllByRole("listitem").map(item => item.textContent ?? "");
const queued = () => i18n.t("receiptStatuses.queued", { ns: "remote" });
const applied = () => i18n.t("receiptStatuses.applied", { ns: "remote" });
const itemFor = (name: string) => screen.getByText("/" + name).closest("li")!;
test("an outcome is placed by the history cursor at invocation, not by comparing the browser clock with the machine clock", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await open(client);
  // The reply lands on the machine while the command is being sent.
  onInvoke = () => { messages = [...messages, message(2, "assistant", "2099-01-01T00:00:01Z", "later reply")]; };
  await invoke("status");
  await act(async () => { await client.invalidateQueries({ queryKey: [2, "p", "remote", "history"] }); });
  await screen.findByText("later reply");
  const items = order();
  const at = (needle: string) => items.findIndex(text => text.includes(needle));
  expect(at("first message")).toBeLessThan(at("/status"));
  expect(at("/status")).toBeLessThan(at("later reply"));
  expect(itemFor("status").querySelector("time")).not.toBeNull();
});
test("every invoked command keeps following its own operation, not only the latest one", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await open(client);
  await invoke("status");
  await invoke("help");
  expect(itemFor("status")).toHaveTextContent(queued());
  expect(itemFor("help")).toHaveTextContent(queued());
  appliedOperations.add("op-status-1");
  await act(async () => { await client.invalidateQueries(); });
  await waitFor(() => expect(itemFor("status")).toHaveTextContent(applied()));
  expect(itemFor("help")).toHaveTextContent(queued());
  expect(fetched.some(path => path.endsWith("/operations/op-status-1"))).toBe(true);
});
test("a settled outcome stops being fetched but its receipt stays in the query cache", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await open(client);
  await invoke("status");
  await invoke("help");
  appliedOperations.add("op-status-1");
  await act(async () => { await client.invalidateQueries(); });
  await waitFor(() => expect(itemFor("status")).toHaveTextContent(applied()));
  const fetchesOf = () => fetched.filter(path => path.endsWith("/operations/op-status-1")).length;
  const before = fetchesOf();
  await act(async () => { await client.invalidateQueries(); });
  expect(fetchesOf()).toBe(before);
  expect(client.getQueryData<Control["CommandOutcome"]>([2, "p", "remote", "operation", "s", "op-status-1"])?.status).toBe("applied");
  expect(itemFor("status")).toHaveTextContent(applied());
});
const fiveMessages = () => [1, 2, 3, 4, 5].map(n => message(n, n % 2 ? "human" : "assistant", "2026-01-01T00:00:0" + n + "Z", n === 1 ? "first message" : "msg " + n));
const after = (items: string[], needle: string, other: string) =>
  items.findIndex(text => text.includes(needle)) > items.findIndex(text => text.includes(other));
test("an outcome invoked before the next history page is loaded still follows every earlier message", async () => {
  pagedHistory = true;
  messages = fiveMessages();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await open(client);
  expect(screen.queryByText("first message")).toBeNull();
  await invoke("status");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("olderMessages", { ns: "remote" }) }));
  await screen.findByText("first message");
  expect(after(order(), "/status", "msg 5")).toBe(true);
});
test("an outcome invoked before any history has loaded is not drawn above the messages that already existed", async () => {
  messages = fiveMessages();
  failHistory = true;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Claim control" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Release control" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Native command catalogue" }));
  await screen.findByRole("option", { name: "status · available" });
  expect(client.getQueryData([2, "p", "remote", "history", "s", "workspace"])).toBeUndefined();
  await invoke("status");
  failHistory = false;
  await act(async () => { await client.invalidateQueries({ queryKey: [2, "p", "remote", "history"] }); });
  await screen.findByText("msg 5");
  expect(after(order(), "/status", "msg 5")).toBe(true);
});
test("a settled outcome stops being fetched on later invalidations, while a queued one keeps following", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await open(client);
  await invoke("status");
  await invoke("help");
  appliedOperations.add("op-status-1");
  await act(async () => { await client.invalidateQueries(); });
  await waitFor(() => expect(itemFor("status")).toHaveTextContent(applied()));
  const count = (id: string) => fetched.filter(path => path.endsWith("/operations/" + id)).length;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  const before = { status: count("op-status-1"), help: count("op-help-2") };
  await act(async () => { await client.invalidateQueries(); });
  await waitFor(() => expect(count("op-help-2")).toBeGreaterThan(before.help));
  expect(count("op-status-1")).toBe(before.status);
  expect(itemFor("status")).toHaveTextContent(applied());
});
