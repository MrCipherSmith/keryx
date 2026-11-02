import { Database } from 'bun:sqlite';
import { migrateRemote } from '../remote-v2/storage';
import { migrateWork, workRepository } from './storage';
import { createWorkState, workCommand } from './domain';
import type { Principal } from '../contracts';
import type { HubState } from '../store';
export const human: Principal = { id: 'h', kind: 'human', role: 'operator' };
export const context = { verifySubjectForAcceptance: () => { }, resolveRepository: (projectId: string, id: string) => id === 'repo' ? { id, projectId, objectFormat: 'sha1' as const } : undefined, legacy: { projects: [{ id: 'p', name: 'P', version: 1, lineRevisionId: null, lineVersion: 1, contextRevision: 0 }], documents: [], proposals: [], flows: [], evidence: [], revisions: [], deliveries: [], events: [], documentChanges: [], sessions: {}, replays: {} } as HubState, now: () => '2026-11-01T00:00:00Z' };
export const flowPayload = { title: 'Work', problem: 'Problem', expectedOutcome: 'Outcome', scope: 'Scope', outOfScope: 'None', ownerId: 'h', specification: null, criteria: [{ criterionId: 'fc', text: 'Works', waivable: false }] };
export function scopedFixture(waivable = false, evidenceResult: 'pass' | 'fail' | 'inconclusive' = 'pass', flowWaivable = false, includeOptional = false) {
    const state = createWorkState();
    const db = new Database(':memory:');
    db.exec('CREATE TABLE hub_state(id INTEGER PRIMARY KEY,body TEXT NOT NULL)');
    migrateRemote(db); migrateWork(db);
    const repository = workRepository(db);
    let op = 0;
    const cmd = (command: string, payload: unknown, actor = human) => {
        const input = { operationId: 'op' + (++op), expectedVersions: Object.fromEntries(state.records.filter(r => 'version' in r).map(r => [r.id, 'version' in r ? r.version : 1])), command, payload };
        const scoped = repository.commandState('p', input, actor.id);
        const result = workCommand(scoped, actor, 'p', input, { ...context, nextRevisionNumber: (kind, id) => repository.nextRevisionNumber('p',kind,id) }).result as Record<string, unknown>;
        repository.save('p', scoped);
        state.records = repository.load('p').records;
        return result;
    };
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
    return { db, repository, state, cmd, flowId, intentId, fr, ir, ctx, a, subject, e, sub, intentPayload, optional, optionalRevision };
}
