import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, expect, test, vi } from "vitest";
import type { MessageDeliveries, MessageDelivery } from "../../../src/remote-control/message-delivery";
import type { RunRecord } from "../../../src/remote-control/protocol";
import { InvalidationBatch } from "../src/api/browser-invalidations";
import { resetClient } from "../src/api/client";
import type { Control } from "../src/api/remote";
import type { HubContextValue } from "../src/app/hub-context";
import { SessionDetail } from "../src/features/remote/sessions";
import i18n from "../src/i18n";
import { useDraftStore } from "../src/state/drafts";
import { renderHub } from "./hub-render";
import { machineFixture, sessionFixture } from "./remote-fixtures";

const context: HubContextValue = {
  projectId: "p",
  principal: { id: "human:test", kind: "human", role: "operator" },
  scopeKey: 1,
  location: { projectId: "p", tab: "sessions", sessionId: "s" },
  navigate: () => undefined,
  refresh: async () => undefined,
};
const receipt: Control["TurnReceipt"] = {
  operationId: "chat-op", messageId: "hub-message", sessionId: "s", sessionVersion: 3,
  queueItemId: null, status: "admitted", runId: "chat-run", turnId: "chat-turn", turnOrdinal: 1,
};
const run: RunRecord = {
  runId: "chat-run", turnId: "chat-turn", sessionId: "s", projectId: "p", checkoutId: "c",
  machineId: "m", version: 1, state: "dispatching", lastLocalSeq: 0,
  association: { mode: "ad-hoc", profileConsentVersion: 1 },
  snapshot: {
    config: sessionFixture.config, configDigest: "a".repeat(64), effectiveCandidateId: "local",
    routingDecision: "baseline", fallbackReason: "none", selectionReceiptId: "selection",
  },
  partial: false, connected: true,
};
const original = "Inspect  the parser\nThen report what happened 🧪";
const newer = "Keep this newer draft";
const sent: Control["MessageSubmit"][] = [];
let record: Control["SessionRecord"];
let messages: Control["SessionMessage"][];
let sessionEvents: Control["SessionEvent"][];
let runState: RunRecord["state"];
let deliveryStatus: MessageDelivery["status"];
let failedDeliveryReads: number;
let deliveryUnavailable: boolean;

beforeEach(async () => {
  resetClient();
  useDraftStore.getState().clearAll();
  await i18n.changeLanguage("en");
  record = { ...structuredClone(sessionFixture), version: 2, controller: null };
  messages = [];
  sessionEvents = [];
  runState = "dispatching";
  deliveryStatus = "hub-accepted";
  failedDeliveryReads = 0;
  deliveryUnavailable = false;
  sent.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input);
    if (path.endsWith("/sessions/s")) return Response.json(record);
    if (path.endsWith("/controller/claim")) {
      record = { ...record, version: 3, controller: sessionFixture.controller };
      return Response.json({ receiptId: "claim", sessionVersion: record.version, lease: record.controller });
    }
    if (path.includes("/controller-claims/")) return Response.json({ applied: true });
    if (path.endsWith("/machines?projectId=p")) return Response.json({ machines: [machineFixture] });
    if (path.endsWith("/sessions?after=0")) return Response.json({ sessions: [record], cursor: 1, hasMore: false });
    if (path.endsWith("/chat-consent")) return Response.json({ profileConsentVersion: 1 });
    if (path.endsWith("/flows")) return Response.json({ flows: [] });
    if (path.endsWith("/routing")) return Response.json({ candidates: [], profileIds: [] });
    if (path.endsWith("/queue")) return Response.json({ items: [], queueVersion: 0, cursor: 0, hasMore: false });
    if (path.endsWith("/history?before=latest")) return Response.json({
      messages, cursor: messages[0]?.historyCursor ?? 0, historyVersion: record.historyVersion,
      hasMore: false, retainedFromCursor: 0, gap: false,
    });
    if (path.endsWith("/messages") && init?.method === "POST") {
      sent.push(JSON.parse(String(init.body)) as Control["MessageSubmit"]);
      return Response.json(receipt);
    }
    if (path.endsWith("/message-deliveries")) {
      if (deliveryUnavailable) {
        failedDeliveryReads++;
        return Response.json({ error: { code: "unavailable", message: "Delivery status is unavailable" } }, { status: 503 });
      }
      return Response.json({ deliveries: sent.length ? [{
        operationId: receipt.operationId, text: original, submittedAt: "2026-10-31T00:00:00Z", afterCursor: 0,
        runId: receipt.runId, turnId: receipt.turnId, status: deliveryStatus, queued: false,
        reason: deliveryStatus === "machine-rejected" ? "scope-denied" : null,
      }] : [] } satisfies MessageDeliveries);
    }
    if (path.endsWith("/sessions/s/events?after=0")) return Response.json({
      events: sessionEvents, cursor: record.sessionEventCursor, hasMore: false, retainedFromCursor: 0, gap: false,
    } satisfies Control["SessionEventPage"]);
    if (path.endsWith("/runs/chat-run")) return Response.json({ ...run, state: runState });
    if (path.endsWith("/runs/chat-run/events?after=0")) return Response.json({ events: [], cursor: 0, gap: null });
    return Response.json({ error: { code: "not-found", message: "Fixture route not found" } }, { status: 404 });
  });
});

