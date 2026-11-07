import {
  act,
  cleanup,
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
import { messageDraftKey } from "../src/features/remote/work";
import type { Control } from "../src/api/remote";
const requests: { url: string; init?: RequestInit }[] = [];
let role = "operator";
let claimed = false;
const commandEntry = (commandName: string): Control["CommandCatalogueEntry"] => ({
  commandName,
  summary: commandName,
  handlerId: commandName,
  inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
  resultSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
  mutationClass: "read",
  states: ["idle", "busy", "paused"],
  busyPolicy: "read-only",
  confirmation: "none",
  availability: "available",
  reason: "none",
});
let commandEntries: Control["CommandCatalogueEntry"][] = [];
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
  commandEntries = [];
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
    if (path.includes("/controller-claims/")) return Response.json({applied: claimed});
    if (path.endsWith("/machines?projectId=p"))
      return Response.json({ machines: [machineFixture] });
    if (path.endsWith("/chat-consent")) return Response.json({profileConsentVersion: 7});
    if (path.endsWith("/flows")) return Response.json({ flows: [] });
    if (path.endsWith("/sessions/s/history?before=latest"))
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
        entries: commandEntries,
      });
    if (path.endsWith("/sessions/s/commands/invoke") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Control["CommandInvoke"];
      return Response.json({
        operationId: "shortcut-command",
        sessionId: "s",
        commandName: body.commandName,
        status: "applied",
        sessionVersion: 3,
        result: {},
        confirmationId: null,
        errorCode: null,
        confirmation: null,
        runId: null,
        turnId: null,
      } satisfies Control["CommandOutcome"]);
    }
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
  expect(screen.getByLabelText("Work mode")).toHaveValue("ad-hoc");
  fireEvent.click(
    screen.getByLabelText("Send messages in this session without a Flow."),
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
    profileConsentVersion: 7,
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

test("a held receipt waits for machine application and explains a refused claim without losing the draft", async () => {
  navigate({ tab: "sessions", sessionId: "s" }, true);
  const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
  let claimKey: string | null = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.endsWith("/controller/claim")) {
      claimKey = new Headers(init?.headers).get("idempotency-key");
      return Response.json({receiptId: "pending", sessionVersion: 3, lease: sessionFixture.controller});
    }
    if (path.includes("/controller-claims/")) {
      expect(path.endsWith("/" + claimKey)).toBe(true);
      return Response.json({error: {code: "recovery-required", message: "Machine refused"}}, {status: 409});
    }
    return original(url, init);
  });
  show();
  await screen.findByRole("heading", { name: "Test session" });
  fireEvent.change(screen.getByLabelText("Message"), {target: {value: "Keep this message"}});
  fireEvent.click(screen.getByRole("button", {name: "Claim control"}));
  await screen.findByText(/\(recovery-required\)/);
  expect(screen.queryByRole("button", {name: "Release control"})).not.toBeInTheDocument();
  expect(screen.getByRole("button", {name: "Send message"})).toBeDisabled();
  expect(screen.getByLabelText("Message")).toHaveValue("Keep this message");
});

