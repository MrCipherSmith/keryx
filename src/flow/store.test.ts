import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveFlowWork } from "./store";
import type { FlowState } from "./types";
import { readCourse } from "../session/slate-course";
import { createLocalFwkReadService } from "../sac/fwk-service";
import { WorkspaceService, localWorkspaceAuthorizationServer } from "../sac/workspace-service";

const stamp = "2026-08-16T00:00:00.000Z";

function makeFlow(overrides: Partial<FlowState> = {}): FlowState {
  return {
    schemaVersion: 2,
    id: "042",
    slug: "coupling-check",
    title: "Coupling check flow",
    status: "in-progress",
    createdAt: stamp,
    updatedAt: stamp,
    source: { type: "description", ref: null },
    acChecksum: null,
    acConfirmed: {},
    pr: { url: null },
    tasks: [
      { id: "T1", title: "First", kind: "context", status: "done" },
      { id: "T2", title: "Second", kind: "implement", status: "todo" },
    ],
    history: [],
    ...overrides,
  };
}

test("deriveFlowWork projects completed/next from task status", () => {
  const work = deriveFlowWork(makeFlow(), "./flows/042");
  expect(work.flowRef).toEqual({ uri: "./flows/042", snapshot: "in-progress", revision: stamp });
  expect(work.completed).toEqual(["T1"]);
  expect(work.next).toEqual(["T2"]);
  expect(work.blocked).toEqual([]);
});

test("deriveFlowWork marks a blocked flow's own id in blocked", () => {
  const work = deriveFlowWork(makeFlow({ status: "blocked" }), "./flows/042");
  expect(work.blocked).toEqual(["042"]);
});

test("deriveFlowWork returns empty completed/next for a flow with no tasks", () => {
  const work = deriveFlowWork(makeFlow({ tasks: [] }), "./flows/042");
  expect(work.completed).toEqual([]);
  expect(work.next).toEqual([]);
});

// Coupling/regression guard for review finding F-004: `src/session/slate-course.ts`'s
// `readCourse` (workspace-independent, loads via `readFlow`/`resolveFlowDir`) and
// `src/sac/fwk-service.ts`'s `createLocalFwkReadService` (workspace-scoped, loads via
// `WorkspaceService`) load the same flow content through two intentionally different
// paths, but must derive IDENTICAL completed/next/blocked projections because both now
// call the single shared `deriveFlowWork` above. This test drives both real call sites
// against the same flow data and asserts their projections agree — the concrete guard
// against the two derivations drifting apart again in the future. `flowRef.uri` is
// exempted from the equality check: each side's `uri` is legitimately different by
// design (Course's is the bare flowRef string; fwk-service's is the workspace resource
// uri) — everything derived FROM the flow content must still match exactly.
test("readCourse and createLocalFwkReadService derive identical completed/next/blocked for the same flow", async () => {
  const flow = makeFlow({ status: "blocked" });

  const courseCwd = await mkdtemp(path.join(tmpdir(), "keryx-flow-work-coupling-course-"));
  const courseFlowDir = path.join(courseCwd, ".metaproject", "flows", "042-coupling-check");
  await mkdir(courseFlowDir, { recursive: true });
  await writeFile(path.join(courseFlowDir, "flow.json"), JSON.stringify(flow), "utf8");

  const fwkRoot = await mkdtemp(path.join(tmpdir(), "keryx-flow-work-coupling-fwk-"));
  const authorizationServer = localWorkspaceAuthorizationServer();
  const strictGuard = { mode: "strict" as const, availability: "available" as const, decision: "pass" as const, policyRevision: "local-offline-v1" };
  const workspaces = new WorkspaceService({ workspaceRoot: fwkRoot, authorizationServer, strictGuard });
  await workspaces.create({ request: undefined, requestCorrelationId: "flow-work-coupling-0001", id: "workspace-a", title: "Coupling check" });
  await mkdir(path.join(fwkRoot, "flows"), { recursive: true });
  await writeFile(path.join(fwkRoot, "flows", "042.json"), JSON.stringify(flow), "utf8");
  await workspaces.addResource({ request: undefined, requestCorrelationId: "flow-work-coupling-0001", workspaceId: "workspace-a", resource: { kind: "flow", uri: "./flows/042.json" } });

  const course = await readCourse(courseCwd, "042");
  expect(course.state).toBe("bound");
  if (course.state !== "bound") return;

  const service = createLocalFwkReadService(fwkRoot);
  const result = await service.overview({ workspaceId: "workspace-a", request: undefined, requestCorrelationId: "flow-work-coupling-0002", budget: { maxItems: 10, maxTokens: 1000 } });
  expect("code" in result).toBe(false);
  if ("code" in result) return;
  const work = result.manifest.work as { state: string; flowRef?: { uri: string; snapshot: string; revision: string }; completed?: string[]; next?: string[]; blocked?: string[] };
  expect(work.state).toBe("bound");

  expect(work.completed).toEqual(course.completed);
  expect(work.next).toEqual(course.next);
  expect(work.blocked).toEqual(course.blocked);
  expect(work.flowRef?.snapshot).toEqual(course.flowRef.snapshot);
  expect(work.flowRef?.revision).toEqual(course.flowRef.revision);
});
