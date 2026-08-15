// Read-only project sources for /status and /flows. Failures stay empty rows.

import { randomUUID } from "node:crypto";
import { listFlowDirs, readFlow } from "../flow/store";
import type { FlowState } from "../flow/types";
import {
  localWorkspaceAuthorizationServer,
  WorkspaceService,
  type WorkspaceManifest,
} from "../sac/workspace-service";

export type WorkspaceInfo = {
  id: string;
  title: string;
  status: string;
  resources: readonly { kind: string; uri: string }[];
};

export type FlowInspectorItem = {
  id: string;
  slug: string;
  title: string;
  status: string;
  dir: string;
  tasksDone: number;
  tasksTotal: number;
  sessionIds: string[];
  prUrl: string | null;
  createdAt: string;
  updatedAt: string;
  source: string;
  tasks: readonly { id: string; title: string; status: string }[];
};

export function workspaceFromManifest(manifest: WorkspaceManifest): WorkspaceInfo {
  return {
    id: manifest.id,
    title: manifest.title,
    status: manifest.status,
    resources: manifest.resources.map((resource) => ({ kind: resource.kind, uri: resource.uri })),
  };
}

export function workspacesInSession(
  workspaces: readonly WorkspaceInfo[],
  opts: { sessionId?: string; sessionText?: string },
): WorkspaceInfo[] {
  const text = opts.sessionText ?? "";
  const sessionId = opts.sessionId ?? "";
  return workspaces.filter((workspace) => {
    if (text.includes(workspace.id)) {
      return true;
    }
    return workspace.resources.some(
      (resource) => resource.kind === "session" && sessionId.length > 0 && resource.uri.includes(sessionId),
    );
  });
}

function explicitFlowMention(item: FlowInspectorItem, text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  const id = item.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const slug = item.slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:flow\\s+#?|/flows\\s+|\\.metaproject/flows/)${id}\\b` + (slug.length > 0 ? `|(?:flow\\s+)${slug}\\b` : ""),
    "i",
  );
  return pattern.test(text);
}

export function flowsInSession(
  flows: readonly FlowInspectorItem[],
  opts: { sessionId?: string; sessionText?: string },
): FlowInspectorItem[] {
  const sessionId = opts.sessionId ?? "";
  const text = opts.sessionText ?? "";
  return flows.filter((flow) => {
    if (sessionId.length > 0 && flow.sessionIds.includes(sessionId)) {
      return true;
    }
    return explicitFlowMention(flow, text);
  });
}

export function flowItemFromState(flow: FlowState, dir: string): FlowInspectorItem {
  const sessionIds = [
    ...new Set(
      flow.tasks
        .map((task) => task.runLink?.sessionId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  return {
    id: flow.id,
    slug: flow.slug,
    title: flow.title,
    status: flow.status,
    dir: `.metaproject/flows/${dir}`,
    tasksDone: flow.tasks.filter((task) => task.status === "done").length,
    tasksTotal: flow.tasks.length,
    sessionIds,
    prUrl: flow.pr.url,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    source: flow.source.ref ?? flow.source.type,
    tasks: flow.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status })),
  };
}

export async function loadInspectorWorkspaces(cwd: string): Promise<WorkspaceInfo[]> {
  try {
    const service = new WorkspaceService({
      workspaceRoot: cwd,
      authorizationServer: localWorkspaceAuthorizationServer(),
      strictGuard: {
        mode: "strict",
        availability: "available",
        decision: "pass",
        policyRevision: "local-offline-v1",
      },
    });
    const listed = await service.list({ request: undefined, requestCorrelationId: randomUUID() });
    return listed.map(workspaceFromManifest);
  } catch {
    return [];
  }
}

export async function loadInspectorFlows(cwd: string): Promise<FlowInspectorItem[]> {
  try {
    const dirs = await listFlowDirs(cwd);
    const items: FlowInspectorItem[] = [];
    for (const dir of dirs) {
      try {
        items.push(flowItemFromState(await readFlow(cwd, dir), dir));
      } catch {
        // skip unreadable packages; `keryx flow check` owns that report
      }
    }
    return items;
  } catch {
    return [];
  }
}

export function formatWorkspaceLines(workspaces: readonly WorkspaceInfo[]): string[] {
  if (workspaces.length === 0) {
    return ["No workspaces recorded in this session."];
  }
  const width = workspaces.reduce((max, workspace) => Math.max(max, workspace.id.length), 0);
  return workspaces.map((workspace) => `${workspace.id.padEnd(width)}  ${workspace.status}  ${workspace.title}`);
}

export function formatSessionFlowLines(flows: readonly FlowInspectorItem[]): string[] {
  if (flows.length === 0) {
    return ["No flows recorded in this session."];
  }
  return flows.map(
    (flow) => `${flow.id}  ${flow.status}  ${flow.tasksDone}/${flow.tasksTotal}  ${flow.title}`,
  );
}
