import { existsSync } from "node:fs";
import path from "node:path";
import { verifyVisiblePullNumbers } from "../board-badge-read";
import { boardGraphql, projectGithubConnection, verifyGithubBindingUnchanged } from "../board-github";
import { readDeskReviewerProgress } from "../desk-reviewer-progress";
import { DeskRunStore, deskRunRoot } from "../desk-run-store";
import type { DeskRun, DeskRunKey } from "../desk-run-types";

export type SessionReviewAttempt = { key: DeskRunKey; run: DeskRun };
const MAX_ATTEMPTS = 10;

export function reviewBelongsToSession(cwd: string, sessionId: string, attemptId: string, storeRoot?: string): boolean {
  const store = new DeskRunStore(storeRoot, true);
  try {
    const attempt = store.byId(attemptId);
    return attempt?.cwd === cwd && attempt.run.sessionId === sessionId;
  } finally {
    store.close();
  }
}

/** Session teardown must succeed even if its optional review registry is unavailable. */
export function settleSessionReviews(cwd: string, sessionId: string, activeTokens?: readonly string[]): void {
  try {
    if (!existsSync(path.join(deskRunRoot(), "runs.sqlite"))) return;
    const store = new DeskRunStore();
    try { store.settleSessionDrafts(cwd, sessionId, undefined, activeTokens); } finally { store.close(); }
  } catch { /* Review tracking is best effort at turn and task completion. */ }
}

export async function readVisibleSessionReviews(cwd: string, sessionId: string, detailed = false): Promise<SessionReviewAttempt[]> {
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
    const repositories = new Map<string, SessionReviewAttempt[]>();
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
