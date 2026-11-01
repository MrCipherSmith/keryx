import { Database } from 'bun:sqlite';
import { migrateRemote } from '../remote-v2/storage';
import { migrateWork, workRepository } from './storage';
import { expect, test } from 'bun:test';
import { createWorkState, workCommand, workRead } from './domain';
import type { Principal } from '../contracts';
import type { HubState } from '../store';
const human: Principal = { id: 'h', kind: 'human', role: 'operator' };
const context = { verifySubjectForAcceptance: () => { }, resolveRepository: (projectId: string, id: string) => id === 'repo' ? { id, projectId, objectFormat: 'sha1' as const } : undefined, legacy: { projects: [{ id: 'p', name: 'P', version: 1, lineRevisionId: null, lineVersion: 1, contextRevision: 0 }], documents: [], proposals: [], flows: [], evidence: [], revisions: [], deliveries: [], events: [], documentChanges: [], sessions: {}, replays: {} } as HubState, now: () => '2026-11-01T00:00:00Z' };
const flowPayload = { title: 'Work', problem: 'Problem', expectedOutcome: 'Outcome', scope: 'Scope', outOfScope: 'None', ownerId: 'h', specification: null, criteria: [{ criterionId: 'fc', text: 'Works', waivable: false }] };
function fixture(waivable = false, evidenceResult: 'pass' | 'fail' | 'inconclusive' = 'pass', flowWaivable = false, includeOptional = false) {
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
test('indexed storage full manual lifecycle seals exact evidence, requires human selection, and accepts aggregate', () => {
    const { db, state, cmd, flowId, intentId, fr, ir, ctx, a, subject, sub } = fixture();
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
    db.close();
});
test('indexed attention retains late contradictory Evidence and only current exact acceptance controls recovery', () => {
    const { db, repository, cmd, intentId, a, subject, sub } = fixture();
    cmd('attempt.select', { intentId, attemptId: a.id, submissionId: sub.id, submissionDigest: sub.contentDigest, reason: 'Choose' });
    cmd('review.decide', { targetType: 'intent-review', targetId: intentId, submissionId: sub.id, submissionDigest: sub.contentDigest, decision: 'accept', reason: 'Review', waivers: [] });
    const late = cmd('evidence.record', { attemptId: a.id, subjectId: subject.id, subjectDigest: subject.contentDigest, criterionIds: ['ic'], result: 'fail', method: 'late-test', report: 'Regression', outputDigest: 'b'.repeat(64), sourceRunId: null, sourceObservationId: null });
    const url = new URL('http://hub');
    const scoped = repository.readState('p', ['attention'], url);
    const attention = workRead(scoped, human, 'p', ['attention'], url) as { records: { id: string }[] };
    expect(attention.records.map(record => record.id)).toContain(String(late.id));
    expect(db.query('SELECT evidence_id FROM hub_work_incidents').all()).toEqual([{ evidence_id: late.id }]);
    db.close();
});
test('actual progress command touches one Attempt without reading thousands of cold siblings or their history', () => {
    const { db, repository, cmd, state, ir, fr, ctx, a, sub } = fixture();
    cmd('attempt.withdraw', { attemptId: a.id, submissionId: sub.id, submissionDigest: sub.contentDigest, reason: 'Successor' });
    const active = cmd('attempt.create', { intentRevisionId: ir.id, contextSnapshotId: ctx.id, participantId: 'h', method: 'human', summary: 'Active', supersedesAttemptId: a.id });
    cmd('attempt.start', { attemptId: active.id, flowRevisionDigest: fr.contentDigest, intentRevisionDigest: ir.contentDigest, contextDigest: ctx.contentDigest });
    const original = state.records.find(record => record.id === a.id)!;
    const lastSequence = repository.currentSequence('p');
    const sampleEvent = repository.load('p').events[0]!;
    repository.save('p', {
        records: Array.from({ length: 2500 }, (_, n) => ({ ...original, id: 'cold-' + n, summary: 'cold-history-marker' })),
        events: Array.from({ length: 2500 }, (_, n) => ({ ...sampleEvent, sequence: lastSequence + n + 1 })), operations: {},
    });
    db.exec('CREATE TABLE progress_updates(id TEXT); CREATE TRIGGER progress_update AFTER UPDATE ON hub_work_records BEGIN INSERT INTO progress_updates VALUES(new.id); END;');
    const current = repository.record('p',String(active.id));
    const input = { operationId: 'bounded-progress', command: 'attempt.report', expectedVersions: { [String(active.id)]: current && 'version' in current ? current.version : 0 }, payload: { attemptId: active.id, event: 'progress', report: 'Progress' } };
    const parse = JSON.parse;
    JSON.parse = ((text: string, ...args: Parameters<typeof JSON.parse> extends [string, ...infer R] ? R : never) => {
        if (text.includes('cold-history-marker')) throw Error('Parsed cold sibling history');
        return parse(text, ...args);
    }) as typeof JSON.parse;
    try {
        const scoped = repository.commandState('p', input, human.id);
        expect(scoped.records.length).toBeLessThan(15);
        expect(scoped.events).toHaveLength(0);
        workCommand(scoped, human, 'p', input, context);
        repository.save('p', scoped);
        expect(db.query('SELECT id FROM progress_updates').all()).toEqual([{ id: active.id }]);
    } finally { JSON.parse = parse; db.close(); }
});
