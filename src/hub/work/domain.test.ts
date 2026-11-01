import { describe, expect, test } from 'bun:test';
import { createWorkState, workCommand, workRead, workDigest } from './domain';
import type { Principal } from '../contracts';
import type { HubState } from '../store';
const human: Principal = { id: 'h', kind: 'human', role: 'operator' };
const context = { verifySubjectForAcceptance: () => { }, resolveRepository: (projectId: string, id: string) => id === 'repo' ? { id, projectId, objectFormat: 'sha1' as const } : undefined, legacy: { projects: [{ id: 'p', name: 'P', version: 1, lineRevisionId: null, lineVersion: 1, contextRevision: 0 }], documents: [], proposals: [], flows: [], evidence: [], revisions: [], deliveries: [], events: [], documentChanges: [], sessions: {}, replays: {} } as HubState, now: () => '2026-11-01T00:00:00Z' };
export const flowPayload = { title: 'Work', problem: 'Problem', expectedOutcome: 'Outcome', scope: 'Scope', outOfScope: 'None', ownerId: 'h', specification: null, criteria: [{ criterionId: 'fc', text: 'Works', waivable: false }] };
describe('managed work domain', () => {
    test('creates immutable draft revision, denies agent approval and stale CAS without mutation', () => {
        const state = createWorkState();
        workCommand(state, human, 'p', { operationId: 'create', expectedVersions: {}, command: 'flow.create', payload: flowPayload }, context);
        const flow = state.records.find(r => r.kind === 'flow')!, revision = state.records.find(r => r.kind === 'flow-revision')!;
        expect<unknown>(flow.kind === 'flow' && flow.state).toBe('draft');
        const command = { operationId: 'approve', expectedVersions: { [flow.id]: 1 }, command: 'requirements.approve', payload: { targetType: 'flow-revision', revisionId: revision.id, revisionDigest: 'contentDigest' in revision ? revision.contentDigest : '', flowRevisionId: revision.id, reason: 'Reviewed' } };
        const before = JSON.stringify(state);
        expect<unknown>(() => workCommand(state, { id: 'a', kind: 'agent', role: 'agent' }, 'p', command, context)).toThrow();
        expect<unknown>(JSON.stringify(state)).toBe(before);
        workCommand(state, human, 'p', command, context);
        expect<unknown>(() => workCommand(state, human, 'p', { ...command, operationId: 'stale' }, context)).toThrow();
    });
});
function fixture(waivable = false, evidenceResult: 'pass' | 'fail' | 'inconclusive' = 'pass', flowWaivable = false, includeOptional = false) {
    const state = createWorkState();
    let op = 0;
    const cmd = (command: string, payload: unknown, actor = human) => workCommand(state, actor, 'p', { operationId: 'op' + (++op), expectedVersions: Object.fromEntries(state.records.filter(r => 'version' in r).map(r => [r.id, 'version' in r ? r.version : 1])), command, payload }, context).result as Record<string, unknown>;
    const flowCriteria = flowPayload.criteria.map(c => ({ ...c, waivable: flowWaivable }));
    const f = cmd('flow.create', { ...flowPayload, criteria: flowCriteria }), flowId = f.id as string;
    const intentPayload = { flowId, title: 'Deliver', deliverable: 'Thing', approach: 'Manual', outOfScope: 'None', ownerId: 'h', required: true, criteria: [{ criterionId: 'ic', text: 'Works', waivable }], flowCriterionIds: ['fc'], criterionMappings: [{ intentCriterionId: 'ic', flowCriterionId: 'fc' }] };
    const i = cmd('intent.create', intentPayload), intentId = i.id as string;
    const optional = includeOptional ? cmd('intent.create', { ...intentPayload, title: 'Optional work', required: false }) : null;
    const fr = cmd('revision.propose', { targetType: 'flow', flowId, problem: 'Problem', expectedOutcome: 'Outcome', scope: 'Scope', outOfScope: 'None', specification: null, criteria: flowCriteria, requiredIntentIds: [intentId] });
    const ir = cmd('revision.propose', { targetType: 'intent', intentId, flowRevisionId: fr.id, deliverable: 'Thing', approach: 'Manual', outOfScope: 'None', criteria: intentPayload.criteria, flowCriterionIds: ['fc'], criterionMappings: intentPayload.criterionMappings });
    const optionalRevision = optional ? cmd('revision.propose', { targetType: 'intent', intentId: optional.id, flowRevisionId: fr.id, deliverable: intentPayload.deliverable, approach: intentPayload.approach, outOfScope: intentPayload.outOfScope, criteria: intentPayload.criteria, flowCriterionIds: intentPayload.flowCriterionIds, criterionMappings: intentPayload.criterionMappings }) : null;
    cmd('requirements.approve', { targetType: 'flow-revision', revisionId: fr.id, revisionDigest: fr.contentDigest, flowRevisionId: fr.id, reason: 'Approve' });
    cmd('requirements.approve', { targetType: 'intent-revision', revisionId: ir.id, revisionDigest: ir.contentDigest, flowRevisionId: fr.id, reason: 'Approve' });
    if (optionalRevision)
        cmd('requirements.approve', { targetType: 'intent-revision', revisionId: optionalRevision.id, revisionDigest: optionalRevision.contentDigest, flowRevisionId: fr.id, reason: 'Approve optional' });
    cmd('flow.start', { flowId, flowRevisionDigest: fr.contentDigest });
    const ctx = cmd('context.create', { flowRevisionId: fr.id, intentRevisionId: ir.id, entries: [], gitBases: [] });
    const a = cmd('attempt.create', { intentRevisionId: ir.id, contextSnapshotId: ctx.id, participantId: 'h', method: 'human', summary: 'Implement', supersedesAttemptId: null });
    cmd('attempt.start', { attemptId: a.id, flowRevisionDigest: fr.contentDigest, intentRevisionDigest: ir.contentDigest, contextDigest: ctx.contentDigest });
    const subject = cmd('subject.create', { attemptId: a.id, artifacts: [{ kind: 'git', repositoryId: 'repo', commitOid: 'a'.repeat(40), treeOid: null, pullRequestNumber: 3 }], report: 'Implemented' });
    const e = cmd('evidence.record', { attemptId: a.id, subjectId: subject.id, subjectDigest: subject.contentDigest, criterionIds: ['ic'], result: evidenceResult, method: 'test', report: 'Pass', outputDigest: 'a'.repeat(64), sourceRunId: null, sourceObservationId: null });
    const sub = cmd('attempt.submit', { attemptId: a.id, subjectId: subject.id, subjectDigest: subject.contentDigest, evidenceIds: [e.id], coverage: [{ criterionId: 'ic', result: evidenceResult, evidenceIds: [e.id] }], knowledgeFollowup: { proposalIds: [], noUpdateReason: 'No updates' } });
    return { state, cmd, flowId, intentId, fr, ir, ctx, a, subject, e, sub, intentPayload, optional, optionalRevision };
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
test('exact human waiver overlays failed evidence but cannot waive an unwaivable mapped Flow criterion', () => {
    const { state, cmd, intentId, a, sub, flowId } = fixture(true, 'fail');
    cmd('attempt.select', { intentId, attemptId: a.id, submissionId: sub.id, submissionDigest: sub.contentDigest, reason: 'Select' });
    const review = { targetType: 'intent-review', targetId: intentId, submissionId: sub.id, submissionDigest: sub.contentDigest, decision: 'accept', reason: 'Review', waivers: [] };
    expect<unknown>(() => cmd('review.decide', review)).toThrow();
    const original = JSON.stringify(state.records.find(r => r.id === sub.id));
    const decision = cmd('review.decide', { ...review, waivers: [{ criterionId: 'ic', reason: 'Explicitly accepted limitation' }] });
    const waiver = state.records.find(r => r.kind === 'decision' && r.targetType === 'criterion-waiver');
    expect<unknown>(waiver && waiver.kind === 'decision' && waiver.targetId).toBe('ic');
    expect<unknown>(waiver && waiver.kind === 'decision' && waiver.targetDigest).toBe(sub.contentDigest);
    expect<unknown>(waiver && waiver.kind === 'decision' && waiver.operationId).toBe(decision.operationId);
    expect<unknown>(JSON.stringify(state.records.find(r => r.id === sub.id))).toBe(original);
    expect<unknown>(() => workRead(state, human, 'p', ['flows', flowId, 'acceptance-preview'], new URL('http://hub'), context)).toThrow('Every Flow criterion');
});
test('unwaivable criteria, stale payload replay, foreign reads and closed submission edits are refused atomically', () => {
    const { state, cmd, intentId, a, sub } = fixture(false, 'fail');
    cmd('attempt.select', { intentId, attemptId: a.id, submissionId: sub.id, submissionDigest: sub.contentDigest, reason: 'Select' });
    const before = JSON.stringify(state);
    expect<unknown>(() => cmd('review.decide', { targetType: 'intent-review', targetId: intentId, submissionId: sub.id, submissionDigest: sub.contentDigest, decision: 'accept', reason: 'Review', waivers: [{ criterionId: 'ic', reason: 'No' }] })).toThrow('Waiver');
    expect<unknown>(() => cmd('subject.create', { attemptId: a.id, artifacts: [{ kind: 'git', repositoryId: 'r', commitOid: 'b'.repeat(40), treeOid: null, pullRequestNumber: null }], report: 'replace' })).toThrow('successor');
    expect<unknown>(() => workRead(state, human, 'q', ['intents', intentId], new URL('http://hub'), context)).toThrow();
    expect<unknown>(() => workRead(state, human, 'p', ['flows', 'foreign', 'intents'], new URL('http://hub'), context)).toThrow();
    expect<unknown>(JSON.stringify(state)).toBe(before);
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
test('idempotent replay returns original receipt and different payload with same operation key is refused', () => {
    const state = createWorkState(), command = { operationId: 'same', command: 'flow.create', expectedVersions: {}, payload: flowPayload };
    const receipt = workCommand(state, human, 'p', command, context), before = JSON.stringify(state);
    expect<unknown>(workCommand(state, human, 'p', command, context)).toEqual(receipt);
    expect<unknown>(() => workCommand(state, human, 'p', { ...command, payload: { ...flowPayload, title: 'Changed' } }, context)).toThrow('Operation ID');
    expect<unknown>(JSON.stringify(state)).toBe(before);
    const revision = state.records.find(r => r.kind === 'flow-revision')!;
    const semantic = Object.fromEntries(Object.entries(revision).filter(([key]) => !['id', 'projectId', 'createdBy', 'createdAt', 'contentDigest'].includes(key)));
    expect<unknown>('contentDigest' in revision && revision.contentDigest).toBe(workDigest(semantic));
});
test('a submission cannot hide failing Evidence from criterion coverage', () => {
    const { state, cmd, ir, ctx, fr } = fixture();
    const a = cmd('attempt.create', { intentRevisionId: ir.id, contextSnapshotId: ctx.id, participantId: 'h', method: 'human', summary: 'Second candidate', supersedesAttemptId: null });
    cmd('attempt.start', { attemptId: a.id, flowRevisionDigest: fr.contentDigest, intentRevisionDigest: ir.contentDigest, contextDigest: ctx.contentDigest });
    const subject = cmd('subject.create', { attemptId: a.id, artifacts: [{ kind: 'git', repositoryId: 'repo', commitOid: 'b'.repeat(40), treeOid: null, pullRequestNumber: null }], report: 'Result' });
    const evidence = { attemptId: a.id, subjectId: subject.id, subjectDigest: subject.contentDigest, criterionIds: ['ic'], method: 'test', report: 'Result', outputDigest: 'a'.repeat(64), sourceRunId: null, sourceObservationId: null };
    const pass = cmd('evidence.record', { ...evidence, result: 'pass' }), fail = cmd('evidence.record', { ...evidence, result: 'fail' });
    const submission = { attemptId: a.id, subjectId: subject.id, subjectDigest: subject.contentDigest, evidenceIds: [pass.id, fail.id], coverage: [{ criterionId: 'ic', result: 'pass', evidenceIds: [pass.id] }], knowledgeFollowup: { proposalIds: [], noUpdateReason: 'None' } };
    const before = JSON.stringify(state);
    expect(() => cmd('attempt.submit', submission)).toThrow('every sealed');
    expect(() => cmd('attempt.submit', { ...submission, evidenceIds: [pass.id] })).toThrow('every recorded');
    expect(JSON.stringify(state)).toBe(before);
});
test('unstarted Attempt cannot bypass context checks through progress reporting', () => {
    const { state, cmd, ir, ctx } = fixture();
    const a = cmd('attempt.create', { intentRevisionId: ir.id, contextSnapshotId: ctx.id, participantId: 'h', method: 'human', summary: 'New candidate', supersedesAttemptId: null });
    const before = JSON.stringify(state);
    expect(() => cmd('attempt.report', { attemptId: a.id, event: 'progress', report: 'Pretend started' })).toThrow('exact');
    expect(() => cmd('attempt.report', { attemptId: a.id, event: 'blocked', report: 'Pretend started' })).toThrow('exact');
    expect(() => cmd('attempt.report', { attemptId: a.id, event: 'cancel-request', report: 'Please cancel' })).toThrow('exact');
    expect(JSON.stringify(state)).toBe(before);
});
test('waived Intent criterion contributes aggregate coverage only when mapped Flow criterion also permits waiver', () => { const { state, cmd, intentId, a, sub, flowId } = fixture(true, 'fail', true); cmd('attempt.select', { intentId, attemptId: a.id, submissionId: sub.id, submissionDigest: sub.contentDigest, reason: 'Select' }); cmd('review.decide', { targetType: 'intent-review', targetId: intentId, submissionId: sub.id, submissionDigest: sub.contentDigest, decision: 'accept', reason: 'Accept exact limitation', waivers: [{ criterionId: 'ic', reason: 'Approved' }] }); expect(() => workRead(state, human, 'p', ['flows', flowId, 'acceptance-preview'], new URL('http://hub'), context)).not.toThrow(); });
test('context creation injects exact approved specification and missing archived content cannot start an Attempt', () => {
    const { state, cmd, flowId, intentId, fr, intentPayload } = fixture();
    const spec = { documentId: 'unavailable-exact-spec', version: 7, contentDigest: 'e'.repeat(64) };
    const nextFlow = cmd('revision.propose', { targetType: 'flow', flowId, problem: 'Problem', expectedOutcome: 'Outcome', scope: 'Scope', outOfScope: 'None', specification: spec, criteria: flowPayload.criteria, requiredIntentIds: [intentId] });
    const nextIntent = cmd('revision.propose', { targetType: 'intent', intentId, flowRevisionId: nextFlow.id, deliverable: 'Thing', approach: 'Manual', outOfScope: 'None', criteria: intentPayload.criteria, flowCriterionIds: ['fc'], criterionMappings: intentPayload.criterionMappings });
    const amendment = cmd('requirements.amend', { flowId, sourceFlowRevisionId: fr.id, affectedIntentIds: [intentId], reason: 'Pin specification', replacements: [{ targetType: 'flow', targetId: flowId, revisionId: nextFlow.id, contentDigest: nextFlow.contentDigest }, { targetType: 'intent', targetId: intentId, revisionId: nextIntent.id, contentDigest: nextIntent.contentDigest }] });
    cmd('requirements.resolve-amendment', { amendmentId: amendment.id, manifestDigest: amendment.contentDigest, decision: 'approve', reason: 'Approve' });
    cmd('flow.start', { flowId, flowRevisionDigest: nextFlow.contentDigest });
    const ctx = cmd('context.create', { flowRevisionId: nextFlow.id, intentRevisionId: nextIntent.id, entries: [], gitBases: [] });
    expect(ctx.entries).toEqual([{ entryId: 'flow-specification', role: 'spec', reference: spec, required: true, contentDigest: spec.contentDigest, resolution: 'unavailable', provenance: 'hub' }]);
    const attempt = cmd('attempt.create', { intentRevisionId: nextIntent.id, contextSnapshotId: ctx.id, participantId: 'h', method: 'human', summary: 'Try exact spec', supersedesAttemptId: null });
    const before = JSON.stringify(state);
    expect(() => cmd('attempt.start', { attemptId: attempt.id, flowRevisionDigest: nextFlow.contentDigest, intentRevisionDigest: nextIntent.contentDigest, contextDigest: ctx.contentDigest })).toThrow('Required context');
    expect(() => cmd('attempt.report', { attemptId: attempt.id, event: 'cancel-request', report: 'Please cancel' })).toThrow('exact');
    expect(() => cmd('attempt.submit', { attemptId: attempt.id, subjectId: 'missing', subjectDigest: 'a'.repeat(64), evidenceIds: [], coverage: [{ criterionId: 'ic', result: 'missing', evidenceIds: [] }], knowledgeFollowup: { proposalIds: [], noUpdateReason: 'None' } })).toThrow('Start Attempt');
    expect(JSON.stringify(state)).toBe(before);
});
function requirementsFixture(required = true, mapped = true, approveIntent = true) {
    const state = createWorkState();
    let op = 0;
    const cmd = (command: string, payload: unknown) => workCommand(state, human, 'p', { operationId: 'start-guard-' + (++op), expectedVersions: Object.fromEntries(state.records.filter(r => 'version' in r).map(r => [r.id, 'version' in r ? r.version : 1])), command, payload }, context).result as Record<string, unknown>;
    const f = cmd('flow.create', flowPayload);
    const intentFields = { deliverable: 'Thing', approach: 'Manual', outOfScope: 'None', criteria: [{ criterionId: 'ic', text: 'Works', waivable: false }], flowCriterionIds: mapped ? ['fc'] : [], criterionMappings: mapped ? [{ intentCriterionId: 'ic', flowCriterionId: 'fc' }] : [] };
    const i = cmd('intent.create', { ...intentFields, flowId: f.id, title: 'Intent', ownerId: 'h', required });
    const fr = cmd('revision.propose', { targetType: 'flow', flowId: f.id, problem: flowPayload.problem, expectedOutcome: flowPayload.expectedOutcome, scope: flowPayload.scope, outOfScope: flowPayload.outOfScope, specification: null, criteria: flowPayload.criteria, requiredIntentIds: required ? [i.id] : [] });
    const ir = cmd('revision.propose', { ...intentFields, targetType: 'intent', intentId: i.id, flowRevisionId: fr.id });
    cmd('requirements.approve', { targetType: 'flow-revision', revisionId: fr.id, revisionDigest: fr.contentDigest, flowRevisionId: fr.id, reason: 'Approve' });
    if (approveIntent)
        cmd('requirements.approve', { targetType: 'intent-revision', revisionId: ir.id, revisionDigest: ir.contentDigest, flowRevisionId: fr.id, reason: 'Approve' });
    return { state, cmd, f, i, fr, ir };
}
for (const scenario of ['no-required', 'unapproved-required', 'unmapped-required'] as const)
    test('Flow start refuses ' + scenario + ' without mutation', () => {
        const { state, cmd, f, fr } = requirementsFixture(scenario !== 'no-required', scenario !== 'unmapped-required', scenario !== 'unapproved-required');
        const before = JSON.stringify(state);
        expect(() => cmd('flow.start', { flowId: f.id, flowRevisionDigest: fr.contentDigest })).toThrow();
        expect(JSON.stringify(state)).toBe(before);
    });
test('approval cannot resurrect a cancelled draft Flow', () => {
    const state = createWorkState();
    const created = workCommand(state, human, 'p', { operationId: 'create-terminal', expectedVersions: {}, command: 'flow.create', payload: flowPayload }, context).result as {
        id: string;
    };
    const revision = state.records.find(r => r.kind === 'flow-revision')!;
    if (revision.kind !== 'flow-revision')
        throw new Error('Missing revision');
    workCommand(state, human, 'p', { operationId: 'cancel-terminal', expectedVersions: { [created.id]: 1 }, command: 'work.cancel', payload: { targetType: 'flow', targetId: created.id, reason: 'Cancel' } }, context);
    const before = JSON.stringify(state);
    expect(() => workCommand(state, human, 'p', { operationId: 'approve-terminal', expectedVersions: { [created.id]: 2 }, command: 'requirements.approve', payload: { targetType: 'flow-revision', revisionId: revision.id, revisionDigest: revision.contentDigest, flowRevisionId: revision.id, reason: 'Late approval' } }, context)).toThrow();
    expect(JSON.stringify(state)).toBe(before);
});
for (const requiredResult of ['pass', 'fail'] as const)
    test('optional accepted Intent cannot replace required aggregate coverage: ' + requiredResult, () => {
        const { state, cmd, flowId, intentId, a, sub, fr, optional, optionalRevision } = fixture(true, requiredResult, false, true);
        if (!optional || !optionalRevision)
            throw new Error('Missing optional requirements');
        const ctx = cmd('context.create', { flowRevisionId: fr.id, intentRevisionId: optionalRevision.id, entries: [], gitBases: [] });
        const candidate = cmd('attempt.create', { intentRevisionId: optionalRevision.id, contextSnapshotId: ctx.id, participantId: 'h', method: 'human', summary: 'Optional result', supersedesAttemptId: null });
        cmd('attempt.start', { attemptId: candidate.id, flowRevisionDigest: fr.contentDigest, intentRevisionDigest: optionalRevision.contentDigest, contextDigest: ctx.contentDigest });
        const subject = cmd('subject.create', { attemptId: candidate.id, artifacts: [{ kind: 'git', repositoryId: 'repo', commitOid: 'c'.repeat(40), treeOid: null, pullRequestNumber: null }], report: 'Optional pass' });
        const evidence = cmd('evidence.record', { attemptId: candidate.id, subjectId: subject.id, subjectDigest: subject.contentDigest, criterionIds: ['ic'], result: 'pass', method: 'test', report: 'Passed', outputDigest: 'a'.repeat(64), sourceRunId: null, sourceObservationId: null });
        const submission = cmd('attempt.submit', { attemptId: candidate.id, subjectId: subject.id, subjectDigest: subject.contentDigest, evidenceIds: [evidence.id], coverage: [{ criterionId: 'ic', result: 'pass', evidenceIds: [evidence.id] }], knowledgeFollowup: { proposalIds: [], noUpdateReason: 'None' } });
        cmd('attempt.select', { intentId: optional.id, attemptId: candidate.id, submissionId: submission.id, submissionDigest: submission.contentDigest, reason: 'Select optional' });
        cmd('review.decide', { targetType: 'intent-review', targetId: optional.id, submissionId: submission.id, submissionDigest: submission.contentDigest, decision: 'accept', reason: 'Optional accepted', waivers: [] });
        expect(() => workRead(state, human, 'p', ['flows', flowId, 'acceptance-preview'], new URL('http://hub'), context)).toThrow('Required Intent');
        cmd('attempt.select', { intentId, attemptId: a.id, submissionId: sub.id, submissionDigest: sub.contentDigest, reason: 'Select required' });
        cmd('review.decide', { targetType: 'intent-review', targetId: intentId, submissionId: sub.id, submissionDigest: sub.contentDigest, decision: 'accept', reason: 'Accept required', waivers: requiredResult === 'fail' ? [{ criterionId: 'ic', reason: 'Exact Intent limitation' }] : [] });
        if (requiredResult === 'fail')
            expect(() => workRead(state, human, 'p', ['flows', flowId, 'acceptance-preview'], new URL('http://hub'), context)).toThrow('Every Flow criterion');
        else {
            const preview = workRead(state, human, 'p', ['flows', flowId, 'acceptance-preview'], new URL('http://hub'), context) as {
                acceptedIntents: {
                    intentId: string;
                }[];
                criterionCoverage: {
                    intentId: string;
                }[];
            };
            expect(preview.acceptedIntents.map(i => i.intentId)).toEqual([intentId as string]);
            expect(preview.criterionCoverage.every(c => c.intentId === intentId)).toBe(true);
        }
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
