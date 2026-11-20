import { errMessage } from "../lib/format";
import { type reviewRun, type ReviewRunAction } from "../platform/reviewRuns";
import type { DeskRunKey } from "../../../../src/review/desk-run-types";

interface Backoff { until: number; delay: number }
const deadlines = new WeakMap<typeof reviewRun, Map<string, Backoff>>();

/** All status polls share GitHub's account/repository limit. A user-initiated retry can probe immediately. */
export async function readRunStatus(
  invoke: typeof reviewRun, cwd: string, key: DeskRunKey, action: Extract<ReviewRunAction, { kind: "status" }> = { kind: "status" }, automatic = false,
) {
  return withRunBackoff(invoke, key, automatic, () => invoke(cwd, key, action));
}

export async function withRunBackoff<T>(invoke: typeof reviewRun, key: Pick<DeskRunKey, "repositoryId" | "viewer">, automatic: boolean, read: () => Promise<T>) {
  const scope = JSON.stringify([key.repositoryId, key.viewer.toLowerCase()]);
  let retries = deadlines.get(invoke);
  if (!retries) deadlines.set(invoke, retries = new Map());
  const old = retries.get(scope);
  if (automatic && old && old.until > Date.now()) return;
  try {
    const result = await read();
    retries.delete(scope);
    return result;
  } catch (error) {
    const message = errMessage(error);
    const limited = /rate limit|too many requests|HTTP 429/i.test(message);
    if (limited || /^unavailable:/i.test(message)) {
      const delay = Math.min(300_000, Math.max(limited ? 60_000 : 12_000, (old?.delay ?? 0) * 2));
      retries.set(scope, { until: Date.now() + delay, delay });
    }
    throw error;
  }
}
