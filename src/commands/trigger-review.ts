// Flow 424 (AC9): a scheduled autonomous review — an `agent-task` entry that carries `action.review`.
//
// The OS timer runs `keryx trigger run <name>`; this runs the same autonomous review as
// `keryx review run --autonomous`, after checking that the stored entry is still exactly what the
// operator confirmed. The review's own files and exit status live in its run directory; this only
// turns the verdict into the trigger run record.

import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createTelegramNotifier, endLine, startLine, type RunNotifier } from "../review/autonomous-notify";
import { parseAutonomousTarget } from "../review/autonomous-profile";
import { AutonomousRunLockedError, runAutonomousReview, type AutonomousRunOptions, type AutonomousRunResult } from "../review/autonomous-run";
import type { AgentTaskAction, TriggerEntry } from "../trigger/config";
import { expectedReportRelPath, type DispatchRefusalCode } from "../trigger/record";
import { confirmedContentProblem } from "../trigger/schedule-verify";
import type { AgentTaskResult } from "./trigger-agent-task";

export interface ReviewScheduleDeps {
  readonly run?: (options: AutonomousRunOptions) => Promise<AutonomousRunResult>;
  readonly notifier?: RunNotifier;
  readonly verify?: (projectRoot: string, entry: TriggerEntry) => Promise<{ readonly code: DispatchRefusalCode; readonly reason: string } | undefined>;
  readonly runId?: () => string;
}

/** Put the review's report where every other scheduled report lives, so `schedule list` and the sidebar find it. */
async function publishReport(projectRoot: string, trigger: string, runId: string, runDir: string): Promise<string | undefined> {
  const relative = expectedReportRelPath(trigger, runId);
  if (relative === undefined) return undefined;
  const target = path.join(projectRoot, relative);
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(runDir, "report.md"), target);
    return relative;
  } catch {
    return undefined;
  }
}

const NO_PRICE = "an autonomous review reports its tokens but no price";

export async function runReviewDispatch(
  projectRoot: string,
  entry: TriggerEntry,
  action: AgentTaskAction,
  deps: ReviewScheduleDeps = {},
): Promise<AgentTaskResult> {
  const review = action.review;
  const runId = deps.runId?.() ?? `rev-${Date.now().toString(36)}`;
  const record = { runId, permissionMode: action.dispatch.permissionMode, network: action.grants.network } as const;
  if (review === undefined) {
    return { outcome: "failed", detail: `schedule "${entry.name}" has no review block`, cost: { recorded: false, reason: "no review ran" }, agentTask: record, exitCode: 1 };
  }
  const changed = await (deps.verify ?? confirmedContentProblem)(projectRoot, entry);
  if (changed !== undefined) {
    return {
      outcome: "dispatch-refused",
      detail: changed.reason,
      cost: { recorded: false, reason: "no review started — the stored schedule no longer matches what was confirmed" },
      agentTask: { ...record, refusal: changed.code },
      exitCode: 1,
    };
  }
  const target = parseAutonomousTarget(review.ref);
  const notifier = deps.notifier ?? createTelegramNotifier({ project: path.basename(projectRoot), target });
  try {
    await notifier.started(startLine(target, 1));
    const result = await (deps.run ?? runAutonomousReview)({
      cwd: projectRoot,
      ref: review.ref,
      stallMs: review.stallMinutes * 60_000,
      provider: action.dispatch.provider,
      model: action.dispatch.model,
      ...(review.budgetMinutes === undefined ? {} : { budgetMinutes: review.budgetMinutes }),
      ...(review.budgetTokens === undefined ? {} : { budgetTokens: review.budgetTokens }),
    });
    await notifier.finished(endLine(result.summary));
    const complete = result.exitCode === 0;
    const reportPath = await publishReport(projectRoot, entry.name, runId, result.runDir);
    return {
      outcome: complete ? "ok" : "failed",
      detail: `autonomous review ${result.reused ? "reused" : result.status} (exit ${result.exitCode}): ${result.summary.reason}`,
      cost: { recorded: false, reason: `${NO_PRICE} (${result.summary.tokens} tokens)` },
      agentTask: { ...record, ...(reportPath !== undefined ? { reportPath } : {}) },
      exitCode: complete ? 0 : 1,
    };
  } catch (problem) {
    if (problem instanceof AutonomousRunLockedError) {
      return {
        outcome: "lock-refused",
        detail: problem.message,
        cost: { recorded: false, reason: "no review started — another run of this pull request holds the lock" },
        agentTask: { ...record, refusal: "dispatch-locked" },
        exitCode: 1,
      };
    }
    return {
      outcome: "failed",
      detail: `autonomous review failed: ${problem instanceof Error ? problem.message : String(problem)}`,
      cost: { recorded: false, reason: "the review failed before its cost could be measured" },
      agentTask: record,
      exitCode: 1,
    };
  } finally {
    await notifier.close();
  }
}
