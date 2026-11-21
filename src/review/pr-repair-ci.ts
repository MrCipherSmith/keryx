import { boardGh } from "./board-github";
import type { OwnedPullRequest } from "./watcher-rebase";
import type { WatcherKey } from "./watcher-types";
import { redactSensitiveText } from "../security/service";

interface Run {
  id: number;
  workflow_id: number;
  head_sha: string;
  conclusion: string;
}

export async function readFailedActionsJobs(subject: OwnedPullRequest, key: WatcherKey) {
  const { checkout, auth, pull } = subject;
  const raw = await boardGh(checkout, [
    "api", "--hostname", "github.com", `repos/${key.repo}/actions/runs?head_sha=${pull.headRefOid}&status=failure&per_page=10`,
  ], auth);
  const runs = (JSON.parse(raw) as { workflow_runs?: Run[] }).workflow_runs ?? [];
  const workflows = new Map<number, Run>();
  for (const run of runs) {
    if (!Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.workflow_id) ||
        run.head_sha !== pull.headRefOid || run.conclusion !== "failure" || workflows.has(run.workflow_id)) continue;
    workflows.set(run.workflow_id, run);
    if (workflows.size === 4) break;
  }
  const failedJobs = await Promise.allSettled([...workflows.values()].map(async run => {
    const logs = await boardGh(checkout, [
      "run", "view", String(run.id), "--repo", key.repo, "--log-failed",
    ], auth, 30_000);
    return { run: run.id, logs: redactSensitiveText(logs.slice(-8_000).trim()) };
  }));
  const evidence = failedJobs.flatMap(result => result.status === "fulfilled" && result.value.logs ? [result.value] : []);
  return evidence.length ? evidence : null;
}
