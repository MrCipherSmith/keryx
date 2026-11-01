import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, test, vi } from "vitest";
import i18n from "../src/i18n";
import { HubContext, type HubContextValue } from "../src/app/hub-context";
import { SessionsView } from "../src/features/remote";
import { useDraftStore } from "../src/state/drafts";
import { resetClient } from "../src/api/client";
import { navigate, useLocation } from "../src/app/navigation";
import { sessionFixture, machineFixture } from "./remote-fixtures";
const requests: { url: string; init?: RequestInit }[] = [];
let role = "operator";
let claimed = false;
function Harness() {
  const location = useLocation();
  const ctx = {
    projectId: "p",
    principal: { id: "human:test", kind: "human", role },
    scopeKey: 2,
    location,
    navigate,
    refresh: async () => undefined,
  } as HubContextValue;
  return (
    <HubContext.Provider value={ctx}>
      <SessionsView />
    </HubContext.Provider>
  );
}
function show() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <Harness />
    </QueryClientProvider>,
  );
}
beforeEach(async () => {
  resetClient();
  claimed = false;
  useDraftStore.getState().clearAll();
  role = "operator";
  requests.length = 0;
  await i18n.changeLanguage("en");
  navigate({ projectId: "p", tab: "sessions", sessionId: undefined }, true);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    requests.push({ url: String(url), init });
    const path = String(url);
    if (path.endsWith("/controller/claim")) {
      claimed = true;
      return Response.json({
        receiptId: "claimed",
        sessionVersion: 3,
        lease: sessionFixture.controller,
      });
    }
    if (path.endsWith("/machines?projectId=p"))
      return Response.json({ machines: [machineFixture] });
    if (path.endsWith("/flows")) return Response.json({ flows: [] });
    if (path.endsWith("/sessions/s/history?after=0"))
      return Response.json({
        messages: [],
        cursor: 0,
        hasMore: false,
        historyVersion: 1,
        retainedFromCursor: 0,
        gap: false,
      });
    if (path.endsWith("/sessions/s/queue"))
      return Response.json({
        items: [],
        queueVersion: 0,
        cursor: 0,
        hasMore: false,
      });
    if (path.endsWith("/sessions/s/commands"))
      return Response.json({
        catalogueVersion: 1,
        catalogueDigest: "a".repeat(64),
        capabilityDigest: "a".repeat(64),
        entries: [],
      });
    if (path.endsWith("/sessions/s/routing"))
      return Response.json({
        version: 1,
        policyDigest: "a".repeat(64),
        capabilityDigest: "a".repeat(64),
        candidates: [],
        profileIds: [],
      });
    if (path.endsWith("/sessions/s"))
      return Response.json({
        ...sessionFixture,
        version: claimed ? 3 : 2,
        controller: claimed ? sessionFixture.controller : null,
      });
    if (path.endsWith("/sessions"))
      return Response.json({
        sessions: [sessionFixture],
        cursor: 1,
        hasMore: false,
      });
    return Response.json(
      { error: { code: "not-found", message: "no" } },
      { status: 404 },
    );
  });
});
test("session launch requires explicit machine checkout profile and does not silently select first ready target", async () => {
  show();
  fireEvent.click(await screen.findByRole("button", { name: "New session" }));
  expect(await screen.findByLabelText("Machine")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Create session" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Machine"), {
    target: { value: "m" },
  });
  expect(screen.getByLabelText("Checkout")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Create session" })).toBeDisabled();
  expect(requests.filter((r) => r.init?.method === "POST")).toHaveLength(0);
});
test("observer sees history but cannot claim or send operations", async () => {
  role = "reviewer";
  navigate({ tab: "sessions", sessionId: "s" }, true);
  show();
  expect(
    await screen.findByRole("heading", { name: "Test session" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Claim control" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(requests.filter((r) => r.init?.method !== "GET")).toHaveLength(0);
});
test("message conflict preserves draft and sends exact controller and frozen base versions", async () => {
  navigate({ tab: "sessions", sessionId: "s" }, true);
  const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).endsWith("/messages")) {
      requests.push({ url: String(url), init });
      return Response.json(
        { error: { code: "stale-version", message: "changed" } },
        { status: 409 },
      );
    }
    return original(url, init);
  });
  show();
  await screen.findByRole("heading", { name: "Test session" });
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Claim control" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Release control" }),
    ).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: "Keep my draft" },
  });
  fireEvent.change(screen.getByLabelText("Work mode"), {
    target: { value: "ad-hoc" },
  });
  fireEvent.click(
    screen.getByLabelText("I explicitly choose locally permitted ad-hoc work"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(requests.some((r) => r.url.endsWith("/messages"))).toBe(true),
  );
  const body = JSON.parse(
    requests.find((r) => r.url.endsWith("/messages"))!.init!.body as string,
  );
  expect(body.expectedSessionVersion).toBe(3);
  expect(body.controller).toEqual({
    controllerLeaseId: "lease",
    expectedControllerVersion: 1,
  });
  expect(body.association).toEqual({
    mode: "ad-hoc",
    profileConsentVersion: 1,
  });
  expect(screen.getByLabelText("Message")).toHaveValue("Keep my draft");
});
test("session deep links clear on project change and Back/Forward restores entity", async () => {
  navigate({ tab: "sessions", sessionId: "s" }, true);
  expect(window.location.search).toContain("session=s");
  navigate({ projectId: "other" });
  expect(window.location.search).not.toContain("session=");
  act(() => {
    window.history.replaceState({}, "", "/?project=p&view=sessions&session=s");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  show();
  expect(
    await screen.findByRole("heading", { name: "Test session" }),
  ).toBeVisible();
});
test("fork requires explicit target checkout and carries source history baseline versions", async () => {
  navigate({ tab: "sessions", sessionId: "s" }, true);
  show();
  await screen.findByRole("heading", { name: "Test session" });
  fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
  expect(screen.getByRole("button", { name: "Fork session" })).toBeDisabled();
  expect(screen.getByLabelText("Fork checkout")).toHaveValue("");
});
test("suspended queue item offers explicit new-controller reauthorization rather than replaying old work", async () => {
  navigate({ tab: "sessions", sessionId: "s" }, true);
  const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) =>
    String(url).endsWith("/queue")
      ? Response.json({
          items: [
            {
              queueItemId: "q",
              version: 2,
              kind: "message",
              operationId: "old-operation",
              state: "suspended",
              position: 0,
              text: "pending",
              commandName: null,
              expectedConfigVersion: 1,
              replacesOperationId: null,
            },
          ],
          queueVersion: 1,
          cursor: 1,
          hasMore: false,
        })
      : original(url, init),
  );
  show();
  await screen.findByRole("heading", { name: "Test session" });
  fireEvent.click(screen.getByRole("tab", { name: "Queue" }));
  expect(
    await screen.findByRole("button", {
      name: "Reauthorize under current controller",
    }),
  ).toBeDisabled();
});
