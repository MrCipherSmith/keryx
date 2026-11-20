import { realpathSync } from "node:fs";
import path from "node:path";
import { manifestStamp } from "./flow-link-index";
import { readDeskReviewerProgress } from "./desk-reviewer-progress";
import type { DeskReviewerProgress, DeskReviewerSession, DeskRun, DeskRunKey } from "./desk-run-types";
import { usageCounts, validUsageCounts } from "./run-usage";

// The reader accepts the retained package, or the runner's package in its private checkout.
// Invalidate on either artifact changing, including when a directory becomes a symlink.
function planVersion(root: string, packageId?: string) {
  const dirs = ["package"];
  if (packageId && /^[\w-][\w.-]{0,199}$/.test(packageId)) dirs.push(path.join("checkout", ".metaproject", "reviews", packageId));
  return dirs.map(dir => {
    const candidate = path.join(root, dir);
    try {
      if (realpathSync(candidate) !== candidate) return null;
      return [manifestStamp(path.join(candidate, "manifest.json")), manifestStamp(path.join(candidate, "desktop-dispatch.json"))];
    } catch { return null; }
  });
}

/** The verified roster belongs to one worker, immutable revision and PR. Return only changed compact checkpoints. */
export function createWorkerRoster(directory: string, key: DeskRunKey, run: DeskRun) {
  let signature: string | undefined;
  let cached: DeskReviewerProgress | undefined;
  let byId = new Map<string, DeskReviewerSession>();
  const root = realpathSync(directory);
  return (p: { packageId?: string; reviewerSessions?: DeskReviewerSession[] }) => {
    const observed = p.reviewerSessions ?? [];
    if (!p.packageId && !observed.length) return;
    const shape = observed.map(s => [s.id, s.reviewer, s.wave, s.state, s.model, s.provider, s.startedAt, s.finishedAt]);
    const versions = planVersion(root, p.packageId);
    const current = JSON.stringify([p.packageId, versions, shape]);
    if (!cached || current !== signature) {
      cached = readDeskReviewerProgress(root, key, run, false);
      // An unprepared plan or a file changed during this read must be checked again.
      signature = cached?.planned != null && versions.some(v => v?.every(Boolean)) &&
        JSON.stringify(versions) === JSON.stringify(planVersion(root, p.packageId)) ? current : undefined;
      byId = new Map(cached?.sessions.map(s => [s.id, s]));
      return cached;
    }
    // Only counters may have changed. Merge them into the sessions the plan reader admitted.
    let changed = false;
    for (const event of observed) {
      const entry = byId.get(event.id);
      if (!entry || entry.reviewer !== event.reviewer || entry.wave !== event.wave || entry.state !== event.state) continue;
      const usage = validUsageCounts(event.usage) ? usageCounts(event.usage) : undefined;
      if (JSON.stringify(entry.usage) === JSON.stringify(usage) && !!entry.usagePartial === !!event.usagePartial) continue;
      if (usage) entry.usage = usage;
      else delete entry.usage;
      if (event.usagePartial) entry.usagePartial = true;
      else delete entry.usagePartial;
      changed = true;
    }
    return changed ? cached : undefined;
  };
}
