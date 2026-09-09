// Retention targets for flow 237 phase 5, T8.
//
// Scope: the two stores measured as growing without bound while this task was
// written — `.metaproject/data/gdctx/raw` + `artifacts` (7,336 + 6,683 files,
// ~326 MiB combined, on this checkout the day this module was written; no
// retention logic existed anywhere for them) and the per-refused-write
// conflict sidecars each SAC owner writer leaves under
// `.metaproject/workspaces/<id>/<owner>-write-conflicts/` (`recordConflict`,
// `src/sac/proposal-evidence.ts`) — also entirely unswept.
//
// This is the retention/prune PREREQUISITE flow 237's own context.md (3.5)
// names for AC-29's full "forget" surface (`src/knowledge/forget/**`,
// tombstones, deny epochs) — not that surface itself. AC-29's tombstone and
// explicit-request semantics are out of scope here; what this closes is its
// literal first clause read against these two stores: content that keeps
// accumulating with nothing ever bounding it.
//
// Policy shape — age + total bytes, oldest-first — deliberately mirrors
// `src/wiki/freshness/queue.ts` (MAX_LINES + MAX_BYTES, one rotation
// generation) rather than inventing a second shape for a third growing store.
// The adaptation: that queue is one append-only file, so its second axis is
// line count; these stores are directories of many small immutable files (or,
// for a conflict sidecar, one small directory per refused write), so the
// natural second axis is entry age, not a line count that has no meaning here.
//
//   - Age is the primary axis. gdctx raw logs and artifacts are the evidence
//     behind routed-search summaries an agent may still want to open, so this
//     is a deliberate trade of recoverability against size, not an accident:
//     `DEFAULT_MAX_AGE_DAYS` (14) covers the working window of a flow still in
//     progress without holding evidence indefinitely once that window closes.
//     Owner write-conflict sidecars get a longer window
//     (`OWNER_CONFLICT_MAX_AGE_DAYS`, 30) — they are the record of an actual
//     refused write an operator may want to reconcile, not routine search
//     chatter, and they are cheap individually (one small text file each), so
//     there is no size pressure to shorten it.
//   - Total bytes is the backstop, applied oldest-first only after the age
//     cutoff has run. Age alone does not bound a burst: a single day of heavy
//     `ctx rg` use is enough to add gigabytes inside a two-week window
//     regardless of how old anything else is. `GDCTX_RAW_MAX_BYTES` is set
//     above the raw directory's measured size on this checkout (~291 MiB) so a
//     first sweep demonstrates real, but not total, shrinkage; a byte cap
//     bounds the worst case, it is not a target size.
//
// Count is deliberately NOT its own policy axis. For both gdctx directories,
// entries are similarly sized, so a count cap would only ever fire earlier
// than the byte cap already fires, on exactly the same entries — it would
// never protect anything the byte cap does not already protect for these two
// stores. If a store with widely varying entry sizes needs its own retention
// later, that is the point to reconsider, not a reason to add an axis here
// that does nothing today.

import path from "node:path";
import { isNotFound } from "../lib/fs";
import { describeError, type RetentionFsDeps, type RetentionUnit } from "./fs-deps";

export interface RetentionTarget {
  /** Stable id for `--target` filtering and per-target reporting. */
  id: string;
  /** Human-readable description for reports. */
  label: string;
  /** Absolute directory this target sweeps (non-recursive listing). */
  dir: string;
  /** Whether one sweep entry is a file or a whole subdirectory. */
  unit: RetentionUnit;
  maxAgeDays: number;
  maxBytes: number;
}

export const DEFAULT_MAX_AGE_DAYS = 14;
export const GDCTX_RAW_MAX_BYTES = 200 * 1024 * 1024; // 200 MiB
export const GDCTX_ARTIFACTS_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB

export const OWNER_CONFLICT_MAX_AGE_DAYS = 30;
export const OWNER_CONFLICT_MAX_BYTES = 20 * 1024 * 1024; // 20 MiB per conflict directory

