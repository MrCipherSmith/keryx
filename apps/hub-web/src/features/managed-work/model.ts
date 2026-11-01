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
    attempt.intentRevisionId !== intent.approvedRevisionId
  );
}
export function criterionHasExactPassingEvidence(
  records: WorkRecord[],
  submission: ReviewSubmission,
  criterionId: string,
): boolean {
  const coverage = submission.coverage.find(
    (c) => c.criterionId === criterionId,
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
        evidence.criterionIds.includes(criterionId) &&
        evidence.result === "pass"
      );
    }) &&
    !recordsOf(records, "evidence").some(
      (e) =>
        e.subjectId === submission.subjectId &&
        e.subjectDigest === submission.subjectDigest &&
        e.criterionIds.includes(criterionId) &&
        e.result === "fail",
    )
  );
}
export function exactPassingCoverage(
  records: WorkRecord[],
  submission: ReviewSubmission,
  waiverIds: string[] = [],
): boolean {
  const revision = recordOf(
    records,
    "intent-revision",
    submission.intentRevisionId,
  );
  if (
    !revision ||
    !revision.criteria.length ||
    waiverIds.some(
      (id) =>
        !revision.criteria.some((c) => c.criterionId === id && c.waivable),
    )
  )
    return false;
  if (
    recordsOf(records, "evidence").some(
      (e) =>
        e.attemptId === submission.attemptId &&
        e.subjectId === submission.subjectId &&
        !submission.evidenceIds.includes(e.id),
    )
  )
    return false;
  return revision.criteria.every(
    (criterion) =>
      waiverIds.includes(criterion.criterionId) ||
      criterionHasExactPassingEvidence(
        records,
        submission,
        criterion.criterionId,
      ),
  );
}
export function pendingAmendments(records: WorkRecord[], flowId: string) {
  const decisions = recordsOf(records, "decision");
  return recordsOf(records, "amendment").filter(
    (m) =>
      m.flowId === flowId &&
      !decisions.some(
        (d) =>
          d.targetType === "amendment" &&
          d.targetId === m.id &&
          ["approve", "withdraw"].includes(d.decision),
      ),
  );
}
export function flowStartReady(records: WorkRecord[], flow: WorkFlow): boolean {
  const fr = recordOf(records, "flow-revision", flow.approvedRevisionId);
  if (
    !fr ||
    flow.currentRevisionId !== fr.id ||
    flow.state !== "ready" ||
    pendingAmendments(records, flow.id).length
  )
    return false;
  const required = recordsOf(records, "intent").filter(
    (i) => i.flowId === flow.id && fr.requiredIntentIds.includes(i.id),
  );
  if (
    !required.length ||
    required.length !== fr.requiredIntentIds.length ||
    required.some((i) => !fr.requiredIntentIds.includes(i.id))
  )
    return false;
  const mapped = new Set<string>();
  for (const i of required) {
    const ir = recordOf(records, "intent-revision", i.approvedRevisionId);
    if (
      !ir ||
      i.currentRevisionId !== ir.id ||
      ir.flowRevisionId !== fr.id ||
      ["draft", "cancelled"].includes(i.state)
    )
      return false;
    ir.criterionMappings.forEach((m) => mapped.add(m.flowCriterionId));
  }
  return fr.criteria.every((c) => mapped.has(c.criterionId));
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
