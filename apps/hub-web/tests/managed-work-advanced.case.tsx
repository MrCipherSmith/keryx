import { type ReactNode } from "react";
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
import { ApiError, resetClient } from "../src/api/client";
import { useWorkEvents } from "../src/features/managed-work/updates";
import { useDraftStore } from "../src/state/drafts";
import { liveWorkAdapter } from "../src/features/managed-work/adapter";
import { demoWorkAdapter } from "../src/features/managed-work/demo";
import { recordOf } from "../src/features/managed-work/model";
import { AmendmentsPanel } from "../src/features/managed-work/amendments";
import { GitObservations } from "../src/features/managed-work/observations";
import { WorkOperationStatus } from "../src/features/managed-work/operation";
import { ExactDocument } from "../src/features/managed-work/revision-review";
import { ManagedAttentionOverview } from "../src/features/managed-work/overview-attention";
import { LegacyConversion } from "../src/features/managed-work/legacy";
import type {
  AmendmentManifest,
  GitObservation,
  WorkRecord,
} from "../src/features/managed-work/types";

let records: WorkRecord[];
const navigate = vi.fn();
const adapter = liveWorkAdapter("p");
beforeEach(async () => {
  resetClient();
  useDraftStore.getState().clearAll();
  navigate.mockClear();
  await i18n.changeLanguage("en");
  records = (await demoWorkAdapter("p").snapshot()).records;
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ error: { code: "not-found" } }, { status: 404 }),
  );
});
function show(children: ReactNode, kind: "human" | "agent" = "human") {
  const value: HubContextValue = {
    projectId: "p",
    principal: { id: kind + ":test", kind, role: "operator" },
    scopeKey: 44,
    location: { projectId: "p", tab: "work", flowId: "flow-demo" },
    navigate,
    refresh: async () => undefined,
  };
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <HubContext.Provider value={value}>{children}</HubContext.Provider>
    </QueryClientProvider>,
  );
}
function amendment(): AmendmentManifest {
  const f = recordOf(records, "flow", "flow-demo")!;
  f.currentRevisionId = "fr2";
  const fr = recordOf(records, "flow-revision", "fr1")!;
  records.push({
    ...fr,
    id: "fr2",
    revision: 2,
    scope: "New scope visible before whole-set approval",
    contentDigest: "b".repeat(64),
  });
  for (const id of ["i1", "i2"]) {
    const i = recordOf(records, "intent", id)!;
    const ir = recordOf(records, "intent-revision", i.currentRevisionId)!;
    i.currentRevisionId = ir.id + "v2";
    records.push({
      ...ir,
      id: i.currentRevisionId,
      flowRevisionId: "fr2",
      revision: 2,
      contentDigest: "c".repeat(64),
    });
  }
  const m: AmendmentManifest = {
    id: "amendment1",
    projectId: "p",
    kind: "amendment",
    createdBy: "human:test",
    createdAt: "2026-11-01T00:00:00Z",
    flowId: f.id,
    sourceFlowRevisionId: "fr1",
    affectedIntentIds: ["i1", "i2"],
    replacements: [
      {
        targetType: "flow",
        targetId: f.id,
        revisionId: "fr2",
        contentDigest: "b".repeat(64),
      },
      ...(["i1", "i2"] as const).map((id) => ({
        targetType: "intent" as const,
        targetId: id,
        revisionId: recordOf(records, "intent", id)!.currentRevisionId,
        contentDigest: "c".repeat(64),
      })),
    ],
    reason: "Exact whole-set change",
    contentDigest: "d".repeat(64),
  };
  records.push(m);
  return m;
}
test("whole-set amendment exposes complete replacement semantics and resolves with all versions and exact digest", async () => {
  const manifest = amendment();
  vi.mocked(fetch).mockImplementation(async (_path, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({
      operationId: body.operationId,
      entities: [],
      receiptId: "r",
      eventCursor: "opaque",
    });
  });
  const done = vi.fn();
  show(
    <AmendmentsPanel
      adapter={adapter}
      flow={recordOf(records, "flow", "flow-demo")!}
      records={records}
      can={() => true}
      onDone={done}
    />,
  );
  expect(
    screen.getByText("New scope visible before whole-set approval"),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Approve whole set" }),
  ).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "Decision reason" }), {
    target: { value: "Review all exact replacements together" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Withdraw whole set" }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
  expect(body.command).toBe("requirements.resolve-amendment");
  expect(body.expectedVersions).toEqual({ "flow-demo": 1, i1: 1, i2: 1 });
  expect(body.payload).toMatchObject({
    amendmentId: manifest.id,
    manifestDigest: manifest.contentDigest,
    decision: "withdraw",
  });
  expect(recordOf(records, "flow", "flow-demo")!.approvedRevisionId).toBe(
    "fr1",
  );
});
test("an agent cannot approve or withdraw a pending amendment even when command hints are permissive", () => {
  amendment();
  show(
    <AmendmentsPanel
      adapter={adapter}
      flow={recordOf(records, "flow", "flow-demo")!}
      records={records}
      can={() => true}
      onDone={() => undefined}
    />,
    "agent",
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Decision reason" }), {
    target: { value: "Agent cannot authorize" },
  });
  expect(
    screen.getByRole("button", { name: "Approve whole set" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Withdraw whole set" }),
  ).toBeDisabled();
});
test("Flow replacement cannot be authorized with an incomplete set of approved dependent Intents", () => {
  amendment();
  records = records.filter((r) => r.kind !== "amendment");
  recordOf(records, "intent", "i2")!.currentRevisionId = "iri2";
  show(
    <AmendmentsPanel
      adapter={adapter}
      flow={recordOf(records, "flow", "flow-demo")!}
      records={records}
      can={() => true}
      onDone={() => undefined}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Authorize exact amendment set" }),
  ).toBeDisabled();
  expect(screen.getByText(/Update every approved deliverable/)).toBeVisible();
});
function observation(): GitObservation {
  return {
    id: "obs1",
    projectId: "p",
    subjectId: "subject-agent",
    subjectDigest: "a".repeat(64),
    createdBy: "human:test",
    observedAt: "2026-11-01T00:00:00Z",
    generation: 1,
    contentDigest: "a".repeat(64),
    artifacts: [
      {
        repositoryId: "atlas/frontend",
        commitOid: "b".repeat(40),
        treeOid: null,
        policyDigest: null,
        availability: "unavailable",
        reasonCode: "provider-unavailable",
        pullRequest: {
          number: 42,
          headOid: "c".repeat(40),
          baseRepositoryId: 1,
          headRepositoryId: 1,
          state: "open",
          updatedAt: "2026-11-01T00:00:00Z",
        },
        ci: { availability: "unavailable", runs: [] },
      },
    ],
  };
}
test("Git observation shows inaccessible objects and moved PR heads separately from immutable reviewed result", async () => {
  const obs = observation();
  vi.mocked(fetch).mockImplementation(async (path, init) =>
    String(path).endsWith("/observe")
      ? Response.json({
          operationId: JSON.parse(String(init?.body)).operationId,
          observation: obs,
          receiptId: "r",
          eventCursor: "opaque",
        })
      : Response.json({
          observations: [obs],
          nextCursor: null,
          eventCursor: "opaque",
        }),
  );
  show(
    <GitObservations
      adapter={adapter}
      subject={recordOf(records, "subject", "subject-agent")!}
      versions={{ "a-agent": 1 }}
      enabled
      canObserve
      onDone={() => undefined}
    />,
  );
  expect(await screen.findByText(/PR head has moved/)).toBeVisible();
  expect(screen.getByText("Object availability: Unavailable")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh provider observation" }),
  );
  await waitFor(() =>
    expect(
      vi.mocked(fetch).mock.calls.some(([p]) => String(p).endsWith("/observe")),
    ).toBe(true),
  );
  const [, init] = vi
    .mocked(fetch)
    .mock.calls.find(([p]) => String(p).endsWith("/observe"))!;
  const body = JSON.parse(String(init?.body));
  expect(body).toEqual({
    operationId: expect.any(String),
    expectedVersions: { "a-agent": 1 },
    payload: { subjectDigest: "a".repeat(64) },
  });
  expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(
    body.operationId,
  );
  expect(recordOf(records, "subject", "subject-agent")!.contentDigest).toBe(
    "a".repeat(64),
  );
  expect(recordOf(records, "evidence", "ev-agent")!.source).toBe(
    "contributor-report",
  );
});
test("pending observation retains operation identity and checks status without another provider request", async () => {
  let id = "";
  vi.mocked(fetch).mockImplementation(async (path, init) => {
    if (String(path).endsWith("/observe")) {
      id = JSON.parse(String(init?.body)).operationId;
      return Response.json(
        {
          operationId: id,
          status: "pending",
          receiptId: null,
          result: null,
          eventCursor: null,
        },
        { status: 202 },
      );
    }
    if (String(path).includes("/operations/"))
      return Response.json(
        {
          operationId: id,
          status: "pending",
          receiptId: null,
          result: null,
          eventCursor: null,
        },
        { status: 202 },
      );
    return Response.json({
      observations: [],
      nextCursor: null,
      eventCursor: "opaque",
    });
  });
  show(
    <>
      <WorkOperationStatus adapter={adapter} onCommitted={() => undefined} />
      <GitObservations
        adapter={adapter}
        subject={recordOf(records, "subject", "subject-agent")!}
        versions={{ "a-agent": 1 }}
        enabled
        canObserve
        onDone={() => undefined}
      />
    </>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh provider observation" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Check operation status" }),
  );
  await waitFor(() =>
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([p]) => String(p).includes("/operations/")),
    ).toBe(true),
  );
  expect(
    vi.mocked(fetch).mock.calls.filter(([p]) => String(p).endsWith("/observe")),
  ).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "Refresh provider observation" }),
  ).toBeDisabled();
});
test("exact document reader refuses a latest/different version and never falls back to legacy document API", async () => {
  vi.mocked(fetch).mockResolvedValue(
    Response.json({
      document: {
        id: "doc",
        projectId: "p",
        path: "specs/doc.md",
        kind: "spec",
        version: 2,
        contentDigest: "b".repeat(64),
        content: "Incorrect latest version",
      },
      eventCursor: "opaque",
    }),
  );
  show(
    <ExactDocument
      adapter={adapter}
      reference={{
        documentId: "doc",
        version: 1,
        contentDigest: "a".repeat(64),
      }}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Read exact archived version/ }),
  );
  expect(
    await screen.findByText(/latest version has not been substituted/),
  ).toBeVisible();
  expect(
    screen.queryByText("Incorrect latest version"),
  ).not.toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
  expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain(
    "/documents/doc/versions/1?digest=",
  );
});
test("Overview bounds project fanout and links canonical attention to exact project/Flow/Attempt", async () => {
  const projects = Array.from({ length: 10 }, (_, index) => ({
    id: "p" + index,
    name: "Project " + index,
  }));
  vi.mocked(fetch).mockImplementation(async (path) => {
    const p = String(path);
    if (p.endsWith("/capabilities"))
      return Response.json({
        protocolVersion: 1,
        enabled: true,
        allowedCommands: [],
        limits: {},
        features: {
          managedExecution: false,
          gitObserver: false,
          legacyConversion: false,
        },
      });
    if (p.includes("/events?"))
      return Response.json({ events: [], nextCursor: "events" });
    const project = p.split("/projects/")[1].split("/")[0];
    return Response.json({
      records:
        project === "p0"
          ? [
              {
                ...recordOf(records, "attempt", "a-agent")!,
                projectId: "p0",
                summary: "Blocked managed work",
                state: "blocked",
              },
            ]
          : [],
      nextCursor: null,
      eventCursor: "cursor-" + project,
    });
  });
  show(<ManagedAttentionOverview projects={projects} />);
  fireEvent.click(
    await screen.findByRole("button", { name: /Blocked managed work/ }),
  );
  expect(navigate).toHaveBeenCalledWith({
    projectId: "p0",
    tab: "work",
    flowId: "flow-demo",
    intentId: "i1",
    attemptId: "a-agent",
  });
  expect(
    vi
      .mocked(fetch)
      .mock.calls.filter(([p]) => String(p).endsWith("/capabilities")),
  ).toHaveLength(8);
  expect(screen.getByText("Showing 8 of 10 authorized projects")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Next projects" }));
  expect(
    await screen.findByText("Showing 2 of 10 authorized projects"),
  ).toBeVisible();
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(([p]) => String(p).includes("private-project")),
  ).toBe(false);
});
test("human legacy conversion requires an exact durable preview and defines a new draft without accepting old work", async () => {
  const preview = {
    receiptId: "dry-run-receipt",
    contentDigest: "a".repeat(64),
    legacyFlowId: "legacy",
    sourceVersion: 3,
    sourceDigest: "b".repeat(64),
    status: "eligible",
    source: {
      flowId: "legacy",
      title: "Old Flow",
      specification: {
        documentId: "doc",
        version: 2,
        contentDigest: "c".repeat(64),
      },
      criteria: ["First source criterion", "Second source criterion"],
      status: "ready",
    },
  };
  vi.mocked(fetch).mockImplementation(async (path, init) => {
    if (String(path).endsWith("/flows"))
      return Response.json({
        flows: [
          { id: "legacy", title: "Old Flow", status: "ready", version: 3 },
        ],
      });
    const body = JSON.parse(String(init?.body));
    return Response.json({
      operationId: body.operationId,
      entities: [],
      receiptId: "outer-receipt",
      eventCursor: "opaque",
      ...(body.command === "legacy.preview" ? { preview } : {}),
    });
  });
  show(
    <LegacyConversion
      adapter={adapter}
      records={records}
      onDone={() => undefined}
    />,
  );
  fireEvent.click(screen.getByText("Convert an existing Flow"));
  fireEvent.click(
    await screen.findByRole("button", { name: "Preview conversion" }),
  );
  expect(await screen.findByText("First source criterion")).toBeVisible();
  expect(
    vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
  for (const [name, value] of [
    ["Title", "Explicit deliverable"],
    ["Deliverable", "Manual new work"],
    ["Approach", "New guarded attempt"],
    ["Out of scope", "No prior acceptance transfer"],
    ["Criterion text", "Verify all source criteria"],
  ] as const)
    fireEvent.change(screen.getByRole("textbox", { name }), {
      target: { value },
    });
  fireEvent.click(
    screen.getByRole("button", { name: "Convert this exact source" }),
  );
  await waitFor(() =>
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(2),
  );
  const body = JSON.parse(
    String(
      vi
        .mocked(fetch)
        .mock.calls.filter(([, init]) => init?.method === "POST")[1][1]?.body,
    ),
  );
  expect(body.command).toBe("legacy.convert");
  expect(body.payload).toMatchObject({
    sourceVersion: 3,
    dryRunReceiptId: "dry-run-receipt",
    dryRunDigest: "a".repeat(64),
    intent: { required: true, flowCriterionIds: ["legacy-1", "legacy-2"] },
  });
});

test("work events retry with bounded backoff and stop on unmount without replaying a mutation", async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const events = vi.fn(async (_cursor: string, signal?: AbortSignal) => {
    if (signal) signals.push(signal);
    if (events.mock.calls.length === 1)
      throw new ApiError(503, "unavailable", "offline");
    return { events: [], nextCursor: "next-opaque-cursor" };
  });
  const polling = { ...adapter, events };
  function Probe() {
    return <span>{useWorkEvents(polling, "initial-opaque-cursor")}</span>;
  }
  try {
    let mounted: ReturnType<typeof show>;
    await act(async () => {
      mounted = show(<Probe />);
      await Promise.resolve();
    });
    expect(events).toHaveBeenCalledTimes(1);
    expect(screen.getByText("retrying")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3999);
    });
    expect(events).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(events).toHaveBeenCalledTimes(2);
    expect(screen.getByText("connected")).toBeVisible();
    mounted!.unmount();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(events).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});


