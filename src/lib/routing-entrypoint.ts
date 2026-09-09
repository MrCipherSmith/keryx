import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "./fs";
import {
  applyInstallPlan,
  applyReportIsNoteworthy,
  blockedMessage,
  buildInstallPlan,
  formatApplyReport,
  InstallPlanBlockedError,
  type DivergenceResolution,
  type InstallPlan,
  type InstallStep,
} from "./install-plan";
import {
  renderProjectRulesReadme,
  renderRoutingEntrypointPair,
  ROUTING_FILENAME,
  type RoutingEntrypointOptions,
  type RoutingEntrypointPair,
} from "./templates";

const ROUTING_LOCK_FILENAME = ".routing-entrypoint.lock";

/** Stable step IDs. These are journal keys — never rename them. */
export const ROUTING_FULL_STEP_ID = "routing:full";
export const ROUTING_INDEX_STEP_ID = "routing:index";
export const RULES_README_STEP_ID = "rules:readme";

/**
 * The managed rules README the same three intents publish. `init` writes it
 * once and then leaves it to the user (`create-if-absent`); `update` and
 * `rules sync` keep it current (`managed`) — the difference is preserved
 * exactly as the two commands spelled it before this plan existed.
 */
export function rulesReadmeStep(metaprojectRoot: string, mode: "managed" | "create-if-absent"): InstallStep {
  return {
    id: RULES_README_STEP_ID,
    path: path.join(metaprojectRoot, "rules", "README.md"),
    content: renderProjectRulesReadme(),
    mode,
  };
}

/**
 * The one writer `init`, `update`, `rules sync` and `rules distill` share
 * (`artifact-lifecycle.md`: "Init/update/rules sync/rules distill задают разные
 * намерения одному writer"). `intent` is which of those is speaking; extra
 * steps are the other managed artifacts a given intent publishes in the same
 * plan, so one preview and one journal cover the whole lifecycle write.
 */
export type RoutingLifecycleContext = {
  intent: string;
  /** Additional managed artifacts published under the same plan, applied before the pair. */
  steps?: readonly InstallStep[];
  resolution?: DivergenceResolution;
  /** Test seam: pin the writer version instead of reading package.json. */
  writerVersion?: string;
  /** Where the honest partial-state lines go. Defaults to silence. */
  onNotice?: (line: string) => void;
  /** Test seam: fires after the durable `begun` record and before the write. */
  beforeStepMutation?: (stepId: string) => void | Promise<void>;
};

export function routingEntrypointSteps(
  metaprojectRoot: string,
  pair: RoutingEntrypointPair,
): InstallStep[] {
  return [
    {
      id: ROUTING_FULL_STEP_ID,
      path: path.join(metaprojectRoot, ROUTING_FILENAME),
      content: pair.routing,
      mode: "managed",
    },
    {
      id: ROUTING_INDEX_STEP_ID,
      path: path.join(metaprojectRoot, "index.md"),
      content: pair.index,
      mode: "managed",
    },
  ];
}

/**
 * Read-only. Renders the pair and reports what publishing it would do, without
 * writing either member or the journal.
 */
export async function planRoutingEntrypointPair(
  metaprojectRoot: string,
  options: RoutingEntrypointOptions,
  context: RoutingLifecycleContext,
): Promise<InstallPlan> {
  const pair = renderRoutingEntrypointPair(options);
  return buildInstallPlan({
    metaprojectRoot,
    intent: context.intent,
    steps: [...(context.steps ?? []), ...routingEntrypointSteps(metaprojectRoot, pair)],
    ...(context.writerVersion !== undefined ? { writerVersion: context.writerVersion } : {}),
  });
}

/**
 * Publish the full router before its compact pointer under one Keryx writer
 * lock. A failed file operation is propagated; rerunning safely recalculates
 * both documents and skips any member that already has the expected bytes.
 *
 * Under a lifecycle context the publication is planned first: an already-begun
 * step from an interrupted run is reported rather than silently repeated, and a
 * target another writer version published and can no longer account for blocks
 * the whole publication (the pair is a joint invariant — a half-new pair is
 * worse than an untouched one) until a resolution is given. Nothing here rolls
 * anything back, and nothing here claims to.
 */
export async function writeRoutingEntrypointPair(
  metaprojectRoot: string,
  options: RoutingEntrypointOptions,
  context: RoutingLifecycleContext = { intent: "install" },
): Promise<RoutingEntrypointPair> {
  const pair = renderRoutingEntrypointPair(options);
  const steps = [...(context.steps ?? []), ...routingEntrypointSteps(metaprojectRoot, pair)];
  const lockPath = path.join(metaprojectRoot, ROUTING_LOCK_FILENAME);
  await reclaimAbandonedRoutingLock(lockPath);
  return withFileLock(lockPath, async () => {
    const plan = await buildInstallPlan({
      metaprojectRoot,
      intent: context.intent,
      steps,
      ...(context.writerVersion !== undefined ? { writerVersion: context.writerVersion } : {}),
    });
    const report = await applyInstallPlan({
      plan,
      ...(context.resolution !== undefined ? { resolution: context.resolution } : {}),
      ...(context.beforeStepMutation !== undefined ? { beforeStepMutation: context.beforeStepMutation } : {}),
    });
    if (report.blocked.length > 0) {
      throw new InstallPlanBlockedError(blockedMessage(report), report.blocked);
    }
    if (context.onNotice && applyReportIsNoteworthy(report)) {
      for (const line of formatApplyReport(report).split("\n")) {
        context.onNotice(line);
      }
    }
    return pair;
  });
}

/**
 * A process killed mid-publication cannot run `withFileLock`'s `finally`, so it
 * leaves its lock directory behind. `withFileLock`'s own reclaim waits out
 * `DEFAULT_LOCK_STALE_MS` first, which is right for a lock that might belong to
 * a slow owner — but it would turn the resume this lifecycle promises into a
 * 30-second refusal immediately after the crash it is meant to recover from.
 *
 * So reclaim here, and only on the one unambiguous signal: the lock records an
 * owner and that owner process is gone. A lock with no `owner.json` yet is
 * inside `withFileLock`'s narrow acquisition window and is held — never touch
 * it. Aliveness beats age, exactly as `removeStaleLock` decides it.
 */
async function reclaimAbandonedRoutingLock(lockPath: string): Promise<void> {
  const ownerPid = await readLockOwnerPid(path.join(lockPath, "owner.json"));
  if (ownerPid === undefined || processIsAlive(ownerPid)) {
    return;
  }
  await rm(lockPath, { recursive: true, force: true }).catch(() => {});
}

/**
 * No `owner.json`, unreadable, or malformed all mean the same thing here: do
 * not touch this lock. `withFileLock` creates the directory a moment before the
 * sidecar, and that window must keep reading as held.
 *
 * `isLockHeld` cannot be reused for this: its first rule is that a fresh-mtime
 * lock is held unconditionally, which is precisely the rule a just-crashed
 * owner's lock trips.
 */
async function readLockOwnerPid(ownerPath: string): Promise<number | undefined> {
  try {
    const value = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
    return Number.isSafeInteger(value.pid) && Number(value.pid) > 0 ? Number(value.pid) : undefined;
  } catch {
    return undefined;
  }
}

/** Mirrors `src/lib/fs.ts`'s own rule: EPERM means alive but not ours; ESRCH means gone. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}
