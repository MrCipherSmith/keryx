import type { WatcherKey, WatcherSnapshot } from "../../../../src/review/watcher-types";
import { invoke } from "./backend";

export type ReviewWatcherKey = WatcherKey;
export type ReviewWatcherSnapshot = WatcherSnapshot;
export type ReviewWatcherAction =
  | { kind: "enable"; intervalMinutes: number }
  | { kind: "status" | "pause" | "resume" };

export async function reviewWatcher(cwd: string, target: WatcherKey | null, action: ReviewWatcherAction): Promise<WatcherSnapshot> {
  const value = await invoke<WatcherSnapshot>("review_watcher", { cwd, target, action });
  if (value?.version !== 1 || !Array.isArray(value.events) || typeof value.installed !== "boolean") {
    throw new Error("Check that your selected Keryx CLI supports the local PR watcher.");
  }
  return value;
}
