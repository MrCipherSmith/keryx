import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { withFileLock } from "../lib/fs";
import { mainCheckout, parseWatcherKey, verifyIdentity } from "../review/watcher-project";
import {
  configureWatcher,
  listConfiguredWatchers,
  pauseWatcher,
  pollWatcher,
  readWatcher,
} from "../review/watcher";
import { DEFAULT_WATCHER_MINUTES, type WatcherKey, type WatcherSnapshot } from "../review/watcher-types";
import {
  reconcileWatcherTimer,
  watcherInstalled,
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

function publicStatus(s: WatcherSnapshot, message: string | null = null): WatcherSnapshot {
  return { ...s, historyAvailable: false, events: [], lastError: message };
}

async function scopedStatus(
  project: string,
  verifiedKey: WatcherKey | undefined,
  snapshot: WatcherSnapshot,
  verify: typeof verifyIdentity,
) {
  if (!verifiedKey)
    return publicStatus(
      snapshot,
      snapshot.lastError ? "The last scheduled poll failed. Reconnect to GitHub to inspect it." : null,
    );
  if (snapshot.events.length || snapshot.lastError) {
    try {
      await verify(project, verifiedKey);
    } catch {
      return publicStatus(
        snapshot,
        "GitHub access could not be confirmed. Reconnect to view watcher activity.",
      );
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
): Promise<WatcherSnapshot> {
  const project = await mainCheckout(cwd);
  const { action } = request;
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
    return publicStatus(await pollWatcher(project, target));
  }
  if (action === "status") {
    const snapshot = readWatcher(project, target);
    if (snapshot.state !== "disabled") snapshot.installed = await watcherInstalled(project, target, host);
    return scopedStatus(project, request.key, snapshot, verify);
  }
  const lock = path.join(keryxDataDir(), "review-watch", watcherLabel(project, target) + ".lock");
  const result = await withFileLock(
    lock,
    async () => {
      const before = readWatcher(project, target);
      if (action === "pause") {
        if (before.state === "disabled") return before;
        const paused = pauseWatcher(project, target);
        paused.installed = await reconcileWatcherTimer(project, target, host);
        return paused;
      }
      if (action === "resume" && before.state === "disabled")
        throw new Error("configuration: Enable this watcher before resuming it.");
      if ((host.platform ?? process.platform) !== "darwin")
        throw new Error("configuration: A local Review watcher requires macOS launchd.");
      const program = await watcherProgram(project, host);
      // Verify the credential available to the installed timer, including Keychain auth.
      // A temporary interactive GH_TOKEN must not be copied into a login LaunchAgent.
      if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) await verify(project, target);
      await verify(project, target, { ...program.env, HOME: homedir() });
      const minutes = request.minutes ?? before.intervalMinutes;
      // Persist desired state before RunAtLoad can dispatch the first tick. A failed
      // installation remains visibly enabled/missing and can be repaired or paused.
      configureWatcher(project, target, minutes);
      const installed = await reconcileWatcherTimer(project, target, host, { minutes, program });
      return { ...readWatcher(project, target), installed };
    },
    { timeoutMs: 45_000 },
  );
  // Stop the job before checking GitHub and release the control lock while verifying access.
  return action === "pause" ? scopedStatus(project, request.key, result, verify) : result;
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
