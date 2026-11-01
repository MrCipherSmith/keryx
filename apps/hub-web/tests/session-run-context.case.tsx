import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, test, vi } from "vitest";
import type { RunRecord } from "../../../src/remote-control/protocol";
import { HubContext, type HubContextValue } from "../src/app/hub-context";
import {
  SessionRunContext,
  type SessionRunMode,
} from "../src/features/remote/session-run-context";
import { useController } from "../src/features/remote/shared";
import { sessionFixture } from "./remote-fixtures";
import type { Control } from "../src/api/remote";
import i18n from "../src/i18n";
const navigate = vi.fn();
const context: HubContextValue = {
  projectId: "p",
  principal: { id: "reviewer", kind: "human", role: "reviewer" },
  scopeKey: 1,
  location: { projectId: "p", tab: "sessions", sessionId: "s" },
  navigate,
  refresh: async () => undefined,
};
const run: RunRecord = {
  runId: "r",
  turnId: "t",
  sessionId: "s",
  projectId: "p",
  checkoutId: "c",
  machineId: "m",
  version: 2,
  state: "waiting-approval",
  lastLocalSeq: 0,
  association: {
    mode: "flow",
    flowId: "flow-exact",
    expectedFlowVersion: 2,
    specDigest: "a".repeat(64),
    criteriaDigest: "b".repeat(64),
  },
  snapshot: {
    config: sessionFixture.config,
    configDigest: "a".repeat(64),
    effectiveCandidateId: "local",
    routingDecision: "baseline",
    fallbackReason: "none",
    selectionReceiptId: "selection",
  },
  partial: false,
  connected: true,
  approvals: [
    {
      approvalId: "approval",
      runId: "r",
      sessionId: "s",
      turnId: "t",
      actionFingerprint: "a".repeat(64),
      policyDigest: "b".repeat(64),
      expiresAt: "2099-01-01T00:00:00Z",
      summary: "Approval for exact action",
      localRequired: false,
      status: "waiting",
    },
  ],
};
function Surface({
  record,
  mode,
}: {
  record: Control["SessionRecord"];
  mode: SessionRunMode;
}) {
  const control = useController(record);
  return <SessionRunContext record={record} control={control} mode={mode} />;
}
function show(
  record: Control["SessionRecord"] = { ...sessionFixture, activeRunId: "r" },
  mode: SessionRunMode = "context",
) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <HubContext.Provider value={context}>
        <Surface record={record} mode={mode} />
      </HubContext.Provider>
    </QueryClientProvider>,
  );
}
beforeEach(async () => {
  vi.restoreAllMocks();
  navigate.mockReset();
  await act(() => i18n.changeLanguage("en"));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    String(input).endsWith("/runs/r")
      ? Response.json(run)
      : Response.json({ events: [], cursor: 0, gap: null }),
  );
});
test("no active run stays honest and does not query a guessed last run", () => {
  show(sessionFixture);
  expect(screen.getByText("There is no active run right now.")).toBeVisible();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Run history" }));
  expect(navigate).toHaveBeenCalledWith({
    tab: "runs",
    sessionId: undefined,
    runId: undefined,
  });
});
test("Flow link preserves project and exact current-run Flow identity", async () => {
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Current run Flow: flow-exact" }),
  );
  expect(navigate).toHaveBeenCalledWith({
    projectId: "p",
    tab: "flows",
    flowId: "flow-exact",
    runId: undefined,
    sessionId: undefined,
  });
});
test("reuses approval guards and keeps action visible in checks tab for observer", async () => {
  show({ ...sessionFixture, activeRunId: "r" }, "checks");
  expect(await screen.findByText("Approval for exact action")).toBeVisible();
  expect(screen.getByRole("button", { name: "Allow once" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
  expect(
    screen.getByText(
      "The run has not published a result receipt and check references yet.",
    ),
  ).toBeVisible();
});
test("result reference opens exact revision and identifies self-reported checks separately", async () => {
  vi.mocked(globalThis.fetch).mockImplementation(async (input) =>
    String(input).endsWith("/runs/r")
      ? Response.json({
          ...run,
          approvals: [],
          result: {
            receiptId: "receipt",
            runId: "r",
            sessionId: "s",
            turnId: "t",
            revisionId: "revision-exact",
            checksKind: "RunChecks",
            flowId: null,
            evidenceId: null,
            partial: false,
          },
        })
      : Response.json({ events: [], cursor: 0, gap: null }),
  );
  const view = show({ ...sessionFixture, activeRunId: "r" }, "changes");
  fireEvent.click(await screen.findByRole("button", { name: "View changes" }));
  expect(navigate).toHaveBeenCalledWith({
    projectId: "p",
    tab: "code",
    revisionId: "revision-exact",
    runId: undefined,
    sessionId: undefined,
  });
  view.unmount();
  show({ ...sessionFixture, activeRunId: "r" }, "checks");
  expect(
    await screen.findByText(
      "Checks are reported by the executor. They do not replace human acceptance.",
    ),
  ).toBeVisible();
});
