import { expect, test } from 'bun:test';
import type { Principal } from '../contracts';
import { scopedFixture } from './storage.fixture.test-support';

const contributors: Principal[] = [
    { id: 'other-human', kind: 'human', role: 'operator' },
    { id: 'bot', kind: 'agent', role: 'agent' },
    { id: 'h', kind: 'agent', role: 'agent' },
];
for (const command of ['attempt.start', 'attempt.report', 'subject.create', 'evidence.record', 'attempt.submit', 'attempt.withdraw']) {
    for (const actor of contributors) test(`${command} requires the authenticated Attempt participant and human method (${actor.id}/${actor.kind})`, () => {
        const f = scopedFixture();
        try {
            const a = f.cmd('attempt.create', { intentRevisionId: f.ir.id, contextSnapshotId: f.ctx.id, participantId: 'h', method: 'human', summary: 'Owned work', supersedesAttemptId: null });
            const start = { attemptId: a.id, flowRevisionDigest: f.fr.contentDigest, intentRevisionDigest: f.ir.contentDigest, contextDigest: f.ctx.contentDigest };
            let payload: unknown = start;
            if (command !== 'attempt.start') {
                f.cmd('attempt.start', start);
                payload = { attemptId: a.id, event: 'failed', report: 'Cannot impersonate participant' };
                if (command === 'subject.create') payload = { attemptId: a.id, artifacts: [{ kind: 'git', repositoryId: 'repo', commitOid: 'b'.repeat(40), treeOid: null, pullRequestNumber: null }], report: 'Owned output' };
                if (['evidence.record', 'attempt.submit', 'attempt.withdraw'].includes(command)) {
                    const subject = f.cmd('subject.create', { attemptId: a.id, artifacts: [{ kind: 'git', repositoryId: 'repo', commitOid: 'a'.repeat(40), treeOid: null, pullRequestNumber: null }], report: 'Owned output' });
                    const evidencePayload = { attemptId: a.id, subjectId: subject.id, subjectDigest: subject.contentDigest, criterionIds: ['ic'], result: 'pass', method: 'test', report: 'Pass', outputDigest: 'a'.repeat(64), sourceRunId: null, sourceObservationId: null };
                    payload = evidencePayload;
                    if (command !== 'evidence.record') {
                        const e = f.cmd('evidence.record', evidencePayload);
                        payload = { attemptId: a.id, subjectId: subject.id, subjectDigest: subject.contentDigest, evidenceIds: [e.id], coverage: [{ criterionId: 'ic', result: 'pass', evidenceIds: [e.id] }], knowledgeFollowup: { proposalIds: [], noUpdateReason: 'None' } };
                        if (command === 'attempt.withdraw') {
                            const submission = f.cmd('attempt.submit', payload);
                            payload = { attemptId: a.id, submissionId: submission.id, submissionDigest: submission.contentDigest, reason: 'Not mine to withdraw' };
                        }
                    }
                }
            }
            const before = JSON.stringify(f.repository.load('p'));
            let error: unknown;
            try { f.cmd(command, payload, actor); } catch (caught) { error = caught; }
            expect(error).toMatchObject({ status: 403, code: actor.id === 'h' ? 'method-mismatch' : 'participant-mismatch' });
            expect(JSON.stringify(f.repository.load('p'))).toBe(before);
        } finally { f.db.close(); }
    });
}