async function sendOriginal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderHub(<SessionDetail sessionId="s" />, context, client);
  fireEvent.click(await screen.findByRole("button", { name: "Claim control" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Release control" })).toBeEnabled());
  fireEvent.click(await screen.findByLabelText("Send messages in this session without a Flow."));
  const composer = screen.getByLabelText("Message");
  fireEvent.change(composer, { target: { value: original } });
  const send = screen.getByRole("button", { name: "Send message" });
  await waitFor(() => expect(send).toBeEnabled());
  fireEvent.click(send);
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]?.text).toBe(original);
  const history = within(screen.getByRole("region", { name: "History" }));
  return { client, composer, history };
}

async function invalidateFromMachine(client: QueryClient, ...resources: ("session" | "run" | "history")[]) {
  const batch = new InvalidationBatch();
  for (const resource of resources) {
    batch.add({ type: "resource-changed", v: 2, resource, resourceId: resource === "run" ? "chat-run" : "s", projectId: "p", version: 1 });
  }
  const matches = batch.take(context.scopeKey, "p");
  await act(async () => { await client.invalidateQueries({ predicate: query => matches(query.queryKey) }); });
}

test("Hub acceptance appears in chat before native execution and then yields to one durable message", async () => {
  const { client, history } = await sendOriginal();
  expect(await history.findByText("Accepted by Hub")).toBeVisible();
  expect(history.getByText(/Inspect\s+the parser/)).toBeVisible();
  expect(history.queryByText("Machine started")).not.toBeInTheDocument();

  deliveryStatus = "machine-started";
  runState = "running";
  record = { ...record, version: 4, state: "busy", activeRunId: "chat-run", activeTurnId: "chat-turn", nextTurnOrdinal: 2 };
  await invalidateFromMachine(client, "session", "run");
  expect(await history.findByText("Machine started")).toBeVisible();

  messages = [
    { messageId: "machine-message", sessionId: "s", historyCursor: 1, role: "human",
      text: original, createdAt: "2026-10-31T00:00:00Z", runId: "chat-run", turnId: "chat-turn" },
    { messageId: "machine-reply", sessionId: "s", historyCursor: 2, role: "assistant",
      text: "Result from native history", createdAt: "2026-10-31T00:00:01Z", runId: "chat-run", turnId: "chat-turn" },
  ];
  record = { ...record, historyCursor: 2, historyVersion: 3 };
  await invalidateFromMachine(client, "history");
  expect(await history.findByText("Result from native history")).toBeVisible();
  expect(history.getAllByText(/Inspect\s+the parser/)).toHaveLength(1);
  expect(sent).toHaveLength(1);
});

test("machine rejection leaves the exact original recoverable without replacing a newer draft or sending again", async () => {
  const { client, composer, history } = await sendOriginal();
  expect(await history.findByText("Accepted by Hub")).toBeVisible();
  fireEvent.change(composer, { target: { value: newer } });

  deliveryStatus = "machine-rejected";
  runState = "rejected";
  await invalidateFromMachine(client, "session", "run");
  expect(await history.findByText("Machine rejected")).toBeVisible();
  expect(history.getByText(/Inspect\s+the parser/)).toBeVisible();
  const restore = () => history.getByRole("button", { name: "Restore text" });
  expect(restore()).toBeDisabled();
  expect(history.getByRole("button", { name: /copy/i })).toBeVisible();
  fireEvent.click(restore());
  expect(composer).toHaveValue(newer);
  expect(sent).toHaveLength(1);

  fireEvent.change(composer, { target: { value: "" } });
  fireEvent.click(restore());
  expect(composer).toHaveValue(original);
  expect(sent).toHaveLength(1);
});

test("a delivery read outage preserves Hub acceptance and exact native history unblocks the next send", async () => {
  deliveryUnavailable = true;
  const { client, composer, history } = await sendOriginal();
  expect(failedDeliveryReads).toBeGreaterThan(0);
  expect(await history.findByText("Accepted by Hub")).toBeVisible();
  const send = screen.getByRole("button", { name: "Send message" });
  fireEvent.change(composer, { target: { value: newer } });
  expect(send).toBeDisabled();

  const observedAt = "2026-10-31T00:00:00Z";
  const event = { sessionId: "s", projectId: "p", checkoutId: "c", observedAt };
  const busy: Control["SessionRecord"] = { ...record, version: 4, state: "busy", activeRunId: "chat-run",
    activeTurnId: "chat-turn", nextTurnOrdinal: 2, sessionEventCursor: 1 };
  const message: Control["SessionMessage"] = { messageId: "native-chat-message", sessionId: "s", historyCursor: 1,
    role: "human", text: original, createdAt: observedAt, runId: "chat-run", turnId: "chat-turn" };
  record = { ...busy, version: 5, state: "idle", activeRunId: null, activeTurnId: null,
    sessionEventCursor: 3, historyCursor: 1, historyVersion: 2 };
  sessionEvents = [
    { ...event, sessionEventSeq: 1, kind: "session-state", session: busy },
    { ...event, sessionEventSeq: 2, kind: "message", message },
    { ...event, sessionEventSeq: 3, kind: "session-state", session: record },
  ];
  messages = [message];
  const beforeRefresh = failedDeliveryReads;
  await invalidateFromMachine(client, "session", "history");

  expect(failedDeliveryReads).toBeGreaterThan(beforeRefresh);
  expect(await history.findByText("Machine started")).toBeVisible();
  expect(history.getAllByText(/Inspect\s+the parser/)).toHaveLength(1);
  expect(composer).toHaveValue(newer);
  await waitFor(() => expect(send).toBeEnabled());
  expect(sent).toHaveLength(1);
});
