import { boardGh } from "./board-github";
import type { OwnedPullRequest } from "./watcher-rebase";
import type { WatcherKey } from "./watcher-types";
import { redactSensitiveText } from "../security/service";

interface Run {
  id: number;
  head_sha: string;
  conclusion: string;
}

export async function readFailedActionsJob(subject: OwnedPullRequest, key: WatcherKey) {
  const { checkout, auth, pull } = subject;
  const raw = await boardGh(checkout, [
    "api", "--hostname", "github.com", `repos/${key.repo}/actions/runs?head_sha=${pull.headRefOid}&status=failure&per_page=10`,
  ], auth);
  const runs = (JSON.parse(raw) as { workflow_runs?: Run[] }).workflow_runs ?? [];
  const run = runs.find(item => Number.isSafeInteger(item.id) && item.id > 0 &&
    item.head_sha === pull.headRefOid && item.conclusion === "failure");
  if (!run) return null;
  const logs = await boardGh(checkout, [
    "run", "view", String(run.id), "--repo", key.repo, "--log-failed",
  ], auth, 30_000);
  const tail = logs.slice(-32_000).trim();
  return tail ? { run: run.id, logs: redactSensitiveText(tail) } : null;
}
