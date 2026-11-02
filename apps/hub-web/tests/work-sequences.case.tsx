import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, test, vi } from "vitest";
import i18n from "../src/i18n";
import { HubContext, type HubContextValue } from "../src/app/hub-context";
import { resetClient } from "../src/api/client";
import { useDraftStore } from "../src/state/drafts";
import { ManagedWorkView } from "../src/features/managed-work/view";
import { demoWorkAdapter } from "../src/features/managed-work/demo";
import { isWorkEvent, isWorkRecord } from "../src/features/managed-work/validation";
import type { WorkEvent, WorkRecord } from "../src/features/managed-work/types";

// Live-shaped sequences: the receipt carries only the command result, and
// every side effect reaches the board through the event feed.
const capabilities = {
  protocolVersion: 1,
  enabled: true,
  allowedCommands: ["attempt.select", "review.decide"],
  limits: {},
  features: { managedExecution: false, gitObserver: false, legacyConversion: false },
};
let records: WorkRecord[];
beforeEach(async () => {
  resetClient();
  useDraftStore.getState().clearAll();
  await i18n.changeLanguage("en");
  records = (await demoWorkAdapter("p").snapshot()).records;
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
let sequence = 0;
function event(record: WorkRecord, type: WorkEvent["type"], operationId: string): WorkEvent {
  const value: WorkEvent = {
    protocolVersion: 1,
    projectId: "p",
    sequence: ++sequence,
    eventId: "event-" + sequence,
    operationId,
    actorId: "human:test",
    actorKind: "human",
    occurredAt: "2026-11-02T08:00:00Z",
    type,
    entityType: record.kind as WorkEvent["entityType"],
    entityId: record.id,
    entityVersion: "version" in record ? record.version : null,
    contentDigest: "contentDigest" in record ? record.contentDigest : null,
    causationId: null,
  };
  expect(isWorkEvent(value)).toBe(true);
  return value;
}
function show() {
  const value: HubContextValue = {
    principal: { id: "human:test", kind: "human", role: "operator" },
    projectId: "p",
    scopeKey: 7,
    location: { projectId: "p", tab: "work", flowId: "flow-demo" },
    navigate: vi.fn(),
    refresh: async () => undefined,
  };
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <HubContext.Provider value={value}>
        <ManagedWorkView />
      </HubContext.Provider>
    </QueryClientProvider>,
  );
}
const json = (value: unknown) => Response.json(value);

test("a snapshot refetch that lands after an event keeps the newer merged record", async () => {
  const flow = records.find((r) => r.kind === "flow")!;
  const renamed = { ...flow, version: 2, title: "Keyboard accessibility, renamed" } as WorkRecord;
  const eventsGate = deferred<Response>();
  const slowSnapshot = deferred<Response>();
  const old = structuredClone(records);
  let snapshots = 0;
  let eventCalls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input);
    if (path.endsWith("/capabilities")) return json(capabilities);
    if (path.includes("/snapshot"))
      return ++snapshots === 1 ? json({ records: old, eventCursor: "c1", nextCursor: null }) : slowSnapshot.promise;
    if (path.includes("/events"))
      return ++eventCalls === 1 ? eventsGate.promise : json({ events: [], nextCursor: "c2" });
    if (path.includes("/records/flow-demo")) return json({ record: renamed, eventCursor: "c2" });
    if (path.includes("/attention")) return json({ records: [], nextCursor: null });
    return Response.json({ error: { code: "not-found" } }, { status: 404 });
  });
  show();
  expect(await screen.findByRole("heading", { name: "Keyboard accessibility" })).toBeVisible();
  // Refresh starts a full export cut at c1; while it is in flight the poller merges v2.
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(snapshots).toBe(2));
  eventsGate.resolve(json({ events: [event(renamed, "flow-changed", "op-rename")], nextCursor: "c2" }));
  expect(await screen.findByRole("heading", { name: "Keyboard accessibility, renamed" })).toBeVisible();
  slowSnapshot.resolve(json({ records: structuredClone(old), eventCursor: "c1", nextCursor: null }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole("heading", { name: "Keyboard accessibility, renamed" })).toBeVisible();
});

test("the user's own command refreshes the board immediately from the event feed", async () => {
  let committed: { operationId: string; intent: WorkRecord; decision: WorkRecord } | null = null;
  let delivered = false;
  let attentionCalls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input);
    if (path.endsWith("/capabilities")) return json(capabilities);
    if (path.includes("/snapshot")) return json({ records, eventCursor: "c1", nextCursor: null });
    if (path.includes("/attention")) {
      attentionCalls++;
      return json({ records: [], nextCursor: null });
    }
    if (path.endsWith("/commands")) {
      const body = JSON.parse(String(init?.body));
      const intent = records.find((r) => r.id === "i1")!;
      const decision = {
        projectId: "p",
        createdBy: "human:test",
        createdAt: "2026-11-02T08:00:00Z",
        id: "decision-" + body.operationId,
        kind: "decision",
        targetType: "attempt-selection",
        targetId: "i1",
        targetDigest: "a".repeat(64),
        decision: "select",
        reason: body.payload.reason,
        actorKind: "human",
        operationId: body.operationId,
        contentDigest: "a".repeat(64),
      } as WorkRecord;
      expect(isWorkRecord(decision)).toBe(true);
      committed = {
        operationId: body.operationId,
        decision,
        intent: { ...intent, version: 2, selectedSubmissionId: "sub-agent" } as WorkRecord,
      };
      // The server's receipt holds only the handler result, not the changed Intent.
      return json({ operationId: body.operationId, status: "committed", receiptId: "r1", entities: [decision], eventCursor: "c2" });
    }
    if (path.includes("/events")) {
      if (!committed || delivered) return json({ events: [], nextCursor: committed ? "c2" : "c1" });
      delivered = true;
      return json({
        events: [event(committed.intent, "intent-changed", committed.operationId), event(committed.decision, "decision-recorded", committed.operationId)],
        nextCursor: "c2",
      });
    }
    if (path.includes("/records/i1")) return json({ record: committed!.intent, eventCursor: "c2" });
    return Response.json({ error: { code: "not-found" } }, { status: 404 });
  });
  show();
  const accept = await screen.findByRole("button", { name: "Accept exact result" });
  expect(accept).toBeDisabled();
  // Let the first poll go idle so the loop is in its back-off before the user acts.
  await waitFor(() => expect(screen.getByText("Work updates connected")).toBeVisible());
  const attentionBefore = attentionCalls;
  fireEvent.click(screen.getByRole("button", { name: "Select this attempt" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Decision reason" }), { target: { value: "Select candidate" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Accept exact result" })).toBeEnabled(), { timeout: 1000 });
  await waitFor(() => expect(attentionCalls).toBeGreaterThan(attentionBefore), { timeout: 1000 });
});
