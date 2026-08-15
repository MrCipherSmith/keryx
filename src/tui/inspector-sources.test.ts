import { expect, test } from "bun:test";
import {
  flowsInSession,
  formatSessionFlowLines,
  formatWorkspaceLines,
  workspacesInSession,
  type FlowInspectorItem,
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
