import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import i18n from "../src/i18n";
import { renderHub } from "./hub-render";
import { type HubContextValue } from "../src/app/hub-context";
import { MachinesView } from "../src/features/remote/machines";
import { machineFixture, sessionFixture } from "./remote-fixtures";
import { resetClient } from "../src/api/client";
const navigate = vi.fn();
let projectId: string | null = "p";
const requests: string[] = [];
function show() {
  const context = {
    projectId,
    principal: { id: "human:test", kind: "human", role: "operator" },
    scopeKey: 10,
    location: { projectId, tab: "machines" },
    navigate,
    refresh: async () => undefined,
  } satisfies HubContextValue;
  return renderHub(<MachinesView />, context);
}
beforeEach(async () => {
  projectId = "p";
  requests.length = 0;
  resetClient();
  navigate.mockClear();
  await i18n.changeLanguage("en");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const path = String(url);
    requests.push(path);
    if (path.endsWith("/projects"))
      return Response.json({
        projects: [
          { id: "p", name: "Atlas" },
          { id: "b", name: "Beacon" },
        ],
      });
    if (path.includes("/machines"))
      return Response.json({
        machines: [{ ...machineFixture, projectIds: ["p", "b"] }],
      });
    if (path.includes("/projects/p/sessions?"))
      return Response.json({
        sessions: [sessionFixture],
        cursor: 1,
        hasMore: false,
      });
    if (path.includes("/projects/b/sessions?"))
      return Response.json({
        sessions: [
          {
            ...sessionFixture,
            sessionId: "other",
            projectId: "b",
            title: "Beacon session",
          },
        ],
        cursor: 1,
        hasMore: false,
      });
    return Response.json(
      { error: { code: "not-found", message: "missing" } },
      { status: 404 },
    );
  });
});
test("machine card nests session agent model checkout and exact project navigation", async () => {
  show();
  expect(
    await screen.findByRole("button", { name: "Test session" }),
  ).toBeVisible();
  expect(screen.getByText("native")).toBeVisible();
  expect(screen.getByText("Baseline model: local")).toBeVisible();
  expect(screen.getAllByText("Main")[0]).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Test session" }));
  expect(navigate).toHaveBeenCalledWith({
    projectId: "p",
    tab: "sessions",
    sessionId: "s",
    machineId: undefined,
    runId: undefined,
  });
});
test("global machine remains one card with sessions from both authorized projects", async () => {
  projectId = null;
  show();
  expect(
    await screen.findByRole("button", { name: "Beacon session" }),
  ).toBeVisible();
  expect(screen.getAllByRole("heading", { name: "Laptop" })).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Test session" })).toBeVisible();
  expect(requests.some((p) => p.endsWith("/hub/v2/machines"))).toBe(true);
});
test("session page errors remain explicit and do not claim that machine has no sessions", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) =>
    String(url).includes("/sessions")
      ? Response.json(
          {
            error: { code: "unavailable", message: "Session list unavailable" },
          },
          { status: 503 },
        )
      : original(url, init),
  );
  show();
  expect(await screen.findByRole("button", { name: "Retry" })).toBeVisible();
  expect(
    screen.queryByText("No sessions in this project"),
  ).not.toBeInTheDocument();
});
test("more sessions appends a page without hiding the first page", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) =>
    String(url).includes("/projects/p/sessions?")
      ? Response.json(
          String(url).endsWith("after=0")
            ? { sessions: [sessionFixture], cursor: 1, hasMore: true }
            : {
                sessions: [
                  {
                    ...sessionFixture,
                    sessionId: "s2",
                    title: "Second session",
                  },
                ],
                cursor: 2,
                hasMore: false,
              },
        )
      : original(url, init),
  );
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Load next page · Atlas" }),
  );
  expect(
    await screen.findByRole("button", { name: "Second session" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Test session" })).toBeVisible();
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Load next page · Atlas" }),
    ).not.toBeInTheDocument(),
  );
});

test("Flow association comes only from the active run and approval state is distinct from idle", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.includes("/projects/p/sessions?"))
      return Response.json({
        sessions: [{ ...sessionFixture, activeRunId: "r", state: "busy" }],
        cursor: 1,
        hasMore: false,
      });
    if (path.endsWith("/runs/r"))
      return Response.json({
        runId: "r",
        sessionId: "s",
        projectId: "p",
        machineId: "m",
        checkoutId: "c",
        state: "waiting-approval",
        association: {
          mode: "flow",
          flowId: "f",
          expectedFlowVersion: 1,
          specDigest: "a".repeat(64),
          criteriaDigest: "a".repeat(64),
        },
      });
    return original(url, init);
  });
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Details: Test session" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Active run Flow: f" }),
  );
  expect(navigate).toHaveBeenCalledWith({
    projectId: "p",
    tab: "flows",
    flowId: "f",
  });
  expect(screen.getByText("Waiting for approval")).toBeVisible();
});

test("machine metadata resolves a candidate digest to provider and model without displaying the full digest", async () => {
  const candidateId = "a".repeat(64);
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.includes("/projects/p/sessions?"))
      return Response.json({
        sessions: [
          {
            ...sessionFixture,
            config: {
              ...sessionFixture.config,
              baselineCandidateId: candidateId,
            },
          },
        ],
        cursor: 1,
        hasMore: false,
      });
    if (path.endsWith("/sessions/s/routing"))
      return Response.json({
        version: 1,
        policyDigest: candidateId,
        capabilityDigest: candidateId,
        profileIds: ["native"],
        candidates: [
          {
            candidateId,
            providerId: "anthropic",
            modelId: "claude-sonnet-4",
            reasoningEfforts: ["medium"],
            available: true,
            reason: "none",
            privacyClass: "approved-egress",
            costClass: "metered",
          },
        ],
      });
    return original(url, init);
  });
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Details: Test session" }),
  );
  expect(await screen.findByText("anthropic / claude-sonnet-4")).toBeVisible();
  expect(screen.queryByText(candidateId)).not.toBeInTheDocument();
});

test("one hundred machine sessions fetch details only for an explicitly expanded row", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) =>
    String(url).includes("/projects/p/sessions?")
      ? Response.json({
          sessions: Array.from({ length: 100 }, (_, index) => ({
            ...sessionFixture,
            sessionId: "s" + index,
            title: "Session " + index,
            activeRunId: "r" + index,
          })),
          cursor: 100,
          hasMore: false,
        })
      : original(url, init),
  );
  show();
  await screen.findByRole("button", { name: "Session 99" });
  expect(
    requests.filter(
      (path) => path.includes("/routing") || path.includes("/runs/"),
    ),
  ).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Details: Session 0" }));
  await waitFor(() =>
    expect(
      requests.filter(
        (path) => path.includes("/routing") || path.includes("/runs/"),
      ),
    ).toHaveLength(2),
  );
});