const launchDraft = { machineId: "m", checkoutId: "c", profileId: "native", title: "My session", flowId: "", firstMessage: "" };
test("a non-operator is told only operators can create sessions, not to choose what they already chose", async () => {
  role = "reviewer";
  useDraftStore.getState().put("remote-create:2:p", launchDraft);
  show();
  fireEvent.click(await screen.findByRole("button", { name: "New session" }));
  await waitFor(() => expect(screen.getByLabelText("Machine")).toHaveValue("m"));
  expect(screen.getByRole("button", { name: "Create session" })).toBeDisabled();
  expect(screen.getByText(/Only operators can create sessions/)).toBeVisible();
  expect(screen.queryByText(/Choose an available machine/)).toBeNull();
});
test("a restored draft whose Flow left in-progress names the Flow as the blocker", async () => {
  useDraftStore.getState().put("remote-create:2:p", { ...launchDraft, flowId: "gone" });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "New session" }));
  await waitFor(() => expect(screen.getByLabelText("Checkout")).toHaveValue("c"));
  expect(await screen.findByText(/selected Flow is no longer in progress/)).toBeVisible();
  expect(screen.queryByText(/Choose an available machine/)).toBeNull();
  expect(screen.getByRole("button", { name: "Create session" })).toBeDisabled();
});
test("a stale Flow can be cleared from the select, which re-enables Create session", async () => {
  useDraftStore.getState().put("remote-create:2:p", { ...launchDraft, flowId: "gone", firstMessage: "stale text" });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "New session" }));
  await screen.findByText(/selected Flow is no longer in progress/);
  const select = screen.getByLabelText("Session Flow (optional)");
  expect(select).toHaveValue("gone");
  expect(screen.getByRole("option", { name: "gone · no longer in progress" })).toBeDisabled();
  expect(screen.queryByLabelText("First message (draft)")).toBeNull();
  fireEvent.change(select, { target: { value: "" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Create session" })).toBeEnabled());
  expect(screen.queryByText(/no longer in progress/)).toBeNull();
});
const flow = { id: "f1", title: "Ship it", version: 4, status: "in-progress", criteria: ["works"], specContentDigest: "d".repeat(64) };
function serveCreate(flows: unknown[]) {
  const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.endsWith("/flows")) return Response.json({ flows });
    if (path.endsWith("/projects/p/sessions") && init?.method === "POST") {
      requests.push({ url: path, init });
      return Response.json({ sessionId: "s2", receiptId: "r2" });
    }
    return original(url, init);
  });
}
test("a stale Flow that still exists is named by its title, not its id", async () => {
  serveCreate([{ ...flow, id: "f9", title: "Ship it", status: "completed" }]);
  useDraftStore.getState().put("remote-create:2:p", { ...launchDraft, flowId: "f9" });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "New session" }));
  expect(await screen.findByRole("option", { name: "Ship it · no longer in progress" })).toBeDisabled();
});
test("creating a session with a Flow seeds the new session's composer with the prepared first message", async () => {
  serveCreate([flow]);
  useDraftStore.getState().put("remote-create:2:p", { ...launchDraft, flowId: "f1", firstMessage: "Start with the parser" });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "New session" }));
  await waitFor(() => expect(screen.getByLabelText("Session Flow (optional)")).toHaveValue("f1"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Create session" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  const key = messageDraftKey(2, "p", "s2");
  await waitFor(() => expect(useDraftStore.getState().drafts[key]).toBeDefined());
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(flow.criteria)))), byte => byte.toString(16).padStart(2, "0")).join("");
  expect(useDraftStore.getState().drafts[key]).toMatchObject({
    text: "Start with the parser", prepared: true, mode: "flow", flowId: "f1", flowVersion: 4, specDigest: "d".repeat(64), criteriaDigest: digest,
  });
  await waitFor(() => expect(window.location.search).toContain("session=s2"));
});
test("creating a session without a Flow writes no message draft", async () => {
  serveCreate([flow]);
  useDraftStore.getState().put("remote-create:2:p", launchDraft);
  show();
  fireEvent.click(await screen.findByRole("button", { name: "New session" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Create session" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  await waitFor(() => expect(window.location.search).toContain("session=s2"));
  expect(useDraftStore.getState().drafts[messageDraftKey(2, "p", "s2")]).toBeUndefined();
});
test("an empty title is named as the remaining requirement", async () => {
  useDraftStore.getState().put("remote-create:2:p", { ...launchDraft, title: "" });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "New session" }));
  expect(await screen.findByText(/Enter a session title/)).toBeVisible();
});
test("pressing / in the empty composer refocuses the command search when the catalogue is already open", async () => {
  navigate({ tab: "sessions", sessionId: "s" }, true);
  show();
  await screen.findByRole("heading", { name: "Test session" });
  fireEvent.click(screen.getByRole("button", { name: "Native command catalogue" }));
  const search = await screen.findByLabelText("Search Keryx commands");
  await waitFor(() => expect(search).toHaveFocus());
  const message = screen.getByLabelText("Message");
  message.focus();
  expect(message).toHaveFocus();
  fireEvent.keyDown(message, { key: "/" });
  await waitFor(() => expect(search).toHaveFocus());
});
test("a created session clears the launch form so the next one does not inherit the Flow and first message", async () => {
  serveCreate([flow]);
  useDraftStore.getState().put("remote-create:2:p", { ...launchDraft, flowId: "f1", firstMessage: "Start with the parser" });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "New session" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Create session" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  await waitFor(() => expect(window.location.search).toContain("session=s2"));
  expect(useDraftStore.getState().drafts["remote-create:2:p"]).toBeUndefined();
});
test("a rejected opening offers to create a new session and keeps the error code in details", async () => {
  navigate({ tab: "sessions", sessionId: "s" }, true);
  const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.endsWith("/sessions/s/opening-status")) return Response.json({ errorCode: "machine-refused" });
    if (path.endsWith("/sessions/s")) return Response.json({ ...sessionFixture, state: "opening", controller: null });
    return original(url, init);
  });
  show();
  const create = await screen.findByRole("button", { name: "Create a new session" });
  const notice = create.parentElement as HTMLElement;
  expect(notice.querySelector("details")).toHaveTextContent("machine-refused");
  expect(notice.textContent).not.toContain("(machine-refused)");
  fireEvent.click(create);
  await waitFor(() => expect(window.location.search).not.toContain("session=s"));
  const machine = await screen.findByLabelText("Machine");
  expect(machine).toBeVisible();
  await waitFor(() => expect(machine).toHaveFocus());
});
test("a chosen Flow whose list is failing says so, offers a retry and keeps Create session disabled", async () => {
  const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) =>
    String(url).endsWith("/flows")
      ? Response.json({ error: { code: "unavailable", message: "Flows down" } }, { status: 503 })
      : original(url, init));
  useDraftStore.getState().put("remote-create:2:p", { ...launchDraft, flowId: "f1" });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "New session" }));
  expect(await screen.findByText(/Flows could not be loaded/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Create session" })).toBeDisabled();
});
test("a chosen Flow whose list is still loading names that as the blocker", async () => {
  const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) =>
    String(url).endsWith("/flows") ? new Promise<Response>(() => undefined) : original(url, init));
  useDraftStore.getState().put("remote-create:2:p", { ...launchDraft, flowId: "f1" });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "New session" }));
  expect(await screen.findByText(/Loading the Flows to check/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Create session" })).toBeDisabled();
});
const toggle = () => screen.getByRole("button", { name: "Native command catalogue" });
test("provider, model and routing shortcuts open the typed catalogue from the chat composer", async () => {
  commandEntries = [commandEntry("connect.select"), commandEntry("model"), commandEntry("routing.configure")];
  navigate({ tab: "sessions", sessionId: "s" }, true);
  show();
  await screen.findByRole("heading", { name: "Test session" });
  fireEvent.click(screen.getByRole("button", { name: "Claim control" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Release control" })).toBeEnabled());
  const message = screen.getByLabelText("Message");

  const shortcuts = [
    ["/connect", "connect.select"],
    ["/model", "model"],
    ["/routing", "routing.configure"],
  ] as const;
  let search: HTMLElement | undefined;
  for (const [shortcut, commandName] of shortcuts) {
    const opener = screen.getByRole("button", { name: shortcut });
    fireEvent.click(opener);
    search = await screen.findByLabelText("Search Keryx commands");
    expect(search).toHaveValue(shortcut);
    expect(await screen.findByRole("option", { name: `${commandName} · available` })).toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(opener).toHaveFocus();
  }

  fireEvent.click(screen.getByRole("button", { name: "/connect" }));
  fireEvent.change(screen.getByLabelText("Command"), { target: { value: "connect.select" } });
  const invoke = screen.getByRole("button", { name: "Invoke command" });
  await waitFor(() => expect(invoke).toBeEnabled());
  fireEvent.click(invoke);
  await waitFor(() => expect(requests.some(request => request.url.endsWith("/sessions/s/commands/invoke"))).toBe(true));
  const invocation = requests.find(request => request.url.endsWith("/sessions/s/commands/invoke"));
  expect(JSON.parse(String(invocation?.init?.body))).toMatchObject({ commandName: "connect.select", arguments: {} });

  fireEvent.change(message, { target: { value: "/routing" } });
  fireEvent.keyDown(message, { key: "Enter" });
  expect(search).toHaveValue("/routing");
  expect(await screen.findByRole("option", { name: "routing.configure · available" })).toBeInTheDocument();
  expect(message).toHaveValue("");

  fireEvent.keyDown(search!, { key: "Escape" });
  fireEvent.click(toggle());
  await waitFor(() => expect(search).toHaveValue(""));
});

test("Escape right after / closes the catalogue and types the slash; typing in it first keeps Escape a plain close", async () => {
  navigate({ tab: "sessions", sessionId: "s" }, true);
  show();
  await screen.findByRole("heading", { name: "Test session" });
  const message = screen.getByLabelText("Message");
  expect(message).toHaveAccessibleDescription(/press Escape right after it/);
  fireEvent.keyDown(message, { key: "/" });
  const search = await screen.findByLabelText("Search Keryx commands");
  expect(toggle()).toHaveAttribute("aria-expanded", "true");
  expect(search).toBeVisible();
  fireEvent.keyDown(search, { key: "Escape" });
  await waitFor(() => expect(message).toHaveValue("/"));
  expect(message).toHaveFocus();
  expect(toggle()).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByLabelText("Search Keryx commands")).not.toBeVisible();
  fireEvent.change(message, { target: { value: "" } });
  fireEvent.keyDown(message, { key: "/" });
  expect(toggle()).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByLabelText("Search Keryx commands")).toBeVisible();
  fireEvent.keyDown(screen.getByLabelText("Search Keryx commands"), { key: "a" });
  fireEvent.keyDown(screen.getByLabelText("Search Keryx commands"), { key: "Escape" });
  expect(toggle()).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByLabelText("Search Keryx commands")).not.toBeVisible();
  expect(message).toHaveValue("");
});
test("Escape in a catalogue opened from the toggle closes it, returns focus to the toggle and leaves the message empty", async () => {
  navigate({ tab: "sessions", sessionId: "s" }, true);
  show();
  await screen.findByRole("heading", { name: "Test session" });
  fireEvent.click(toggle());
  const search = await screen.findByLabelText("Search Keryx commands");
  expect(search).toBeVisible();
  fireEvent.keyDown(search, { key: "Escape" });
  expect(toggle()).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByLabelText("Search Keryx commands")).not.toBeVisible();
  expect(toggle()).toHaveFocus();
  expect(screen.getByLabelText("Message")).toHaveValue("");
});
test("pointer or change activity in a catalogue opened by / keeps Escape a plain close", async () => {
  navigate({ tab: "sessions", sessionId: "s" }, true);
  show();
  await screen.findByRole("heading", { name: "Test session" });
  const message = screen.getByLabelText("Message");
  for (const act of ["pointer", "change"] as const) {
    fireEvent.keyDown(message, { key: "/" });
    const search = await screen.findByLabelText("Search Keryx commands");
    if (act === "pointer") fireEvent.pointerDown(search);
    else fireEvent.change(search, { target: { value: "re" } });
    fireEvent.keyDown(search, { key: "Escape" });
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(message).toHaveValue("");
  }
});
test("a prepared first message is pinned to the versions first seen, so later config drift raises the stale notice", async () => {
  navigate({ tab: "sessions", sessionId: "s" }, true);
  const key = messageDraftKey(2, "p", "s");
  useDraftStore.getState().put(key, {
    text: "First words", prepared: true, mode: "flow", flowId: "", flowVersion: 0, specDigest: "", criteriaDigest: "",
    consent: false, consentVersion: null, busyPolicy: "reject", sessionVersion: 0, configVersion: 0,
  });
  show();
  await screen.findByRole("heading", { name: "Test session" });
  await waitFor(() => expect(useDraftStore.getState().drafts[key]).toMatchObject({ prepared: false, sessionVersion: 2, configVersion: 1 }));
  expect(screen.queryByText(/Base versions changed/)).toBeNull();
  cleanup();
  const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) =>
    String(url).endsWith("/sessions/s")
      ? Response.json({ ...sessionFixture, config: { ...sessionFixture.config, configVersion: 2 } })
      : original(url, init));
  show();
  await screen.findByRole("heading", { name: "Test session" });
  expect(await screen.findByText(/Base versions changed/)).toBeVisible();
});

test("a chosen Flow that cannot be checked stays visible in the select and can be cleared there", async () => {
  const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) =>
    String(url).endsWith("/flows")
      ? Response.json({ error: { code: "unavailable", message: "Flows down" } }, { status: 503 })
      : original(url, init));
  useDraftStore.getState().put("remote-create:2:p", { ...launchDraft, flowId: "f1" });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "New session" }));
  expect(await screen.findByText(/Flows could not be loaded/)).toBeVisible();
  const select = screen.getByLabelText("Session Flow (optional)") as HTMLSelectElement;
  expect(select).toHaveValue("f1");
  expect(screen.getByRole("option", { name: "f1 · not checked yet" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Create session" })).toBeDisabled();
  fireEvent.change(select, { target: { value: "" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Create session" })).toBeEnabled());
  expect(screen.queryByText(/Flows could not be loaded/)).toBeNull();
});