/** The two gdctx stores. Always present regardless of what exists on disk — a
 * missing directory is reported by the sweep itself as `"empty"`, not omitted
 * here as though the store did not apply. */
export function gdctxTargets(cwd: string): RetentionTarget[] {
  return [
    {
      id: "gdctx-raw",
      label: "gdctx raw command/search output (data/gdctx/raw)",
      dir: path.join(cwd, ".metaproject", "data", "gdctx", "raw"),
      unit: "file",
      maxAgeDays: DEFAULT_MAX_AGE_DAYS,
      maxBytes: GDCTX_RAW_MAX_BYTES,
    },
    {
      id: "gdctx-artifacts",
      label: "gdctx compact command/search summaries (data/gdctx/artifacts)",
      dir: path.join(cwd, ".metaproject", "data", "gdctx", "artifacts"),
      unit: "file",
      maxAgeDays: DEFAULT_MAX_AGE_DAYS,
      maxBytes: GDCTX_ARTIFACTS_MAX_BYTES,
    },
  ];
}

export interface TargetDiscoveryResult {
  targets: RetentionTarget[];
  /**
   * Non-fatal discovery problems: `.metaproject/workspaces/` (or one
   * workspace under it) exists but could not be read. Kept separate from
   * `targets` deliberately — a caller that only looked at the target list
   * could not tell "nothing found" from "could not look everywhere", and
   * conflating those two is exactly the silent-success shape AC-29 forbids.
   * The sweep CLI folds a non-empty `issues` list into an `incomplete` report
   * rather than letting an unreadable `workspaces/` read as "no conflicts".
   */
  issues: string[];
}

/**
 * Discover `<workspaceId>/<owner>-write-conflicts/` directories under
 * `.metaproject/workspaces/`. Each one holds one directory per refused write
 * (`ownerConflictDir`, `src/sac/proposal-evidence.ts`), so the sweep unit is
 * the whole conflict directory, not the `proposed` file inside it.
 *
 * An absent `workspaces/` directory (no SAC activity yet) discovers nothing —
 * that is a legitimately empty result, not a failure, and is not reported as
 * an issue. Any other read failure — on `workspaces/` itself, or on one
 * workspace under it — is recorded in `issues` and discovery continues with
 * whatever else it can read, so one bad workspace never hides the rest.
 */
export async function discoverOwnerConflictTargets(cwd: string, deps: RetentionFsDeps): Promise<TargetDiscoveryResult> {
  const workspacesDir = path.join(cwd, ".metaproject", "workspaces");
  let workspaceIds: string[];
  try {
    workspaceIds = await deps.readdir(workspacesDir);
  } catch (error) {
    if (isNotFound(error)) return { targets: [], issues: [] };
    return { targets: [], issues: [`workspaces directory unreadable: ${describeError(error)}`] };
  }

  const targets: RetentionTarget[] = [];
  const issues: string[] = [];
  for (const workspaceId of workspaceIds) {
    const workspaceDir = path.join(workspacesDir, workspaceId);
    let entries: string[];
    try {
      entries = await deps.readdir(workspaceDir);
    } catch (error) {
      if (!isNotFound(error)) issues.push(`workspace unreadable: ${workspaceId} (${describeError(error)})`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith("-write-conflicts")) continue;
      targets.push({
        id: `owner-write-conflicts:${workspaceId}:${entry}`,
        label: `refused-write sidecars (${entry}, workspace ${workspaceId})`,
        dir: path.join(workspaceDir, entry),
        unit: "directory",
        maxAgeDays: OWNER_CONFLICT_MAX_AGE_DAYS,
        maxBytes: OWNER_CONFLICT_MAX_BYTES,
      });
    }
  }
  return { targets, issues };
}

/** The full target set this sweep knows about: the static gdctx pair plus
 * every owner write-conflict directory discovered on disk right now. */
export async function discoverTargets(cwd: string, deps: RetentionFsDeps): Promise<TargetDiscoveryResult> {
  const owner = await discoverOwnerConflictTargets(cwd, deps);
  return { targets: [...gdctxTargets(cwd), ...owner.targets], issues: owner.issues };
}
