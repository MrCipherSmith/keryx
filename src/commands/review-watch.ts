import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { withFileLock } from "../lib/fs";
import { reviewGitCommonDir } from "../review/board-github";
import { mainCheckout, parseWatcherKey, verifyIdentity, watcherDiscoveryEnvironment, watcherWorktrees } from "../review/watcher-project";
import {
  beginWatcherOperation,
  configureWatcher,
  listConfiguredWatchers,
  pauseWatcher,
  pollWatcher,
  readWatcher,
  watcherPauseGeneration,
} from "../review/watcher";
import { DEFAULT_WATCHER_MINUTES, type WatcherKey, type WatcherSnapshot } from "../review/watcher-types";
import {
  reconcileWatcherTimer,
  watcherInstalled,
  verifyWatcherTimerTools,
  watcherLabel,
  watcherProgram,
} from "../review/watch-launchd";
import { keryxDataDir } from "../session/paths";
import type { ScheduleHost } from "../trigger/install";

export const WATCH_USAGE =
  "keryx review watch <status|enable|pause|resume|tick> --json [--repo owner/name --repository-id ID --viewer LOGIN] [--interval-minutes 1..1440]";
type Action = "status" | "enable" | "pause" | "resume" | "tick";

export function parseWatchArgs(args: string[]) {
  const [action, ...flags] = args;
  if (!action || !["status", "enable", "pause", "resume", "tick"].includes(action))
    throw new Error(WATCH_USAGE);
  const { values: v } = parseArgs({
    args: flags,
    options: {
      json: { type: "boolean" },
      repo: { type: "string" },
      viewer: { type: "string" },
      "repository-id": { type: "string" },
      "interval-minutes": { type: "string" },
    },
  });
  const raw = v["interval-minutes"];
  const minutes = raw === undefined ? undefined : Number(raw);
  if (!v.json || (raw !== undefined && (action !== "enable" || !/^[1-9]\d*$/.test(raw) || minutes! > 1440)))
    throw new Error(WATCH_USAGE);
  const key = parseWatcherKey(v);
  if (!key && action !== "status" && action !== "pause") throw new Error(WATCH_USAGE);
  return { action: action as Action, key, minutes };
}

function publicStatus(s: WatcherSnapshot): WatcherSnapshot {
  const { recoveryWarning: _recoveryWarning, ...status } = s;
  return { ...status, historyAvailable: false, events: [],
    lastError: s.lastError ? "The last scheduled poll reported a problem. Reconnect to GitHub to inspect it." : null };
}

async function scopedStatus(
  project: string,
  verifiedKey: WatcherKey | undefined,
  snapshot: WatcherSnapshot,
  verify: typeof verifyIdentity,
) {
  if (!verifiedKey)
    return publicStatus(snapshot);
  if (snapshot.events.length || snapshot.lastError || snapshot.recoveryWarning) {
    try {
      await verify(project, verifiedKey);
    } catch {
      return publicStatus(snapshot);
    }
  }
  return snapshot;
}

const disabled: WatcherSnapshot = {
  version: 1,
  state: "disabled",
  intervalMinutes: DEFAULT_WATCHER_MINUTES,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  events: [],
  installed: false,
};

export async function requestWatch(
  cwd: string,
  request: ReturnType<typeof parseWatchArgs>,
  host: ScheduleHost = {},
  verify = verifyIdentity,
  discovery: { primary?: typeof mainCheckout; worktrees?: typeof watcherWorktrees } = {},
): Promise<WatcherSnapshot> {
  const { action } = request;
  const installing = action === "enable" || action === "resume";
  if (installing && (host.platform ?? process.platform) !== "darwin")
    throw new Error("configuration: A local Review watcher requires macOS launchd.");
  const order = installing || action === "pause" ? beginWatcherOperation() : 0;
  const systemEnv = (host.platform ?? process.platform) === "darwin" ? watcherDiscoveryEnvironment() : undefined;
  const project = await (discovery.primary ?? mainCheckout)(cwd, systemEnv);
  let key = request.key;
  if (!key) {
    const keys = listConfiguredWatchers(project);
    if (keys.length > 1)
      throw new Error("configuration: Reconnect to GitHub and select the repository to manage its watcher.");
    if (!keys.length) return disabled;
    key = keys[0]!;
  }
  const target = key;
  if (action === "tick") {
    // All full baseline/history writes are owned and fenced by the poll service.
    await verifyWatcherTimerTools();
    return publicStatus(await pollWatcher(project, target));
  }
  if (action === "status") {
    const snapshot = readWatcher(project, target);
    if (snapshot.state !== "disabled") snapshot.installed = await watcherInstalled(project, target, host);
    return scopedStatus(project, request.key, snapshot, verify);
  }
  const lock = path.join(keryxDataDir(), "review-watch", watcherLabel(project, target) + ".lock");
  if (action === "pause") {
    const paused = await withFileLock(lock, async () => {
      const snapshot = pauseWatcher(project, target, order);
      if (snapshot.state !== "disabled") snapshot.installed = await reconcileWatcherTimer(project, target, host);
      return snapshot;
    }, { timeoutMs: 45_000 });
    return scopedStatus(project, request.key, paused, verify);
  }
  if (action === "resume" && readWatcher(project, target).state === "disabled")
    throw new Error("configuration: Enable this watcher before resuming it.");
  const checkouts = await (discovery.worktrees ?? watcherWorktrees)(cwd);
  if (checkouts[0] !== project)
    throw new Error("configuration: The primary checkout changed during verification. Try again from Review.");
  const program = await watcherProgram(checkouts, host);
  const commonDir = await reviewGitCommonDir(project, { ...program.env, HOME: homedir() });
  // The interactive credentials and the credentials launchd can use must both authorize this project.
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)
    await verify(project, target, { ...program.env, HOME: homedir(), GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN });
  await verify(project, target, { ...program.env, HOME: homedir() });
  return withFileLock(lock, async () => {
    if (watcherPauseGeneration(project, target) > order)
      throw new Error("configuration: The watcher was paused during verification. Resume it to continue.");
    const minutes = request.minutes ?? readWatcher(project, target).intervalMinutes;
    configureWatcher(project, target, minutes, commonDir ? { project: commonDir, order } : undefined);
    const installed = await reconcileWatcherTimer(project, target, host, { minutes, program });
    return { ...readWatcher(project, target), installed };
  }, { timeoutMs: 45_000 });
}

export async function runReviewWatch(args: string[]) {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(WATCH_USAGE);
    return;
  }
  const result = await requestWatch(process.cwd(), parseWatchArgs(args));
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(JSON.stringify(result) + "\n", (error) => (error ? reject(error) : resolve())),
  );
}
