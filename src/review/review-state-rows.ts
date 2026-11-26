// Desktop Review v3, stage 2 (minimal): the Reviews list reads the rounds of review.json beside the v2 attempts of
// runs.sqlite. A review started as a turn in a live session writes only review.json, so without this its round never
// reaches the list: a retry left the card on its old v2 state and no card showed in Running.
// Pure: the caller reads the records (`listReviewStates`) and the stored rows (`readReviewRows`).
import type { DeskRunState } from "./desk-run-types";
import type { ReviewAttemptSummary, ReviewRow } from "./review-entity";
import type { ReviewRecord, ReviewRound, RoundState } from "./review-state";

/** A round still planning, dispatching or reconciling is a running attempt; `paused` stopped; `ready` finished. */
const ROUND_ATTEMPT_STATE: Readonly<Record<RoundState, DeskRunState>> = {
  planning: "running",
  dispatching: "running",
  reconciling: "running",
  paused: "cancelled",
  ready: "completed",
};

/** Whether a review.json record belongs to this repository and viewer. */
export function recordMatches(record: ReviewRecord, repo: string, repositoryId: string, viewer: string): boolean {
  const sameRepository = record.pr.repositoryId ? record.pr.repositoryId === repositoryId : record.pr.repo.toLowerCase() === repo.toLowerCase();
  return sameRepository && (record.viewer === null || record.viewer === viewer);
}

const sameRange = (a: { baseSha: string; headSha: string }, b: { baseSha: string; headSha: string }) =>
  a.baseSha === b.baseSha && a.headSha === b.headSha;

/**
 * One attempt per review.json round. A round over a range the stored attempts already hold joins that round (a retry
 * of the same revision); any other round is numbered after every round the Review already has, so v2 and v3 numbers
 * never collide on different ranges.
 */
export function roundAttempts(record: ReviewRecord, stored: readonly ReviewAttemptSummary[]): ReviewAttemptSummary[] {
  let highest = stored.reduce((max, attempt) => Math.max(max, attempt.round), 0);
  const assigned: Array<{ baseSha: string; headSha: string; round: number }> = [];
  return [...record.rounds].sort((a, b) => a.number - b.number).map(round => {
    const known = stored.find(attempt => sameRange(attempt, round)) ?? assigned.find(entry => sameRange(entry, round));
    const number = known ? known.round : ++highest;
    if (!known) assigned.push({ baseSha: round.baseSha, headSha: round.headSha, round: number });
    return roundAttempt(record, round, number);
  });
}

function roundAttempt(record: ReviewRecord, round: ReviewRound, number: number): ReviewAttemptSummary {
  const state = ROUND_ATTEMPT_STATE[round.state];
  const finished = state === "completed";
  const published = record.publications.some(publication => publication.round === round.number);
  return {
    ...(round.sessionId ? { sessionId: round.sessionId } : {}),
    id: `${record.id}#${round.number}`,
    round: number,
    previousRunId: null,
    state,
    source: "session",
    baseSha: round.baseSha,
    headSha: round.headSha,
    reviewed: finished ? { baseSha: round.baseSha, headSha: round.headSha } : null,
    coverage: null,
    findings: round.findings
      ? { blocker: round.findings.blocker, major: round.findings.major, minor: round.findings.minor, info: round.findings.info }
      : null,
    verdict: round.verdict,
    publication: published ? "published" : finished ? "pending" : null,
    decision: null,
    flowId: null,
    tokens: round.usage.tokens > 0 ? round.usage.tokens : null,
    // A question the session asks is shown by the session itself; review.json does not record it.
    awaitingAnswer: false,
    archived: false,
    createdAt: round.openedAt,
    finishedAt: finished || state === "cancelled" ? round.updatedAt : null,
  };
}

/**
 * The stored rows with the matching review.json rounds added: to the row of the same PR, or as a new row. Attempts
 * stay oldest first by creation time, so a round opened after the last v2 attempt is the Review's latest attempt.
 */
export function mergeReviewStateRows(rows: readonly ReviewRow[], records: readonly ReviewRecord[], repositoryId: string, viewer: string): ReviewRow[] {
  const byNumber = new Map(rows.map(row => [row.number, { ...row, attempts: [...row.attempts] }]));
  for (const record of records) {
    if (!record.rounds.length) continue;
    const existing = byNumber.get(record.pr.number);
    const row: ReviewRow = existing ?? {
      id: record.id,
      repositoryId,
      number: record.pr.number,
      viewer,
      closedAt: null,
      onHeadMove: record.onHeadMove,
      attempts: [],
    };
    row.attempts.push(...roundAttempts(record, row.attempts));
    row.attempts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (record.state === "closed" && row.closedAt === null) row.closedAt = record.updatedAt;
    byNumber.set(record.pr.number, row);
  }
  return [...byNumber.values()];
}
