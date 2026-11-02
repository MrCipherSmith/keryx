import { afterEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { HubStore } from '../store';
import { createWorkHttp } from './http';
import { createWorkClient } from './client';
import { human, scopedFixture } from './storage.fixture.test-support';

const databases: Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

/** The production read handler over the scoped repository, reached through the published client validators. */
function served() {
    const fixture = scopedFixture(); databases.push(fixture.db);
    const { cmd, intentId, a, subject, sub } = fixture;
    cmd('attempt.select', { intentId, attemptId: a.id, submissionId: sub.id, submissionDigest: sub.contentDigest, reason: 'Select' });
    cmd('review.decide', { targetType: 'intent-review', targetId: intentId, submissionId: sub.id, submissionDigest: sub.contentDigest, decision: 'accept', reason: 'Accept', waivers: [] });
    const late = cmd('evidence.record', { attemptId: a.id, subjectId: subject.id, subjectDigest: subject.contentDigest, criterionIds: ['ic'], result: 'fail', method: 'late check', report: 'Contradiction', outputDigest: 'e'.repeat(64), sourceRunId: null, sourceObservationId: null });
    const store = { work: fixture.repository, project: (id: string) => id === 'p' ? { id } : undefined } as unknown as HubStore;
    const http = createWorkHttp({ store, enabled: true, authenticate: async () => ({ actor: human, cookie: false }), checkOrigin: () => { }, serialized: operation => operation(), now: () => Date.parse('2026-11-01T00:00:00Z') });
    const fetch = async (request: Request) => (await http.handle(request)) ?? new Response(null, { status: 404 });
    return { ...fixture, late, fetch, client: createWorkClient({ baseUrl: 'http://localhost/', fetch }) };
}
const ids = (value: unknown) => (value as { records: { id: string }[] }).records.map(r => r.id);

test('served Flow and Intent aggregates include post-acceptance incident Evidence', async () => {
    const { client, flowId, intentId, late } = served();
    expect(ids(await client.read('get_flow', 'p', { flowId }))).toContain(late.id as string);
    expect(ids(await client.read('get_intent', 'p', { intentId }))).toContain(late.id as string);
});
