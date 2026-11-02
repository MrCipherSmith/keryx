import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, test, vi } from "vitest";
import i18n from "../src/i18n";
import { HubContext, type HubContextValue } from "../src/app/hub-context";
import { SessionSurface } from "../src/features/remote/sessions";
import { sessionFixture, machineFixture } from "./remote-fixtures";
import { resetClient } from "../src/api/client";
import { useDraftStore } from "../src/state/drafts";
const navigate = vi.fn();
const context: HubContextValue = {
  projectId: "p",
  principal: { id: "human:test", kind: "human", role: "reviewer" },
  scopeKey: 13,
  location: { projectId: "p", tab: "sessions", sessionId: "s" },
  navigate,
  refresh: async () => {},
};
function show() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <HubContext.Provider value={context}>
        <SessionSurface record={sessionFixture} />
      </HubContext.Provider>
    </QueryClientProvider>,
  );
}
beforeEach(async () => {
  vi.restoreAllMocks();
  navigate.mockClear();
  resetClient();
  useDraftStore.getState().clearAll();
  await act(() => i18n.changeLanguage("en"));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input);
    if (path.includes("/machines?"))
      return Response.json({ machines: [machineFixture] });
    if (path.endsWith("/sessions?after=0"))
      return Response.json({
        sessions: [
          sessionFixture,
          {
            ...sessionFixture,
            sessionId: "second",
            title: "Second copy",
            checkoutId: "copy-two",
          },
        ],
        cursor: 2,
        hasMore: false,
      });
    if (path.includes("/history?after=0"))
      return Response.json({
        messages: [
          {
            messageId: "msg1",
            sessionId: "s",
            historyCursor: 1,
            role: "human",
            text: "First message",
            createdAt: "2026-10-31T00:00:00Z",
            turnId: null,
            runId: null,
          },
        ],
        cursor: 1,
        hasMore: true,
        historyVersion: 1,
        retainedFromCursor: 0,
        gap: false,
      });
    if (path.includes("/history?after=1"))
      return Response.json({
        messages: [
          {
            messageId: "msg2",
            sessionId: "s",
            historyCursor: 2,
            role: "assistant",
            text: "Reply from agent",
            createdAt: "2026-10-31T00:01:00Z",
            turnId: null,
            runId: "finished-run",
          },
        ],
        cursor: 2,
        hasMore: false,
        historyVersion: 1,
        retainedFromCursor: 0,
        gap: false,
      });
    if (path.endsWith("/routing"))
      return Response.json({
        candidates: [
          {
            candidateId: "local",
            providerId: "local-provider",
            modelId: "actual-model",
            reasoningEfforts: ["medium"],
            available: true,
            reason: "none",
            privacyClass: "local",
            costClass: "local",
          },
        ],
        profileIds: [],
      });
    if (path.endsWith("/flows")) return Response.json({ flows: [] });
    if (path.endsWith("/queue"))
      return Response.json({ items: [], queueVersion: 0 });
    if (path.endsWith("/commands")) return Response.json({ entries: [] });
    return Response.json({ error: { code: "not-found" } }, { status: 404 });
  });
});
test("navigator shows checkout groups and opens exact session within project", async () => {
  show();
  const navigator = screen.getByRole("complementary", {
    name: "Project sessions",
  });
  fireEvent.click(
    await within(navigator).findByRole("button", { name: /Second copy/ }),
  );
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: "p",
      tab: "sessions",
      sessionId: "second",
      runId: undefined,
    }),
  );
  expect(
    await screen.findByText(/local-provider \/ actual-model/),
  ).toBeInTheDocument();
});
test("history appends pages and preserves earlier messages with explicit roles", async () => {
  show();
  const history = screen.getByRole("region", { name: "History" });
  expect(await within(history).findByText("First message")).toBeVisible();
  fireEvent.click(
    within(history).getByRole("button", { name: "Load next page" }),
  );
  expect(await within(history).findByText("Reply from agent")).toBeVisible();
  expect(within(history).getByText("First message")).toBeVisible();
  expect(within(history).getByText("Human")).toBeVisible();
  fireEvent.click(within(history).getByRole("button", { name: "Open run" }));
  expect(navigate).toHaveBeenCalledWith({
    tab: "runs",
    runId: "finished-run",
    sessionId: undefined,
  });
});
test("inspector tabs support keyboard navigation and keep observer controls disabled", async () => {
  show();
  await screen.findByText("First message");
  const contextTab = screen.getByRole("tab", { name: "Context" });
  contextTab.focus();
  fireEvent.keyDown(contextTab, { key: "End" });
  const settingsTab = screen.getByRole("tab", { name: "Settings" });
  expect(settingsTab).toHaveAttribute("aria-selected", "true");
  expect(settingsTab).toHaveFocus();
  expect(screen.getByRole("button", { name: "Fork session" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Claim control" })).toBeDisabled();
  fireEvent.keyDown(settingsTab, { key: "Home" });
  await waitFor(() =>
    expect(contextTab).toHaveAttribute("aria-selected", "true"),
  );
});
