import { expect, test } from 'bun:test';
import { hubRead } from './domain';
import type { CodeRevision } from './contracts';
import type { HubState } from './store';

test('revision metadata projection omits file bytes and keeps full immutable reads compatible', () => {
  const revision: CodeRevision = { id: 'r', projectId: 'p', baseRevisionId: null, gitBaseSha: 'a'.repeat(40), message: 'Candidate', files: [{ path: 'secret.txt', contentBase64: 'c2VjcmV0', contentDigest: 'digest', mode: '100644' }], createdBy: 'agent', createdAt: 'now', treeDigest: 'tree', purpose: 'review-bundle' };
  const state: HubState = { projects: [{ id: 'p', name: 'P', version: 1, lineRevisionId: null, lineVersion: 0, contextRevision: 0 }], revisions: [revision], documents: [], proposals: [], flows: [], evidence: [], deliveries: [], events: [], documentChanges: [], sessions: {}, replays: {} };
  const before = structuredClone(state);
  const summary = hubRead(state, ['projects', 'p', 'revisions'], new URL('http://hub.test?summary=1'));
  const { files, ...metadata } = revision;
  expect(summary).toEqual({ revisions: [{ ...metadata, fileCount: files.length }] });
  expect(JSON.stringify(summary)).not.toContain('contentBase64');
  expect(hubRead(state, ['projects', 'p', 'revisions'], new URL('http://hub.test'))).toEqual({ revisions: [revision] });
  expect(hubRead(state, ['projects', 'p', 'revisions', 'r'], new URL('http://hub.test?summary=1'))).toEqual(revision);
  expect(state).toEqual(before);
});

test('HTTP summary collection preserves hashes and purpose while full GET remains available', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHubApplication } = await import('./server');
  const dir = mkdtempSync(join(tmpdir(), 'hub-summary-'));
  const token = 'operator-' + 'a'.repeat(64);
  const app = createHubApplication({ dataDir: dir, operatorToken: token, agentToken: 'agent-' + 'b'.repeat(64) });
  async function request(path: string, body?: unknown) {
    const response = await app.fetch(new Request(`http://hub.test/hub/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    expect(response.status).toBeLessThan(300);
    return response.json();
  }
  try {
    const project = await request('/projects', { name: 'Projection' }) as { id: string };
    const path = `/projects/${project.id}/revisions`;
    const revision = await request(path, { baseRevisionId: null, gitBaseSha: 'a'.repeat(40), message: 'Bundle', purpose: 'review-bundle', changes: [{ path: 'bundle.patch', contentBase64: Buffer.from('private bytes').toString('base64') }] }) as CodeRevision;
    const { files, ...metadata } = revision;
    const summary = await request(`${path}?summary=1`);
    expect(summary).toEqual({ revisions: [{ ...metadata, fileCount: 1 }] });
    expect(JSON.stringify(summary)).not.toContain(files[0]!.contentBase64);
    expect(await request(`${path}/${revision.id}`)).toEqual(revision);
    expect(await request(path)).toEqual({ revisions: [revision] });
  } finally { app.close(); rmSync(dir, { recursive: true, force: true }); }
});
