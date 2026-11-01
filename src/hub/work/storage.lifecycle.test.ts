import { expect, test } from 'bun:test';
import { workCommand, workRead } from './domain';
import { scopedFixture as fixture, context, human } from './storage.fixture.test-support';
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
