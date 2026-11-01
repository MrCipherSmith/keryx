import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, test, vi } from "vitest";
import i18n from "../src/i18n";
import { HubContext, type HubContextValue } from "../src/app/hub-context";
import { ProjectOverview } from "../src/features/project-overview";
import { resetClient } from "../src/api/client";
import { machineFixture } from "./remote-fixtures";
const navigate = vi.fn();
const flow = {
  id: "f",
  projectId: "p",
  title: "Review exact result",
  specDocumentId: "d",
  specContentDigest: "a".repeat(64),
  criteria: ["First", "Second"],
  status: "implemented",
  version: 4,
  subjectRevisionId: "r",
};
const document = {
  id: "d",
  projectId: "p",
  path: "specs/auth.md",
  kind: "spec",
  version: 2,
};
const proposal = {
  id: "proposal",
  projectId: "p",
  documentId: "d",
  status: "pending",
  reason: "Clarify authentication lifetime",
};
function show() {
  const context = {
    projectId: "p",
    principal: { id: "human:test", kind: "human", role: "operator" },
    scopeKey: 12,
    location: { projectId: "p", tab: "overview" },
    navigate,
    refresh: async () => undefined,
  } satisfies HubContextValue;
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <HubContext.Provider value={context}>
        <ProjectOverview />
      </HubContext.Provider>
    </QueryClientProvider>,
  );
}
beforeEach(async () => {
  resetClient();
  navigate.mockReset();
  await i18n.changeLanguage("en");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input);
    if (path.endsWith("/projects/p"))
      return Response.json({
        id: "p",
        name: "Atlas",
        lineVersion: 2,
        lineRevisionId: "r",
      });
    if (path.endsWith("/flows")) return Response.json({ flows: [flow] });
    if (path.endsWith("/documents"))
      return Response.json({ documents: [document] });
    if (path.endsWith("/proposals"))
      return Response.json({ proposals: [proposal] });
    if (path.endsWith("/revisions?summary=1"))
      return Response.json({
        revisions: [
          { id: "r", message: "Auth candidate", purpose: "review-bundle" },
        ],
      });
    if (path.includes("/machines?"))
      return Response.json({ machines: [machineFixture] });
    return Response.json(
      { error: { code: "not-found", message: "missing" } },
      { status: 404 },
    );
  });
});
test("project decisions navigate to the exact Flow and actual proposal queue with project scope", async () => {
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Review result" }));
  expect(navigate).toHaveBeenLastCalledWith(
    expect.objectContaining({ projectId: "p", tab: "flows", flowId: "f" }),
  );
  expect(await screen.findByText(proposal.reason)).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Review proposed changes" }),
  );
  expect(navigate).toHaveBeenLastCalledWith(
    expect.objectContaining({
      projectId: "p",
      tab: "proposals",
      flowId: undefined,
    }),
  );
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});
test("machine or context failure preserves available Flows and explicit review actions", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) =>
    String(input).includes("/machines?") || String(input).endsWith("/documents")
      ? Response.json(
          { error: { code: "unavailable", message: "not available" } },
          { status: 503 },
        )
      : original(input, init),
  );
  show();
  expect(
    await screen.findByRole("button", { name: "Review result" }),
  ).toBeVisible();
  expect(
    await screen.findByText("Machines could not be loaded."),
  ).toBeVisible();
  expect(screen.getAllByText("Review exact result").length).toBeGreaterThan(0);
  expect(
    screen.queryByText("No pending Flow or context decisions."),
  ).not.toBeInTheDocument();
});
test("context and revision shortcuts retain exact entity identity and metadata-only loading", async () => {
  const spy = vi.mocked(fetch);
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: /specs\/auth\.md/ }),
  );
  expect(navigate).toHaveBeenLastCalledWith(
    expect.objectContaining({
      projectId: "p",
      tab: "documents",
      documentId: "d",
    }),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: /Auth candidate/,
    }),
  );
  expect(navigate).toHaveBeenLastCalledWith(
    expect.objectContaining({ projectId: "p", tab: "code", revisionId: "r" }),
  );
  await waitFor(() =>
    expect(
      spy.mock.calls.some(([path]) =>
        String(path).endsWith("/revisions?summary=1"),
      ),
    ).toBe(true),
  );
  expect(
    spy.mock.calls.some(([path]) => String(path).endsWith("/revisions")),
  ).toBe(false);
});