test("amendments exclude cancelled and never-approved Intents from the exact replacement set", async () => {
  amendment(); records = records.filter(record => record.kind !== "amendment");
  const cancelled = recordOf(records, "intent", "i2")!;
  cancelled.state = "cancelled";
  records.push({...cancelled,id:"draft-intent",state:"draft",approvedRevisionId:null});
  recordOf(records,"flow-revision","fr2")!.requiredIntentIds=["i1"];
  show(<AmendmentsPanel adapter={adapter} flow={recordOf(records,"flow","flow-demo")!} records={records} can={()=>true} onDone={()=>undefined}/>);
  fireEvent.change(screen.getByRole("textbox",{name:"Reason for the requirements change"}),{target:{value:"Review only active approved work"}});
  expect(screen.getByRole("button",{name:"Authorize exact amendment set"})).toBeEnabled();
  fireEvent.click(screen.getByRole("button",{name:"Authorize exact amendment set"}));
  await waitFor(()=>expect(fetch).toHaveBeenCalled());
  const body=JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
  expect(body.payload.affectedIntentIds).toEqual(["i1"]);
  expect(body.payload.replacements.map((replacement:{targetId:string})=>replacement.targetId)).toEqual(["flow-demo","i1"]);
});

test("an approved Flow with no approved dependent Intent can authorize a Flow-only amendment",()=>{
 amendment();records=records.filter(record=>record.kind!=="amendment"&&record.kind!=="intent");
 recordOf(records,"flow-revision","fr2")!.requiredIntentIds=[];
 show(<AmendmentsPanel adapter={adapter} flow={recordOf(records,"flow","flow-demo")!} records={records} can={()=>true} onDone={()=>undefined}/>);
 fireEvent.change(screen.getByRole("textbox",{name:"Reason for the requirements change"}),{target:{value:"Change only the Flow scope"}});
 expect(screen.getByRole("button",{name:"Authorize exact amendment set"})).toBeEnabled();
});
