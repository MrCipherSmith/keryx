import { afterEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { workRead } from './domain';
import { scopedFixture, context, human, flowPayload } from './storage.fixture.test-support';

const databases: Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
function fixture(...args: Parameters<typeof scopedFixture>) {
    const value = scopedFixture(...args); databases.push(value.db); return value;
}

test('full manual lifecycle seals exact evidence, requires human selection, and accepts aggregate', () => {
    const { state, cmd, flowId, intentId, fr, ir, ctx, a, subject, sub } = fixture();
    expect<unknown>(() => cmd('review.decide', { targetType: 'intent-review', targetId: intentId, submissionId: sub.id, submissionDigest: sub.contentDigest, decision: 'accept', reason: 'Review', waivers: [] })).toThrow();
    cmd('attempt.select', { intentId, attemptId: a.id, submissionId: sub.id, submissionDigest: sub.contentDigest, reason: 'Choose' });
    const accepted = cmd('review.decide', { targetType: 'intent-review', targetId: intentId, submissionId: sub.id, submissionDigest: sub.contentDigest, decision: 'accept', reason: 'Review', waivers: [] });
    const preview = workRead(state, human, 'p', ['flows', flowId, 'acceptance-preview'], new URL('http://hub'), context) as Record<string, unknown>;
    const fs = cmd('flow.submit', { flowId, flowRevisionId: fr.id, acceptedIntentDecisionIds: [accepted.id], acceptanceManifestDigest: preview.acceptanceManifestDigest });
    cmd('review.decide', { targetType: 'flow-review', targetId: flowId, submissionId: fs.id, submissionDigest: fs.contentDigest, decision: 'accept', reason: 'All reviewed', waivers: [] });
    expect<unknown>((state.records.find(r => r.id === flowId && r.kind === 'flow') as {
        state: string;
    })?.state).toBe('accepted');
    expect<unknown>((subject.artifacts as {
        verification: string;
    }[])[0]?.verification).toBe('claimed');
    const before = JSON.stringify(state);
    expect<unknown>(() => cmd('attempt.start', { attemptId: a.id, flowRevisionDigest: fr.contentDigest, intentRevisionDigest: ir.contentDigest, contextDigest: ctx.contentDigest })).toThrow();
    expect<unknown>(JSON.stringify(state)).toBe(before);
});
test('late contradictory Evidence blocks acceptance but permits changes requested and successor Attempt', () => {
    const { state, cmd, intentId, a, subject, sub, ir, ctx } = fixture();
    cmd('attempt.select', { intentId, attemptId: a.id, submissionId: sub.id, submissionDigest: sub.contentDigest, reason: 'Select' });
    cmd('evidence.record', { attemptId: a.id, subjectId: subject.id, subjectDigest: subject.contentDigest, criterionIds: ['ic'], result: 'fail', method: 'late-test', report: 'Regression', outputDigest: 'b'.repeat(64), sourceRunId: null, sourceObservationId: null });
    const review = { targetType: 'intent-review', targetId: intentId, submissionId: sub.id, submissionDigest: sub.contentDigest, reason: 'Review', waivers: [] };
    const before = JSON.stringify(state);
    expect<unknown>(() => cmd('review.decide', { ...review, decision: 'accept' })).toThrow('Late Evidence');
    expect<unknown>(JSON.stringify(state)).toBe(before);
    cmd('review.decide', { ...review, decision: 'request-changes' });
    const successor = cmd('attempt.create', { intentRevisionId: ir.id, contextSnapshotId: ctx.id, participantId: 'h', method: 'human', summary: 'Fix regression', supersedesAttemptId: a.id });
    expect<unknown>(successor.supersedesAttemptId).toBe(a.id);
    expect<unknown>(state.records.filter(r => r.kind === 'submission')).toHaveLength(1);
});
test('approved amendment applies whole replacement set atomically and leaves old Attempt pins immutable', () => {
    const { state, cmd, flowId, intentId, fr, ir, a, ctx, intentPayload } = fixture();
    const next = cmd('revision.propose', { targetType: 'intent', intentId, flowRevisionId: fr.id, deliverable: 'Changed deliverable', approach: 'Manual', outOfScope: 'None', criteria: intentPayload.criteria, flowCriterionIds: ['fc'], criterionMappings: intentPayload.criterionMappings });
    const amendment = cmd('requirements.amend', { flowId, sourceFlowRevisionId: fr.id, affectedIntentIds: [intentId], replacements: [{ targetType: 'intent', targetId: intentId, revisionId: next.id, contentDigest: next.contentDigest }], reason: 'Changed requirement' });
    const before = JSON.stringify(state);
    expect<unknown>(() => cmd('attempt.create', { intentRevisionId: ir.id, contextSnapshotId: ctx.id, participantId: 'h', method: 'human', summary: 'Blocked by amendment', supersedesAttemptId: null })).toThrow('pending');
    expect<unknown>(JSON.stringify(state)).toBe(before);
    cmd('requirements.resolve-amendment', { amendmentId: amendment.id, manifestDigest: amendment.contentDigest, decision: 'approve', reason: 'Approve all' });
    const oldAttempt = state.records.find(r => r.id === a.id);
    expect<unknown>(oldAttempt?.kind === 'attempt' && oldAttempt.intentRevisionId).toBe(ir.id);
    const intent = state.records.find(r => r.id === intentId);
    expect<unknown>(intent?.kind === 'intent' && intent.approvedRevisionId).toBe(next.id);
    expect<unknown>(() => cmd('attempt.create', { intentRevisionId: ir.id, contextSnapshotId: ctx.id, participantId: 'h', method: 'human', summary: 'Old pins', supersedesAttemptId: null })).toThrow();
});
test('a proposal changed after amendment cannot partially replace approved requirements', () => {
    const { state, cmd, flowId, intentId, fr, ir, intentPayload } = fixture();
    const payload = { targetType: 'intent', intentId, flowRevisionId: fr.id, deliverable: 'Change', approach: 'Manual', outOfScope: 'None', criteria: intentPayload.criteria, flowCriterionIds: ['fc'], criterionMappings: intentPayload.criterionMappings };
    const next = cmd('revision.propose', payload);
    const amendment = cmd('requirements.amend', { flowId, sourceFlowRevisionId: fr.id, affectedIntentIds: [intentId], replacements: [{ targetType: 'intent', targetId: intentId, revisionId: next.id, contentDigest: next.contentDigest }], reason: 'Changed requirement' });
    cmd('revision.propose', { ...payload, deliverable: 'Change again' });
    const before = JSON.stringify(state);
    expect<unknown>(() => cmd('requirements.resolve-amendment', { amendmentId: amendment.id, manifestDigest: amendment.contentDigest, decision: 'approve', reason: 'Stale click' })).toThrow('Replacement');
    expect<unknown>(JSON.stringify(state)).toBe(before);
    const intent = state.records.find(r => r.id === intentId);
    expect<unknown>(intent?.kind === 'intent' && intent.approvedRevisionId).toBe(ir.id);
    cmd('requirements.resolve-amendment', { amendmentId: amendment.id, manifestDigest: amendment.contentDigest, decision: 'withdraw', reason: 'Withdraw stale proposal' });
});
test('post-acceptance contradictory evidence appears once in attention and Flow without rewriting historical acceptance', () => {
    const { state, cmd, intentId, flowId, a, subject, sub } = fixture();
    cmd('attempt.select', { intentId, attemptId: a.id, submissionId: sub.id, submissionDigest: sub.contentDigest, reason: 'Select' });
    const decision = cmd('review.decide', { targetType: 'intent-review', targetId: intentId, submissionId: sub.id, submissionDigest: sub.contentDigest, decision: 'accept', reason: 'Accepted exact subject', waivers: [] });
    const historical = JSON.stringify(state.records.find(r => r.id === decision.id));
    const late = cmd('evidence.record', { attemptId: a.id, subjectId: subject.id, subjectDigest: subject.contentDigest, criterionIds: ['ic'], result: 'fail', method: 'late check', report: 'Contradiction', outputDigest: 'e'.repeat(64), sourceRunId: null, sourceObservationId: null });
    const foreign = state.records.find(r => r.id === late.id)!;
    state.records.push({ ...structuredClone(foreign), id: 'foreign-evidence', projectId: 'other-project' });
    const before = JSON.stringify(state);
    const attention = workRead(state, human, 'p', ['attention'], new URL('http://hub')) as {
        records: {
            id: string;
            kind: string;
            attemptId?: string;
            subjectId?: string;
        }[];
    };
    expect(attention.records.filter(r => r.kind === 'evidence').map(r => r.id)).toEqual([late.id as string]);
    expect(attention.records.find(r => r.id === late.id)).toMatchObject({ attemptId: a.id, subjectId: subject.id });
    const flow = workRead(state, human, 'p', ['flows', flowId], new URL('http://hub')) as {
        records: {
            id: string;
        }[];
    };
    expect(flow.records.some(r => r.id === late.id)).toBe(true);
    expect(flow.records.some(r => r.id === 'foreign-evidence')).toBe(false);
    expect(new Set(attention.records.map(r => r.id)).size).toBe(attention.records.length);
    expect(JSON.stringify(state.records.find(r => r.id === decision.id))).toBe(historical);
    expect(JSON.stringify(state)).toBe(before);
    expect(() => workRead(state, human, 'p', ['flows', flowId, 'acceptance-preview'], new URL('http://hub'), context)).toThrow('Late evidence');
});
test('late failure remediation proposes on accepted Intent without reopening, applies human amendment, then replacement acceptance resolves attention', () => {
    const { state, cmd, flowId, intentId, fr, ir, a, subject, sub, intentPayload } = fixture();
    cmd('attempt.select', { intentId, attemptId: a.id, submissionId: sub.id, submissionDigest: sub.contentDigest, reason: 'Original select' });
    const originalDecision = cmd('review.decide', { targetType: 'intent-review', targetId: intentId, submissionId: sub.id, submissionDigest: sub.contentDigest, decision: 'accept', reason: 'Original acceptance', waivers: [] });
    const oldHistory = JSON.stringify(state.records.filter(r => r.id === originalDecision.id || r.id === sub.id || r.id === subject.id));
    const late = cmd('evidence.record', { attemptId: a.id, subjectId: subject.id, subjectDigest: subject.contentDigest, criterionIds: ['ic'], result: 'fail', method: 'late test', report: 'Regression', outputDigest: 'a'.repeat(64), sourceRunId: null, sourceObservationId: null });
    const actions = (workRead(state, human, 'p', ['intents', intentId], new URL('http://hub')) as {
        actions: {
            command: string;
            allowed: boolean;
        }[];
    }).actions;
    expect(actions.find(a => a.command === 'revision.propose')?.allowed).toBe(true);
    const next = cmd('revision.propose', { targetType: 'intent', intentId, flowRevisionId: fr.id, deliverable: 'Remediate regression', approach: 'Manual', outOfScope: 'None', criteria: intentPayload.criteria, flowCriterionIds: ['fc'], criterionMappings: intentPayload.criterionMappings });
    expect(state.records.find(r => r.id === intentId)).toMatchObject({ state: 'accepted', approvedRevisionId: ir.id, acceptanceDecisionId: originalDecision.id, currentRevisionId: next.id });
    const amendment = cmd('requirements.amend', { flowId, sourceFlowRevisionId: fr.id, affectedIntentIds: [intentId], reason: 'Human-approved remediation', replacements: [{ targetType: 'intent', targetId: intentId, revisionId: next.id, contentDigest: next.contentDigest }] });
    cmd('requirements.resolve-amendment', { amendmentId: amendment.id, manifestDigest: amendment.contentDigest, decision: 'approve', reason: 'Approve remediation requirements' });
    const during = workRead(state, human, 'p', ['attention'], new URL('http://hub')) as {
        records: {
            id: string;
        }[];
    };
    expect(during.records.some(r => r.id === late.id)).toBe(true);
    cmd('flow.start', { flowId, flowRevisionDigest: fr.contentDigest });
    const ctx = cmd('context.create', { flowRevisionId: fr.id, intentRevisionId: next.id, entries: [], gitBases: [] });
    const replacement = cmd('attempt.create', { intentRevisionId: next.id, contextSnapshotId: ctx.id, participantId: 'h', method: 'human', summary: 'Remediation', supersedesAttemptId: null });
    cmd('attempt.start', { attemptId: replacement.id, flowRevisionDigest: fr.contentDigest, intentRevisionDigest: next.contentDigest, contextDigest: ctx.contentDigest });
    const result = cmd('subject.create', { attemptId: replacement.id, artifacts: [{ kind: 'git', repositoryId: 'repo', commitOid: 'd'.repeat(40), treeOid: null, pullRequestNumber: null }], report: 'Fixed regression' });
    const check = cmd('evidence.record', { attemptId: replacement.id, subjectId: result.id, subjectDigest: result.contentDigest, criterionIds: ['ic'], result: 'pass', method: 'remediation test', report: 'Passed', outputDigest: 'b'.repeat(64), sourceRunId: null, sourceObservationId: null });
    const submission = cmd('attempt.submit', { attemptId: replacement.id, subjectId: result.id, subjectDigest: result.contentDigest, evidenceIds: [check.id], coverage: [{ criterionId: 'ic', result: 'pass', evidenceIds: [check.id] }], knowledgeFollowup: { proposalIds: [], noUpdateReason: 'None' } });
    cmd('attempt.select', { intentId, attemptId: replacement.id, submissionId: submission.id, submissionDigest: submission.contentDigest, reason: 'Select remediation' });
    cmd('review.decide', { targetType: 'intent-review', targetId: intentId, submissionId: submission.id, submissionDigest: submission.contentDigest, decision: 'accept', reason: 'Human verified remediation', waivers: [] });
    const resolved = workRead(state, human, 'p', ['attention'], new URL('http://hub')) as {
        records: {
            id: string;
        }[];
    };
    expect(resolved.records.some(r => r.id === late.id)).toBe(false);
    expect(JSON.stringify(state.records.filter(r => r.id === originalDecision.id || r.id === sub.id || r.id === subject.id))).toBe(oldHistory);
    expect(state.records.some(r => r.id === late.id)).toBe(true);
    expect(() => workRead(state, human, 'p', ['flows', flowId, 'acceptance-preview'], new URL('http://hub'), context)).not.toThrow();
});
test('membership amendment drops a cancelled approved Intent without requiring an impossible replacement', () => {
    const { state, cmd, flowId, intentId, fr, optional, optionalRevision, intentPayload } = fixture(false, 'pass', false, true);
    if (!optional || !optionalRevision) throw new Error('Missing optional fixture');
    cmd('work.cancel', { targetType: 'intent', targetId: intentId, reason: 'Remove cancelled deliverable from scope' });
    const nextFlow = cmd('revision.propose', { targetType: 'flow', flowId, problem: flowPayload.problem, expectedOutcome: flowPayload.expectedOutcome, scope: flowPayload.scope, outOfScope: flowPayload.outOfScope, specification: null, criteria: flowPayload.criteria, requiredIntentIds: [optional.id] });
    const nextIntent = cmd('revision.propose', { targetType: 'intent', intentId: optional.id, flowRevisionId: nextFlow.id, deliverable: intentPayload.deliverable, approach: intentPayload.approach, outOfScope: intentPayload.outOfScope, criteria: intentPayload.criteria, flowCriterionIds: intentPayload.flowCriterionIds, criterionMappings: intentPayload.criterionMappings });
    const amendment = cmd('requirements.amend', { flowId, sourceFlowRevisionId: fr.id, affectedIntentIds: [optional.id], replacements: [{ targetType: 'flow', targetId: flowId, revisionId: nextFlow.id, contentDigest: nextFlow.contentDigest }, { targetType: 'intent', targetId: optional.id, revisionId: nextIntent.id, contentDigest: nextIntent.contentDigest }], reason: 'Drop cancelled membership' });
    cmd('requirements.resolve-amendment', { amendmentId: amendment.id, manifestDigest: amendment.contentDigest, decision: 'approve', reason: 'Reviewed membership change' });
    cmd('flow.start', { flowId, flowRevisionDigest: nextFlow.contentDigest });
    expect(state.records.find(r => r.id === flowId)).toMatchObject({ state: 'in-progress', approvedRevisionId: nextFlow.id });
    expect(state.records.find(r => r.id === intentId)).toMatchObject({ state: 'cancelled' });
});