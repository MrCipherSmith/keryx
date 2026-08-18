import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createSession } from "../session/store";
import { writeSlate } from "../session/slate";
import { WorkspaceService, localWorkspaceAuthorizationServer } from "../sac/workspace-service";
import {
  flowsInSession,
  formatSessionFlowLines,
  formatWorkspaceLines,
  loadInspectorSlates,
  loadInspectorWorkspace,
  sortFlowsNewestFirst,
  sortSlatesNewestFirst,
  workspacesInSession,
  type FlowInspectorItem,
  type SlateInspectorItem,
  type WorkspaceInfo,
} from "./inspector-sources";

const ALPHA: WorkspaceInfo = {
  id: "workspace-alpha",
  title: "Alpha",
  status: "active",
  resources: [],
};
const BETA: WorkspaceInfo = {
  id: "workspace-beta",
  title: "Beta",
  status: "active",
  resources: [{ kind: "session", uri: "session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }],
};

const FLOW: FlowInspectorItem = {
  id: "154",
  slug: "tui-modal-chrome",
  title: "Modal chrome",
  status: "in-progress",
  dir: ".metaproject/flows/154-tui-modal-chrome",
  tasksDone: 2,
  tasksTotal: 4,
  sessionIds: ["sess-1"],
  prUrl: null,
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
  source: "description",
  tasks: [{ id: "T1", title: "Do it", status: "done" }],
};

test("workspacesInSession keeps only mentioned or session-linked workspaces", () => {
  expect(workspacesInSession([ALPHA, BETA], { sessionText: "called workspace-alpha" }).map((w) => w.id)).toEqual([
    "workspace-alpha",
  ]);
  expect(
    workspacesInSession([ALPHA, BETA], { sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }).map((w) => w.id),
  ).toEqual(["workspace-beta"]);
  expect(workspacesInSession([ALPHA], { sessionText: "unrelated" })).toEqual([]);
});

test("flowsInSession matches runLink session ids and explicit flow mentions only", () => {
  expect(flowsInSession([FLOW], { sessionId: "sess-1" })).toHaveLength(1);
  expect(flowsInSession([FLOW], { sessionText: "see /flows 154" })).toHaveLength(1);
  expect(flowsInSession([FLOW], { sessionText: "random 154 in a uuid is not enough" })).toEqual([]);
});

test("empty formatters say so", () => {
  expect(formatWorkspaceLines([])[0]).toMatch(/no workspaces/i);
  expect(formatSessionFlowLines([])[0]).toMatch(/no flows/i);
});

test("sortFlowsNewestFirst is last-id first", () => {
  const older = { ...FLOW, id: "003", updatedAt: "2026-01-01T00:00:00.000Z" };
  const newer = { ...FLOW, id: "154", updatedAt: "2026-08-01T00:00:00.000Z" };
  expect(sortFlowsNewestFirst([older, newer]).map((item) => item.id)).toEqual(["154", "003"]);
});

const SLATE_ITEM: SlateInspectorItem = {
  sessionId: "sess-1",
  sessionTitle: "First",
  updatedAt: "2026-01-01T00:00:00.000Z",
  courseStatus: "active",
  seedCount: 0,
  touchedFiles: [],
  seeds: [],
};

test("sortSlatesNewestFirst is most-recently-updated first", () => {
  const older = { ...SLATE_ITEM, sessionId: "sess-1", updatedAt: "2026-01-01T00:00:00.000Z" };
  const newer = { ...SLATE_ITEM, sessionId: "sess-2", updatedAt: "2026-08-01T00:00:00.000Z" };
  expect(sortSlatesNewestFirst([older, newer]).map((item) => item.sessionId)).toEqual(["sess-2", "sess-1"]);
});

const LOCAL_STRICT = { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" } as const;

async function ensureWorkspace(cwd: string, id: string, title = id) {
  const workspaces = new WorkspaceService({ workspaceRoot: cwd, authorizationServer: localWorkspaceAuthorizationServer(), strictGuard: LOCAL_STRICT });
  return workspaces.create({ request: undefined, requestCorrelationId: randomUUID(), id, title });
}

test("loadInspectorWorkspace / loadInspectorSlates: real fixtures, real cross-session link", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "keryx-ws-inspector-data-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-ws-inspector-cwd-"));
  const originalDataDir = process.env.KERYX_DATA_DIR;
  process.env.KERYX_DATA_DIR = dataDir;
  try {
    await ensureWorkspace(cwd, "workspace-gamma", "Gamma");

    // One session bound to the workspace, one unbound — only the bound one
    // must show up in loadInspectorSlates.
    const bound = createSession({ cwd, title: "Bound session" });
    await writeSlate(bound.dir, () => ({
      workspaceId: "workspace-gamma",
      anchors: { root: cwd, touched: ["src/a.ts"] },
      course: { flowRef: "042" },
      seeds: [{ id: "seed-1", text: "note", ts: "2026-08-18T00:00:00.000Z", kind: "decision" }],
    }));
    const unbound = createSession({ cwd, title: "Unbound session" });
    await writeSlate(unbound.dir, () => ({
      anchors: { root: cwd, touched: [] },
      course: {},
      seeds: [],
    }));

    const workspace = await loadInspectorWorkspace(cwd, "workspace-gamma");
    expect(workspace?.title).toBe("Gamma");
    expect(await loadInspectorWorkspace(cwd, "no-such-workspace")).toBeUndefined();

    const slates = await loadInspectorSlates(cwd, "workspace-gamma");
    expect(slates.map((s) => s.sessionId)).toEqual([bound.summary.id]);
    expect(slates[0]?.flowRef).toBe("042");
    expect(slates[0]?.seedCount).toBe(1);
    expect(slates[0]?.touchedFiles).toEqual(["src/a.ts"]);

    expect(await loadInspectorSlates(cwd, "no-such-workspace")).toEqual([]);
  } finally {
    if (originalDataDir !== undefined) process.env.KERYX_DATA_DIR = originalDataDir;
    else delete process.env.KERYX_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
