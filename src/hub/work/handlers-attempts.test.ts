import { afterEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { Principal } from '../contracts';
import { HubFailure } from '../domain';
import { scopedFixture } from './storage.fixture.test-support';

const databases: Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
const colleague: Principal = { id: 'h2', kind: 'human', role: 'operator' };
const agent: Principal = { id: 'bot', kind: 'agent', role: 'agent' };

/** A fresh draft Attempt owned by participant 'h', advanced to the stage a command needs. */
function attemptAt(stage: 'draft' | 'running' | 'subject' | 'evidence' | 'submitted') {
    const fixture = scopedFixture(); databases.push(fixture.db);
    const { cmd, fr, ir, ctx, a, sub } = fixture;
    cmd('attempt.withdraw', { attemptId: a.id, submissionId: sub.id, submissionDigest: sub.contentDigest, reason: 'Retry' });
    const b = cmd('attempt.create', { intentRevisionId: ir.id, contextSnapshotId: ctx.id, participantId: 'h', method: 'human', summary: 'Second', supersedesAttemptId: null });
    const order = ['draft', 'running', 'subject', 'evidence', 'submitted'];
    const reach = (step: string) => order.indexOf(stage) >= order.indexOf(step);
    if (reach('running')) cmd('attempt.start', { attemptId: b.id, flowRevisionDigest: fr.contentDigest, intentRevisionDigest: ir.contentDigest, contextDigest: ctx.contentDigest });
    const subject = reach('subject') ? cmd('subject.create', { attemptId: b.id, artifacts: [{ kind: 'git', repositoryId: 'repo', commitOid: 'c'.repeat(40), treeOid: null, pullRequestNumber: null }], report: 'Done' }) : undefined;
    const evidence = reach('evidence') && subject ? cmd('evidence.record', { attemptId: b.id, subjectId: subject.id, subjectDigest: subject.contentDigest, criterionIds: ['ic'], result: 'pass', method: 'test', report: 'Pass', outputDigest: 'c'.repeat(64), sourceRunId: null, sourceObservationId: null }) : undefined;
    const submission = reach('submitted') && subject && evidence ? cmd('attempt.submit', { attemptId: b.id, subjectId: subject.id, subjectDigest: subject.contentDigest, evidenceIds: [evidence.id], coverage: [{ criterionId: 'ic', result: 'pass', evidenceIds: [evidence.id] }], knowledgeFollowup: { proposalIds: [], noUpdateReason: 'None' } }) : undefined;
    return { ...fixture, b, subject, evidence, submission };
}
function refusal(run: () => unknown) {
    try { run(); } catch (error) { if (error instanceof HubFailure) return { status: error.status, code: error.code }; throw error; }
    return 'accepted';
}

const cases: [string, 'draft' | 'running' | 'subject' | 'evidence', (f: ReturnType<typeof attemptAt>) => [string, unknown]][] = [
    ['attempt.start', 'draft', f => ['attempt.start', { attemptId: f.b.id, flowRevisionDigest: f.fr.contentDigest, intentRevisionDigest: f.ir.contentDigest, contextDigest: f.ctx.contentDigest }]],
    ['attempt.report', 'running', f => ['attempt.report', { attemptId: f.b.id, event: 'progress', report: 'Working' }]],
    ['subject.create', 'running', f => ['subject.create', { attemptId: f.b.id, artifacts: [{ kind: 'git', repositoryId: 'repo', commitOid: 'd'.repeat(40), treeOid: null, pullRequestNumber: null }], report: 'Result' }]],
    ['evidence.record', 'subject', f => ['evidence.record', { attemptId: f.b.id, subjectId: f.subject!.id, subjectDigest: f.subject!.contentDigest, criterionIds: ['ic'], result: 'fail', method: 'test', report: 'Fail', outputDigest: 'd'.repeat(64), sourceRunId: null, sourceObservationId: null }]],
    ['attempt.submit', 'evidence', f => ['attempt.submit', { attemptId: f.b.id, subjectId: f.subject!.id, subjectDigest: f.subject!.contentDigest, evidenceIds: [f.evidence!.id], coverage: [{ criterionId: 'ic', result: 'pass', evidenceIds: [f.evidence!.id] }], knowledgeFollowup: { proposalIds: [], noUpdateReason: 'None' } }]],
];
for (const [name, stage, build] of cases)
    test(`${name} refuses a non-participant and admits the Attempt participant`, () => {
        const f = attemptAt(stage), [command, payload] = build(f);
        const before = JSON.stringify(f.state);
        for (const actor of [colleague, agent]) expect(refusal(() => f.cmd(command, payload, actor))).toEqual({ status: 403, code: 'participant-mismatch' });
        expect(JSON.stringify(f.state)).toBe(before);
        expect(refusal(() => f.cmd(command, payload))).toBe('accepted');
    });
test('attempt.withdraw refuses a non-participant and admits the Attempt participant', () => {
    const f = attemptAt('submitted'), payload = { attemptId: f.b.id, submissionId: f.submission!.id, submissionDigest: f.submission!.contentDigest, reason: 'Withdraw' };
    const before = JSON.stringify(f.state);
    for (const actor of [colleague, agent]) expect(refusal(() => f.cmd('attempt.withdraw', payload, actor))).toEqual({ status: 403, code: 'participant-mismatch' });
    expect(JSON.stringify(f.state)).toBe(before);
    expect(refusal(() => f.cmd('attempt.withdraw', payload))).toBe('accepted');
});
