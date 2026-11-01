import { useState } from "react";
import { useDraftStore } from "../src/state/drafts";
import {
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
import { resetClient } from "../src/api/client";
import { ManagedWorkView } from "../src/features/managed-work/view";
import { liveWorkAdapter } from "../src/features/managed-work/adapter";
import { demoWorkAdapter } from "../src/features/managed-work/demo";
import { isWorkRecord } from "../src/features/managed-work/validation";
import {
  exactPassingCoverage,
  recordOf,
} from "../src/features/managed-work/model";

const capabilities = {
  protocolVersion: 1,
  enabled: true,
  allowedCommands: ["attempt.select", "review.decide"],
  limits: {},
  features: {
    managedExecution: false,
    gitObserver: false,
    legacyConversion: false,
  },
};
let records: Awaited<
  ReturnType<ReturnType<typeof demoWorkAdapter>["snapshot"]>
>["records"];
beforeEach(async () => {
  resetClient();
  useDraftStore.getState().clearAll();
  await i18n.changeLanguage("en");
  records = (await demoWorkAdapter("p").snapshot()).records;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (path) => {
    if (String(path).endsWith("/capabilities"))
      return Response.json(capabilities);
    if (String(path).includes("/snapshot"))
      return Response.json({
        records,
        eventCursor: "cursor1",
        nextCursor: null,
      });
    return Response.json({ error: { code: "not-found" } }, { status: 404 });
  });
});
function show(kind: "human" | "agent" = "human") {
  const value: HubContextValue = {
    principal: { id: kind + ":test", kind, role: "operator" },
    projectId: "p",
    scopeKey: 1,
    location: { projectId: "p", tab: "work" },
    navigate: vi.fn(),
    refresh: async () => undefined,
  };
  function TestScope() {
    const [location, setLocation] = useState(value.location);
    return (
      <HubContext.Provider
        value={{
          ...value,
          location,
          navigate: (patch) => setLocation((old) => ({ ...old, ...patch })),
        }}
      >
        <ManagedWorkView />
      </HubContext.Provider>
    );
  }
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TestScope />
    </QueryClientProvider>,
  );
}
test("demo fixtures validate and exact coverage never promotes contributor evidence from another subject", () => {
  expect(records.every(isWorkRecord)).toBe(true);
  const submission = recordOf(records, "submission", "sub-agent")!;
  expect(exactPassingCoverage(records, submission)).toBe(true);
  const evidence = recordOf(records, "evidence", "ev-agent")!;
  evidence.subjectDigest = "f".repeat(64);
  expect(exactPassingCoverage(records, submission)).toBe(false);
});
test("unsupported work API is explicit and demo requires a click", async () => {
  vi.mocked(fetch).mockResolvedValue(
    Response.json({ error: { code: "not-found" } }, { status: 404 }),
  );
  show();
  expect(
    await screen.findByText(/Managed work is not available/, {
      selector: "[role=status]",
    }),
  ).toBeVisible();
  expect(screen.queryByText("Keyboard accessibility")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Explore demo" }));
  expect(await screen.findByText("Demo · simulated data")).toBeVisible();
  expect(await screen.findByText("Keyboard accessibility")).toBeVisible();
});
test("selection and acceptance are separate; agent cannot issue human decisions", async () => {
  show("agent");
  fireEvent.click(
    await screen.findByRole("button", { name: /^Keyboard accessibility/ }),
  );
  expect(
    screen.getByRole("button", { name: "Select this attempt" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Accept exact result" }),
  ).toBeDisabled();
  expect(
    screen.getByText("Only an authorized human can make this decision."),
  ).toBeVisible();
  expect(
    screen.getAllByText(/Contributor report · not independent verification/)
      .length,
  ).toBeGreaterThan(0);
});
test("human review sends exact digests, all aggregate versions and identical header/body operation ID", async () => {
  vi.mocked(fetch).mockImplementation(async (path, init) => {
    if (String(path).endsWith("/commands"))
      return Response.json({
        status: "committed",
        operationId: JSON.parse(String(init?.body)).operationId,
        receiptId: "receipt",
        eventCursor: "cursor2",
      });
    if (String(path).endsWith("/capabilities"))
      return Response.json(capabilities);
    return Response.json({ records, eventCursor: "cursor1", nextCursor: null });
  });
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: /^Keyboard accessibility/ }),
  );
  expect(
    screen.getByRole("button", { name: "Accept exact result" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Select this attempt" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Decision reason" }), {
    target: { value: "Reviewed exact candidate" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([p]) => String(p).endsWith("/commands")),
    ).toBe(true),
  );
  const [, init] = vi
    .mocked(fetch)
    .mock.calls.find(([p]) => String(p).endsWith("/commands"))!;
  const body = JSON.parse(String(init?.body));
  expect(body.expectedVersions).toEqual({
    "flow-demo": 1,
    i1: 1,
    "a-agent": 1,
  });
  expect(body.payload.submissionDigest).toBe("a".repeat(64));
  expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(
    body.operationId,
  );
});
test("snapshot stages bounded pages and refuses mixed-project or inconsistent cursors", async () => {
  const adapter = liveWorkAdapter("p");
  vi.mocked(fetch)
    .mockResolvedValueOnce(
      Response.json({
        records: records.slice(0, 1),
        eventCursor: "cursor4",
        nextCursor: "page2",
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        records: records.slice(1),
        eventCursor: "cursor5",
        nextCursor: null,
      }),
    );
  await expect(adapter.snapshot()).rejects.toMatchObject({
    code: "invalid-response",
  });
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({
      records: [{ ...records[0], projectId: "foreign" }],
      eventCursor: "cursor4",
      nextCursor: null,
    }),
  );
  await expect(adapter.snapshot()).rejects.toMatchObject({
    code: "invalid-response",
  });
});
test("uncertain command survives navigation, lookup404 stays unknown and reconciliation never repeats mutation", async () => {
  let originalOperation = "";
  let lookupCommitted = false;
  vi.mocked(fetch).mockImplementation(async (path, init) => {
    if (String(path).endsWith("/commands")) {
      originalOperation = JSON.parse(String(init?.body)).operationId;
      throw new TypeError("connection lost");
    }
    if (String(path).includes("/operations/"))
      return lookupCommitted
        ? Response.json({
            operationId: originalOperation,
            status: "committed",
            receiptId: "original-receipt",
          })
        : Response.json({ error: { code: "not-found" } }, { status: 404 });
    if (String(path).endsWith("/capabilities"))
      return Response.json(capabilities);
    return Response.json({ records, eventCursor: "cursor1", nextCursor: null });
  });
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: /^Keyboard accessibility/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Select this attempt" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Decision reason" }), {
    target: { value: "Inspect exact candidate" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(
    await screen.findByRole("button", { name: "Check operation status" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Flows" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Check operation status" }),
  );
  expect(await screen.findByText(/operation outcome is unknown/)).toBeVisible();
  lookupCommitted = true;
  fireEvent.click(
    screen.getByRole("button", { name: "Check operation status" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Check operation status" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    vi
      .mocked(fetch)
      .mock.calls.filter(([p]) => String(p).endsWith("/commands")),
  ).toHaveLength(1);
  expect(
    vi
      .mocked(fetch)
      .mock.calls.filter(([p]) => String(p).includes("/operations/"))
      .every(([p]) => String(p).endsWith(originalOperation)),
  ).toBe(true);
});
test("changed requirement pins disable selection and show historical warning", async () => {
  const flow = recordOf(records, "flow", "flow-demo")!;
  flow.currentRevisionId = "new-fr";
  flow.approvedRevisionId = "new-fr";
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: /^Keyboard accessibility/ }),
  );
  expect(
    screen.getByRole("button", { name: "Select this attempt" }),
  ).toBeDisabled();
  expect(screen.getByText(/Requirements have changed/)).toBeVisible();
});
test("demo acceptance stays separate from final Flow acceptance and does not call live mutation", async () => {
  show();
  fireEvent.click(screen.getByRole("button", { name: "Explore demo" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /^Keyboard accessibility/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Select this attempt" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Decision reason" }), {
    target: { value: "Select candidate" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Accept exact result" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Decision reason" }), {
    target: { value: "Accept candidate" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(
    await screen.findByText("Accept candidate", { selector: "p" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Submit Flow for final review" }),
  ).toBeDisabled();
  expect(
    vi.mocked(fetch).mock.calls.some(([p]) => String(p).endsWith("/commands")),
  ).toBe(false);
});

test("human waiver requires an explicit permitted criterion and separate reason, without changing evidence", async () => {
  const intent = recordOf(records, "intent", "i1")!;
  intent.selectedSubmissionId = "sub-manual";
  recordOf(records, "intent-revision", "iri1")!.criteria[0].waivable = true;
  recordOf(records, "flow-revision", "fr1")!.criteria[0].waivable = true;
  vi.mocked(fetch).mockImplementation(async (path, init) => {
    if (String(path).endsWith("/commands")) {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        operationId: body.operationId,
        entities: [],
        eventCursor: "cursor",
        receiptId: "receipt",
      });
    }
    if (String(path).endsWith("/capabilities"))
      return Response.json(capabilities);
    return Response.json({ records, eventCursor: "cursor", nextCursor: null });
  });
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: /^Keyboard accessibility/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: /human:alex/ }));
  fireEvent.click(screen.getByRole("button", { name: "Accept exact result" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Decision reason" }), {
    target: { value: "Review exact candidate with explicit exception" },
  });
  expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Arrow keys and focus verified" }),
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: /Reason for this exception/ }),
    { target: { value: "Browser matrix will be verified separately" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([p]) => String(p).endsWith("/commands")),
    ).toBe(true),
  );
  const [, init] = vi
    .mocked(fetch)
    .mock.calls.find(([p]) => String(p).endsWith("/commands"))!;
  expect(JSON.parse(String(init?.body)).payload.waivers).toEqual([
    {
      criterionId: "ci1",
      reason: "Browser matrix will be verified separately",
    },
  ]);
  expect(recordOf(records, "evidence", "ev-manual")!.result).toBe(
    "inconclusive",
  );
  expect(
    exactPassingCoverage(
      records,
      recordOf(records, "submission", "sub-manual")!,
      ["ci1"],
    ),
  ).toBe(true);
  recordOf(records, "intent-revision", "iri1")!.criteria[0].waivable = false;
  expect(
    exactPassingCoverage(
      records,
      recordOf(records, "submission", "sub-manual")!,
      ["ci1"],
    ),
  ).toBe(false);
});

