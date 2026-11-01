import type {
  WorkRecord,
  WorkFlow,
  WorkIntent,
  Attempt,
  ReviewSubmission,
} from "./types";

export function recordOf<K extends WorkRecord["kind"]>(
  records: WorkRecord[],
  kind: K,
  id: string | null | undefined,
): Extract<WorkRecord, { kind: K }> | undefined {
  return records.find(
    (r): r is Extract<WorkRecord, { kind: K }> =>
      r.kind === kind && r.id === id,
  );
}
export function recordsOf<K extends WorkRecord["kind"]>(
  records: WorkRecord[],
  kind: K,
): Extract<WorkRecord, { kind: K }>[] {
  return records.filter(
    (r): r is Extract<WorkRecord, { kind: K }> => r.kind === kind,
  );
}
export function requirementDrift(
  flow: WorkFlow,
  intent: WorkIntent,
  attempt: Attempt,
): boolean {
  return (
    attempt.flowRevisionId !== flow.approvedRevisionId ||
    attempt.intentRevisionId !== intent.approvedRevisionId ||
    flow.currentRevisionId !== flow.approvedRevisionId ||
    intent.currentRevisionId !== intent.approvedRevisionId
  );
}
export function exactPassingCoverage(
  records: WorkRecord[],
  submission: ReviewSubmission,
): boolean {
  const revision = recordOf(
    records,
    "intent-revision",
    submission.intentRevisionId,
  );
  if (!revision || !revision.criteria.length) return false;
  if (
    recordsOf(records, "evidence").some(
      (e) =>
        e.attemptId === submission.attemptId &&
        e.subjectId === submission.subjectId &&
        !submission.evidenceIds.includes(e.id),
    )
  )
    return false;
  return revision.criteria.every((criterion) => {
    const coverage = submission.coverage.find(
      (c) => c.criterionId === criterion.criterionId,
    );
    if (!coverage || coverage.result !== "pass" || !coverage.evidenceIds.length)
      return false;
    return (
      coverage.evidenceIds.every((id) => {
        const evidence = recordOf(records, "evidence", id);
        return (
          evidence &&
          submission.evidenceIds.includes(id) &&
          evidence.subjectId === submission.subjectId &&
          evidence.subjectDigest === submission.subjectDigest &&
          evidence.criterionIds.includes(criterion.criterionId) &&
          evidence.result === "pass"
        );
      }) &&
      !recordsOf(records, "evidence").some(
        (e) =>
          e.subjectId === submission.subjectId &&
          e.subjectDigest === submission.subjectDigest &&
          e.criterionIds.includes(criterion.criterionId) &&
          e.result === "fail",
      )
    );
  });
}
export function aggregateVersions(
  flow: WorkFlow,
  intent?: WorkIntent,
  attempt?: Attempt,
): Record<string, number> {
  return Object.fromEntries(
    [flow, intent, attempt]
      .filter((r) => r !== undefined)
      .map((r) => [r.id, r.version]),
  );
}
