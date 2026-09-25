// Read-only project sources for /status, /flows, and /workspace. Failures
// stay empty rows.

import { randomUUID } from "node:crypto";
import { interruptedCompletionLine, isCompletionInterrupted, listFlowDirs, readFlow } from "../flow/store";
import type { FlowState } from "../flow/types";
// Flow 328, AC7: reading a flow's CACHED check-ac result is a pure core read
// — the TUI never triggers a Jev call itself here, only shows what `keryx
// flow check-ac`/the advisory notices already cached. Through the flow
// facade (`../flow/service`), not `../flow/check-ac` directly — import
// policy rule 2 only excuses an edge whose target is a `service.ts`.
import { acCheckCachePath, readAcCheckCache, statusLabel, type AcCheckStatus } from "../flow/service";
import {
  localWorkspaceAuthorizationServer,
  WorkspaceService,
  type WorkspaceManifest,
} from "../sac/workspace-service";
import { buildCatchUp, type CatchUpItem, type CatchUpReport } from "../sac/catch-up";
import { readSlate } from "../session/slate";
import { listSessions, sessionDir } from "../session";

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
  /**
   * Set when the flow is `completing` and nothing holds its lock (flow 299,
   * AC6): the same condition, and the same words, as `keryx flow status`.
   * Absent otherwise.
   */
  interrupted?: string | undefined;
  /** Flow 328, AC7: the flow's last CACHED check-ac markers, or absent when nothing has been cached yet ("not run"). */
  acMarkers?: readonly AcMarker[];
  /** When the cached markers were computed. */
  acCheckedAt?: string;
  /** True when the cached markers were computed against a DIFFERENT (now superseded) criteria checksum — shown as stale, never as current. */
  acCheckStale?: boolean;
};

/** Flow 328, AC7: one criterion's cached status, for the /flows sidebar and detail tab. */
export type AcMarker = { readonly id: string; readonly status: AcCheckStatus; readonly label: string };

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

function localSacGuard() {
  return {
    mode: "strict" as const,
    availability: "available" as const,
    decision: "pass" as const,
    policyRevision: "local-offline-v1",
  };
}

export async function loadInspectorWorkspaces(cwd: string): Promise<WorkspaceInfo[]> {
  try {
    const service = new WorkspaceService({
      workspaceRoot: cwd,
      authorizationServer: localWorkspaceAuthorizationServer(),
      strictGuard: localSacGuard(),
    });
    const listed = await service.list({ request: undefined, requestCorrelationId: randomUUID() });
    return listed.map(workspaceFromManifest);
  } catch {
    return [];
  }
}

/** Single-workspace fetch for the sidebar/`/workspace` modal. `undefined` on
 * any failure (not found, guard denial, corrupt manifest) — same "failures
 * stay empty" contract as every other loader in this file. */
export async function loadInspectorWorkspace(cwd: string, workspaceId: string): Promise<WorkspaceInfo | undefined> {
  try {
    const service = new WorkspaceService({
      workspaceRoot: cwd,
      authorizationServer: localWorkspaceAuthorizationServer(),
      strictGuard: localSacGuard(),
    });
    const manifest = await service.show({ request: undefined, requestCorrelationId: randomUUID(), workspaceId });
    return workspaceFromManifest(manifest);
  } catch {
    return undefined;
  }
}

export function sortFlowsNewestFirst(items: readonly FlowInspectorItem[]): FlowInspectorItem[] {
  return [...items].sort((left, right) => {
    const byId = Number(right.id) - Number(left.id);
    if (!Number.isNaN(byId) && byId !== 0) {
      return byId;
    }
    if (left.updatedAt !== right.updatedAt) {
      return left.updatedAt < right.updatedAt ? 1 : -1;
    }
    return right.id.localeCompare(left.id);
  });
}

