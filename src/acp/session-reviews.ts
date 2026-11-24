import path from "node:path";
import { readConfigFile } from "../lib/config-dir";
import { withFileLock, writeFileAtomic } from "../lib/fs";
import { redactSensitiveText } from "../security/service";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { verifyVisiblePullNumbers } from "../review/board-badge-read";
import { boardGraphql, projectGithubConnection, verifyGithubBindingUnchanged } from "../review/board-github";
import { readDeskReviewerProgress } from "../review/desk-reviewer-progress";
import { DeskRunStore } from "../review/desk-run-store";
import type { DeskRun, DeskRunKey } from "../review/desk-run-types";
import { SESSION_REVIEW_REQUEST_LIMIT, type SessionReviewSummary } from "./session-reviews-contract";

type ReviewAttempt = { key: DeskRunKey; run: DeskRun };
const MAX_ATTEMPTS = 10;
const MAX_REPORT = 12_000;
const MAX_REVIEWERS = 32;
const ATTEMPT_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function receiptPath(sessionDir: string, attemptId: string) {
  return ATTEMPT_ID.test(attemptId) ? path.join(sessionDir, `review-request-${attemptId}.txt`) : undefined;
}

export async function recordSessionReviewRequest(cwd: string, sessionId: string, sessionDir: string, attemptId: string, text: string,
  storeRoot?: string,
): Promise<string | null> {
  const receipt = receiptPath(sessionDir, attemptId);
  if (!receipt || !text.trim() || text.length > SESSION_REVIEW_REQUEST_LIMIT) return null;
  const store = new DeskRunStore(storeRoot, true);
  try {
    const attempt = store.byId(attemptId);
    if (!attempt || attempt.cwd !== cwd || attempt.run.sessionId !== sessionId) return null;
  } finally {
    store.close();
  }
  return withFileLock(receipt + ".lock", async () => {
    const previous = readConfigFile(receipt);
    if (previous.ok) return previous.text;
    const safe = redactSensitiveText(text);
    await writeFileAtomic(receipt, safe, { mode: 0o600 });
    return safe;
  });
}

export async function readVisibleSessionReviews(cwd: string, sessionId: string, detailed = false): Promise<ReviewAttempt[]> {
  let store: DeskRunStore;
  try {
    store = new DeskRunStore(undefined, true);
  } catch {
    return [];
  }
  try {
    if (!store.hasSessionAttempts(cwd, sessionId)) return [];
    const auth = await projectGithubConnection(cwd);
    const read = <T>(query: string, vars: Record<string, string | number>) => boardGraphql<T>(cwd, query, vars, auth);
    const viewer = auth.login ?? (await read<{ viewer?: { login?: string } }>("query { viewer { login } }", {})).viewer?.login;
    if (!viewer) return [];
    const attempts = store.sessionAttempts(cwd, sessionId, viewer, MAX_ATTEMPTS);
    const repositories = new Map<string, ReviewAttempt[]>();
    for (const attempt of attempts) {
      const group = repositories.get(attempt.key.repositoryId) ?? [];
      group.push(attempt);
      repositories.set(attempt.key.repositoryId, group);
    }
    const visibleGroups = await Promise.all([...repositories.values()].map(async group => {
      try {
        const visible = await verifyVisiblePullNumbers(group[0]!.key, [...new Set(group.map(({ key }) => key.number))], read);
        return group.filter(({ key }) => visible.has(key.number));
      } catch {
        return [];
      }
    }));
    verifyGithubBindingUnchanged(auth);
    const visible = new Set(visibleGroups.flat());
    return attempts.filter(attempt => visible.has(attempt)).map(attempt => {
      if (!detailed || attempt.run.source !== "manual") return attempt;
      const { run, key } = attempt;
      const pending = run.state === "running" ? store.pendingQuestions(run.id) : [];
      const progress = readDeskReviewerProgress(store.directory(run.id), key, run, true);
      return { key, run: { ...run, pendingQuestions: pending, ...(progress && { reviewerProgress: progress }) } };
    });
  } finally {
    store.close();
  }
}

export function sessionReviewSummaries(attempts: readonly ReviewAttempt[], sessionId: string, sessionDir?: string): SessionReviewSummary[] {
  return attempts.map(({ key, run }) => {
    const receipt = sessionDir && receiptPath(sessionDir, run.id);
    const stored = receipt ? readConfigFile(receipt) : undefined;
    return {
      id: run.id,
      sessionId,
      key,
      revision: { baseSha: run.baseSha, headSha: run.headSha },
      ...(stored?.ok && { prompt: stored.text.slice(0, SESSION_REVIEW_REQUEST_LIMIT) }),
    };
  });
}

export function sessionReviewsTool(read: () => Promise<ReviewAttempt[]>): InteractiveTool {
  return {
    definition: {
      name: "session_reviews",
      description: "Read current PR review status, reviewer progress, pending questions and results for this conversation. Use it when the user asks about a review launched from this chat or the Desktop PR board. Use progress.planned, finished and completed for assignment totals. The activity and plan lists may be partial.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
    },
    invoke: async () => {
      try {
        const attempts = await read();
        const output = attempts.map(({ key, run }, index) => ({
          pullRequest: `https://github.com/${key.repo}/pull/${key.number}`,
          title: run.pullRequestTitle,
          baseSha: run.baseSha,
          headSha: run.headSha,
          state: run.state,
          phase: run.phase,
          reason: run.reason,
          publication: run.publication,
          plan: run.reviewerProgress?.planSummary,
          settings: run.options,
          progress: run.reviewerProgress && {
            planned: run.reviewerProgress.planned,
            finished: run.reviewerProgress.finished,
            completed: run.reviewerProgress.completed ?? null,
            wave: run.reviewerProgress.wave,
            activityTruncated: run.reviewerProgress.sessions.length > MAX_REVIEWERS,
            activity: run.reviewerProgress.sessions.slice(0, MAX_REVIEWERS)
              .map(({ reviewer, state, outcomeReason }) => ({ reviewer, state, outcomeReason })),
          },
          pendingQuestions: run.pendingQuestions?.map(({ reviewer, question }) => ({ reviewer, question })),
          result: run.result && {
            ...run.result,
            report: index === 0 ? run.result.report.slice(0, MAX_REPORT) : undefined,
            reportTruncated: index !== 0 || run.result.reportDeferred || run.result.report.length > MAX_REPORT,
          },
        }));
        return { output: JSON.stringify(output), isError: false, untrusted: true };
      } catch {
        return { output: "Review status is unavailable for this project's current GitHub account.", isError: true };
      }
    },
  };
}
