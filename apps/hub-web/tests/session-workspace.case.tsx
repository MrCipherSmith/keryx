import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { beforeEach, expect, test, vi } from "vitest";
import i18n from "../src/i18n";
import { HubContext, type HubContextValue } from "../src/app/hub-context";
import { SessionSurface } from "../src/features/remote/sessions";
import { sessionFixture, machineFixture } from "./remote-fixtures";
import { resetClient } from "../src/api/client";
import { useDraftStore } from "../src/state/drafts";
import { parseCssRules, selectorAlternatives } from "./css-rules";
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
    if (path.includes("/history?before=2"))
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
        hasMore: false,
        historyVersion: 1,
        retainedFromCursor: 0,
        gap: false,
      });
    if (path.includes("/history?before=latest"))
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
        hasMore: true,
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
test("history opens at the latest page, then prepends earlier messages with explicit roles", async () => {
  show();
  const history = screen.getByRole("region", { name: "History" });
  expect(await within(history).findByText("Reply from agent")).toBeVisible();
  expect(within(history).queryByText("First message")).not.toBeInTheDocument();
  fireEvent.click(within(history).getByRole("button", { name: "Older messages" }));
  expect(await within(history).findByText("First message")).toBeVisible();
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
  await screen.findByText("Reply from agent");
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
// jsdom applies no CSS, so this checks the parsed stylesheet rules and the DOM shape they rely on:
// only the composer's own panel header may be hidden; the nested Commands and Confirmation Panels keep their headings.
test("composer header rule hides only the composer's own panel header", async () => {
  const { container } = show();
  await screen.findByText("Reply from agent");
  const rules = parseCssRules(
    readFileSync("src/features/remote/session-workspace.css", "utf8"),
  );
  const hiding = rules
    .filter(
      (rule) =>
        /^none(\s*!important)?$/i.test(rule.decls.get("display") ?? "") ||
        /^hidden(\s*!important)?$/i.test(rule.decls.get("visibility") ?? ""),
    )
    .flatMap((rule) => selectorAlternatives(rule.selector))
    .filter((alternative) => alternative.includes(".hub-panel-header"));
  expect(hiding.length).toBeGreaterThan(0);
  for (const alternative of hiding)
    expect(alternative).toBe(".session-composer > .hub-panel > .hub-panel-header");
  const composer = container.querySelector(".session-composer") as HTMLElement;
  fireEvent.click(
    within(composer).getByRole("button", { name: "Native command catalogue" }),
  );
  await waitFor(() =>
    expect(composer.querySelectorAll(".hub-panel .hub-panel .hub-panel-header").length).toBeGreaterThan(0),
  );
  const own = [...composer.querySelectorAll(":scope > .hub-panel > .hub-panel-header")];
  expect(own.length).toBeGreaterThan(0);
  for (const header of composer.querySelectorAll(".hub-panel .hub-panel .hub-panel-header"))
    expect(own).not.toContain(header);
});
// jsdom applies no CSS: fold the rules of the 600px media block per selector (source order, last wins).
// The wrap has to sit on the header row that is actually constrained (and its actions must be allowed
// to shrink), or it is inert at 481-600px.
test("the 600px header rules wrap the header row and let the actions shrink", () => {
  const rules = parseCssRules(readFileSync("src/features/remote/session-workspace.css", "utf8"));
  const folded = (selector: string) => {
    const out = new Map<string, string>();
    for (const rule of rules)
      if (
        rule.media.some((head) => head.replace(/\s/g, "").includes("(max-width:600px)")) &&
        selectorAlternatives(rule.selector).includes(selector)
      )
        for (const [prop, value] of rule.decls) out.set(prop, value);
    return out;
  };
  expect(folded(".session-workbench-header").get("flex-wrap")).toBe("wrap");
  const actions = folded(".session-header-actions");
  expect(actions.get("flex-shrink")).toBe("1");
  expect(actions.get("min-width")).toBe("0");
});
