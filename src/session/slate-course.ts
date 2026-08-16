// Live Course projection (SLATE-3 feature half).
//
// `slate.course.flowRef` (`SlateCourse` in `./slate.ts`) is a pointer only —
// this module re-derives the actual projection from the live Flow every time
// it is consulted, never a cached value. The completed/next/blocked
// derivation itself is the literal same function `src/sac/fwk-service.ts`'s
// `createLocalFwkReadService` applies to a workspace's registered `flow`
// resource: both call `deriveFlowWork` from `src/flow/store.ts`. What
// differs — deliberately — is how each side loads the `FlowState` that goes
// into that shared function. This module reads via `readFlow`/
// `resolveFlowDir` (`src/flow/store.ts` — the same primitives `keryx flow
// status` and `FlowService.load` use); `fwk-service.ts` loads through
// `WorkspaceService`.
//
// This is a deliberate layering choice, not a second competing flow-read
// path: `FwkReadService` requires a `workspaceId` + authorized actor context
// and unconditionally appends an access receipt to
// `.metaproject/context-operations/access-receipts.jsonl` under a file lock
// on every call — real side effects appropriate for a workspace-scoped SAC
// read, but wrong for Course, which the spec (docs/requirements/slate/
// specification.md, "Anchors / Course / Seeds semantics") requires to work
// from `flowRef` alone, independent of whether `workspaceId` was ever set
// ("Absent flowRef, Course is a plain local checklist with no Flow
// semantics" — and an ordinary task may never bind a workspace at all).
// `readFlow`/`resolveFlowDir` are the same canonical, workspace-independent
// flow-read primitives `keryx flow status` itself uses; reusing them here is
// reuse of a real flow-read path, intentionally distinct from
// `fwk-service.ts`'s workspace-scoped one — with the projection formula
// applied to whatever each side loads now unified in one place.
//
// On any read failure (flow never existed, deleted mid-session, malformed
// JSON, permission denied) this returns a deterministic `{ state: "unbound"
// }` rather than throwing — mirroring the same `state: "bound" | "unbound"`
// sentinel `fwk-service.ts` already uses for `FwkWork`. No code path here
// ever calls `flow complete`; Course only ever reads.

import { deriveFlowWork, readFlow, resolveFlowDir } from "../flow/store";
import type { Slate } from "./slate";

export type CourseProjection =
  | { state: "unbound" }
  | {
      state: "bound";
      flowRef: { uri: string; snapshot: string; revision: string };
      completed: string[];
      next: string[];
      blocked: string[];
    };

const unbound: CourseProjection = { state: "unbound" };

/**
 * Re-derives Course from the live Flow every call — never caches. `flowRef`
 * is whatever `keryx flow status <id>` itself accepts (a bare id, full flow
 * directory name, or slug; see `resolveFlowDir`), matching the spec's "a
 * flow id/ref string" description of `slate.course.flowRef`.
 */
export async function readCourse(cwd: string, flowRef: string | undefined): Promise<CourseProjection> {
  if (!flowRef) return unbound;
  try {
    const dir = await resolveFlowDir(cwd, flowRef);
    const flow = await readFlow(cwd, dir);
    return { state: "bound", ...deriveFlowWork(flow, flowRef) };
  } catch {
    // Deleted/never-existed (resolveFlowDir/readFlow throw a plain Error),
    // malformed JSON (JSON.parse throws SyntaxError), unsupported
    // schemaVersion, or a filesystem permission denial (EACCES) all
    // collapse to the same deterministic unbound result — Course must never
    // let a flow-read failure propagate into the surrounding context
    // assembly as an uncaught rejection.
    return unbound;
  }
}

/** Convenience wrapper: pulls `flowRef` off the current Slate's `course`. */
export async function courseFromSlate(cwd: string, slate: Slate | undefined): Promise<CourseProjection> {
  return readCourse(cwd, slate?.course.flowRef);
}
