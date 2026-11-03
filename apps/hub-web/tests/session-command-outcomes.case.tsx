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
// The real catalogue is covered elsewhere; this stub only reports an outcome with its invocation time.
vi.mock("../src/features/remote/settings", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/features/remote/settings")>();
  return {
    ...actual,
    Commands: ({ onOutcome }: { onOutcome?: (outcome: Control["CommandOutcome"], invokedAt: string) => void }) => (
      <button onClick={() => onOutcome?.({ operationId: "op-1", commandName: "status", status: "completed", errorCode: null, result: "ok" } as unknown as Control["CommandOutcome"], "2026-01-01T00:00:05Z")}>emit</button>
    ),
  };
});
const message = (n: number, role: "human" | "assistant", createdAt: string, text: string) =>
  ({ messageId: "m" + n, role, text, createdAt, historyCursor: n, runId: null }) as unknown as Control["SessionMessage"];
let messages: Control["SessionMessage"][] = [];
function Harness() {
  const location = useLocation();
  const ctx = { projectId: "p", principal: { id: "human:test", kind: "human", role: "operator" }, scopeKey: 2, location, navigate, refresh: async () => undefined } as HubContextValue;
  return <HubContext.Provider value={ctx}><SessionsView /></HubContext.Provider>;
}
beforeEach(async () => {
  resetClient();
  useDraftStore.getState().clearAll();
  await i18n.changeLanguage("en");
  messages = [message(1, "human", "2026-01-01T00:00:00Z", "first message")];
  navigate({ projectId: "p", tab: "sessions", sessionId: "s" }, true);
  vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
    const path = String(url);
    if (path.endsWith("/machines?projectId=p")) return Response.json({ machines: [machineFixture] });
    if (path.endsWith("/chat-consent")) return Response.json({ profileConsentVersion: 7 });
    if (path.endsWith("/flows")) return Response.json({ flows: [] });
    if (path.endsWith("/sessions/s/history?after=0")) return Response.json({ messages, cursor: messages.length, hasMore: false, historyVersion: 1, retainedFromCursor: 0, gap: false });
    if (path.endsWith("/sessions/s/queue")) return Response.json({ items: [], queueVersion: 0, cursor: 0, hasMore: false });
    if (path.endsWith("/sessions/s/routing")) return Response.json({ version: 1, policyDigest: "a".repeat(64), capabilityDigest: "a".repeat(64), candidates: [], profileIds: [] });
    if (path.endsWith("/sessions/s")) return Response.json(sessionFixture);
    return Response.json({ error: { code: "not-found", message: "no" } }, { status: 404 });
  });
});
test("a command outcome is placed by its invocation time among the messages, with a time", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
  await screen.findByText("first message");
  fireEvent.click(screen.getByRole("button", { name: "Native command catalogue" }));
  fireEvent.click(await screen.findByRole("button", { name: "emit" }));
  messages = [...messages, message(2, "human", "2026-01-01T00:00:10Z", "later question"), message(3, "assistant", "2026-01-01T00:00:11Z", "later reply")];
  await act(async () => { await client.invalidateQueries(); });
  await screen.findByText("later reply");
  const items = screen.getAllByRole("listitem").map(item => item.textContent ?? "");
  const at = (needle: string) => items.findIndex(text => text.includes(needle));
  expect(at("first message")).toBeLessThan(at("/status"));
  expect(at("/status")).toBeLessThan(at("later question"));
  expect(at("later question")).toBeLessThan(at("later reply"));
  await waitFor(() => expect(screen.getByText("/status").closest("li")?.querySelector("time")).not.toBeNull());
});