test("Flow start guards every approved required Intent version", async () => {
  recordOf(records, "flow", "flow-demo")!.state = "ready";
  recordOf(records, "intent", "i1")!.state = "ready";
  vi.mocked(fetch).mockImplementation(async (path, init) =>
    String(path).endsWith("/capabilities")
      ? Response.json({ ...capabilities, allowedCommands: ["flow.start"] })
      : String(path).endsWith("/commands")
        ? Response.json({
            operationId: JSON.parse(String(init?.body)).operationId,
            entities: [],
            eventCursor: "cursor2",
            receiptId: "receipt",
          })
        : Response.json({ records, eventCursor: "cursor1", nextCursor: null }),
  );
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: /^Keyboard accessibility/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Start Flow" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([p]) => String(p).endsWith("/commands")),
    ).toBe(true),
  );
  const [, init] = vi
    .mocked(fetch)
    .mock.calls.find(([p]) => String(p).endsWith("/commands"))!;
  expect(JSON.parse(String(init?.body)).expectedVersions).toEqual({
    "flow-demo": 1,
    i1: 1,
    i2: 1,
  });
});

test("full material requirement fields are visible before approval and route changes discard prepared decisions", async () => {
  const flow = recordOf(records, "flow", "flow-demo")!;
  flow.state = "draft";
  flow.approvedRevisionId = null;
  const revision = recordOf(records, "flow-revision", "fr1")!;
  revision.problem = "Critical problem marker";
  revision.scope = "Exact authorized scope marker";
  revision.outOfScope = "Excluded behavior marker";
  records.push({
    ...flow,
    id: "second-flow",
    title: "Different Flow",
    currentRevisionId: "fr2",
  });
  records.push({ ...revision, id: "fr2", flowId: "second-flow" });
  vi.mocked(fetch).mockImplementation(async (path) =>
    Response.json(
      String(path).endsWith("/capabilities")
        ? { ...capabilities, allowedCommands: ["requirements.approve"] }
        : { records, eventCursor: "cursor", nextCursor: null },
    ),
  );
  const value: HubContextValue = {
    principal: { id: "human:test", kind: "human", role: "operator" },
    projectId: "p",
    scopeKey: 98,
    location: { projectId: "p", tab: "work", flowId: "flow-demo" },
    navigate: vi.fn(),
    refresh: async () => undefined,
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (context: HubContextValue) => (
    <QueryClientProvider client={client}>
      <HubContext.Provider value={context}>
        <ManagedWorkView />
      </HubContext.Provider>
    </QueryClientProvider>
  );
  const mounted = render(tree(value));
  expect(
    await screen.findByText("Exact authorized scope marker"),
  ).toBeVisible();
  expect(screen.getByText("Critical problem marker")).toBeVisible();
  expect(screen.getByText("Excluded behavior marker")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Approve requirements" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Decision reason" }), {
    target: { value: "Review original Flow only" },
  });
  mounted.rerender(
    tree({ ...value, location: { ...value.location, flowId: "second-flow" } }),
  );
  expect(
    await screen.findByRole("heading", { name: "Different Flow" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("form", { name: "Approve requirements" }),
  ).not.toBeInTheDocument();
  expect(
    vi.mocked(fetch).mock.calls.some(([p]) => String(p).endsWith("/commands")),
  ).toBe(false);
  mounted.rerender(tree(value));
  fireEvent.click(
    await screen.findByRole("button", { name: "Approve requirements" }),
  );
  expect(screen.getByRole("textbox", { name: "Decision reason" })).toHaveValue(
    "Review original Flow only",
  );
});

test("Intent approval exposes approach, exclusions, exact parent digest and criterion mapping", async () => {
  recordOf(records, "intent", "i1")!.state = "draft";
  recordOf(records, "intent", "i1")!.approvedRevisionId = null;
  const revision = recordOf(records, "intent-revision", "iri1")!;
  revision.approach = "Material approach marker";
  revision.outOfScope = "Intent exclusions marker";
  vi.mocked(fetch).mockImplementation(async (path) =>
    Response.json(
      String(path).endsWith("/capabilities")
        ? { ...capabilities, allowedCommands: ["requirements.approve"] }
        : { records, eventCursor: "cursor", nextCursor: null },
    ),
  );
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: /^Keyboard accessibility/ }),
  );
  expect(
    screen
      .getAllByText("Material approach marker")
      .some(
        (e) =>
          e.closest("section")?.getAttribute("aria-label") ===
          "Complete requirements review",
      ),
  ).toBe(true);
  const review = within(
    screen.getByRole("region", { name: "Complete requirements review" }),
  );
  expect(
    review.getByText("Intent exclusions marker", { selector: "dd" }),
  ).toBeVisible();
  expect(review.getByText("Pinned parent Flow revision")).toBeVisible();
  expect(review.getByText("ci1 → fc1")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Approve requirements" }),
  ).toBeEnabled();
});

test("unsubmitted Attempt detail shows the latest exact subject selected by submission preparation",async()=>{
 const attempt=recordOf(records,"attempt","a-agent")!;attempt.submissionId=null;
 const subject=recordOf(records,"subject","subject-agent")!;subject.report="Older result marker";
 records.push({...subject,id:"latest-subject",report:"Latest result marker",contentDigest:"b".repeat(64)});
 const value:HubContextValue={principal:{id:"human:test",kind:"human",role:"operator"},projectId:"p",scopeKey:65,location:{projectId:"p",tab:"work",flowId:"flow-demo",intentId:"i1",attemptId:"a-agent"},navigate:vi.fn(),refresh:async()=>undefined};
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><HubContext.Provider value={value}><ManagedWorkView/></HubContext.Provider></QueryClientProvider>);
 expect(await screen.findByText("Latest result marker")).toBeVisible();
 expect(screen.queryByText("Older result marker")).not.toBeInTheDocument();
});