export async function loadInspectorFlows(cwd: string): Promise<FlowInspectorItem[]> {
  try {
    const dirs = await listFlowDirs(cwd);
    const items: FlowInspectorItem[] = [];
    for (const dir of dirs) {
      try {
        const flow = await readFlow(cwd, dir);
        const item = flowItemFromState(flow, dir);
        if (await isCompletionInterrupted(cwd, flow, dir)) {
          item.interrupted = interruptedCompletionLine(flow.id);
        }
        // Flow 328, AC7: never triggers a Jev call — shows the last cached
        // check-ac result, or nothing ("not run" is the marker-less default).
        try {
          const cache = await readAcCheckCache(acCheckCachePath(cwd, dir));
          if (cache !== undefined) {
            item.acMarkers = cache.verdicts.map((v) => ({ id: v.id, status: v.status, label: statusLabel(v.status) }));
            item.acCheckedAt = cache.at;
            item.acCheckStale = flow.acChecksum === null || !cache.key.startsWith(`${flow.acChecksum}:`);
          }
        } catch {
          // Cache unreadable — same as "not run"; never blocks the flow list.
        }
        items.push(item);
      } catch {
        // skip unreadable packages; `keryx flow check` owns that report
      }
    }
    return sortFlowsNewestFirst(items);
  } catch {
    return [];
  }
}

export type SlateInspectorItem = {
  sessionId: string;
  sessionTitle: string;
  updatedAt: string;
  /** SessionSummary's own Slate-Phase-5 catch-up field; "unbound" when the
   * session predates that field or was never classified. */
  courseStatus: string;
  flowRef?: string;
  seedCount: number;
  touchedFiles: readonly string[];
  seeds: readonly { id: string; text: string; ts: string; kind?: string }[];
};

export function sortSlatesNewestFirst(items: readonly SlateInspectorItem[]): SlateInspectorItem[] {
  return [...items].sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0));
}

/**
 * Every session in this project whose `slate.json` is bound to `workspaceId`
 * — the sole link is `Slate.workspaceId` (set at resolve-or-create time,
 * SLATE-16); a workspace's own `resources[]` never gets a `kind: "session"`
 * entry for this. One extra `readSlate` per project session; `listSessions`
 * is already project-scoped so this never crosses project boundaries.
 */
export async function loadInspectorSlates(cwd: string, workspaceId: string): Promise<SlateInspectorItem[]> {
  try {
    const sessions = listSessions(cwd);
    const items: SlateInspectorItem[] = [];
    for (const session of sessions) {
      const dir = sessionDir(session.projectPath, session.id);
      let slate: Awaited<ReturnType<typeof readSlate>>;
      try {
        slate = await readSlate(dir);
      } catch {
        continue; // unreadable/corrupt slate.json — skip, never abort the whole list
      }
      if (slate === undefined || slate.workspaceId !== workspaceId) {
        continue;
      }
      items.push({
        sessionId: session.id,
        sessionTitle: session.title,
        updatedAt: session.updatedAt,
        courseStatus: session.courseStatus ?? "unbound",
        ...(slate.course.flowRef !== undefined ? { flowRef: slate.course.flowRef } : {}),
        seedCount: slate.seeds.length,
        touchedFiles: slate.anchors.touched,
        seeds: slate.seeds,
      });
    }
    return sortSlatesNewestFirst(items);
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

/**
 * Whole-project catch-up (SLATE-10) for the sidebar "Review" badge and
 * `/review` modal — never workspace-scoped, matching the "whole project, all
 * catch-up categories" scope decided for this surface. Failures stay an
 * empty report, same "failures stay empty rows" contract as every other
 * loader in this file.
 */
export async function loadInspectorCatchUp(cwd: string): Promise<CatchUpReport> {
  try {
    return await buildCatchUp({ cwd });
  } catch {
    return { proposals: [], blocked: [], unboundCandidates: [], unknown: [], lifecycleFlags: [], unreviewedPaths: [] };
  }
}

/**
 * Items a human can act on from `/review`, in `renderCatchUp`'s own section
 * order (`src/commands/workspace.ts`) — proposals, then blocked sessions,
 * then unbound candidates, then unknown. `lifecycleFlags` is deliberately
 * excluded: it is a separate, report-only category (see `CatchUpReport`'s own
 * doc comment in `src/sac/catch-up.ts`) with no "review" action of its own.
 */
export function catchUpItems(report: CatchUpReport): CatchUpItem[] {
  return [...report.proposals, ...report.blocked, ...report.unboundCandidates, ...report.unknown];
}

export function formatSessionFlowLines(flows: readonly FlowInspectorItem[]): string[] {
  if (flows.length === 0) {
    return ["No flows recorded in this session."];
  }
  return flows.map(
    (flow) =>
        `${flow.id}  ${flow.interrupted ? `${flow.status} (interrupted)` : flow.status}  ${flow.tasksDone}/${flow.tasksTotal}  ${flow.title}`,
  );
}
