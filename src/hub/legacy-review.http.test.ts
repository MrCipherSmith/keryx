// Frozen acceptance spec v0.1.1: real authenticated HTTP and durable SQLite, no domain mocks.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodeRevision, Evidence, HubApplication, HubConfig, HubFlow, ImportResponse, Project } from './contracts';
import { createHubApplication } from './server';
import { legacyReviewOpenApi } from './legacy-review-contract';

const operator = 'review-operator-' + 'a'.repeat(64);
const reviewer = 'review-human-' + 'b'.repeat(64);
const agent = 'review-agent-' + 'c'.repeat(64);
type Ref = { specContentDigest: string; position: number };
type Decision = { id: string; flowId: string; subjectRevisionId: string; specContentDigest: string; comment: string; criterionRefs: Ref[]; actorId: string; actorKind: 'human'; createdAt: string };
type FeedbackFlow = HubFlow & { reviewFeedback: Decision | null; lastReturnDecisionId?: string };
type ReviewReceipt = { status: 'committed'; operationId: string; flowVersion: number; flowState: 'in-progress'; decision: Decision };
let dir: string, config: HubConfig, app: HubApplication;

async function request(path: string, body?: unknown, token = operator, key: string = randomUUID()) {
  return app.fetch(new Request('http://hub.test/hub/v1' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'idempotency-key': key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}
async function success<T>(response: Response): Promise<T> {
  const body: unknown = await response.json();
  expect({ status: response.status, body }).toMatchObject({ status: 200 });
  return body as T;
}
const flowPath = (p: Project, f: HubFlow) => `/projects/${p.id}/flows/${f.id}`;
async function revision(p: Project, message = 'initial') {
  return success<CodeRevision>(await request(`/projects/${p.id}/revisions`, {
    baseRevisionId: null, gitBaseSha: 'a'.repeat(40), message,
    changes: [{ path: 'src/result.txt', contentBase64: Buffer.from(message).toString('base64') }],
  }, agent));
}
async function evidence(p: Project, f: HubFlow, r: CodeRevision) {
  return success<Evidence>(await request(flowPath(p, f) + '/evidence', {
    subjectRevisionId: r.id, checkId: 'check', command: 'bun test', exitCode: 0, output: '1 pass',
  }, agent));
}
async function fixture(submit = true) {
  const p = await success<Project>(await request('/projects', { name: 'Legacy review' }));
  const imported = await success<ImportResponse>(await request(`/projects/${p.id}/import`, {
    expectedVersion: p.version, sourceRevision: 'fixture', documents: [{ path: 'specs/result.md', kind: 'spec', content: '# Result\nExact review.' }],
  }, agent));
  let f = await success<FeedbackFlow>(await request(`/projects/${p.id}/flows`, {
    title: 'Review this result', specDocumentId: imported.documents[0]!.id, criteria: ['Expected result', 'No regression'],
  }, agent));
  f = await success<FeedbackFlow>(await request(flowPath(p, f) + '/freeze', { expectedVersion: f.version }));
  f = await success<FeedbackFlow>(await request(flowPath(p, f) + '/start', { expectedVersion: f.version }, agent));
  const r = await revision(p), e = await evidence(p, f, r);
  if (submit) f = await success<FeedbackFlow>(await request(flowPath(p, f) + '/submit-for-review', { expectedVersion: f.version, subjectRevisionId: r.id }, agent));
  const body = { expectedVersion: f.version, subjectRevisionId: r.id, comment: '  The second criterion still fails.  ', criterionRefs: [{ specContentDigest: f.specContentDigest, position: 2 }] };
  return { p, f, r, e, body, path: flowPath(p, f) };
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-commented-review-'));
  config = { dataDir: dir, operatorToken: operator, reviewerToken: reviewer, agentToken: agent };
  app = createHubApplication(config);
});
afterEach(() => { app.close(); rmSync(dir, { recursive: true, force: true }); });

describe('legacy commented return HTTP contract', () => {
  test('returns exact candidate with a durable human receipt, contributor feedback and immutable artifacts', async () => {
    const { p, f, r, e, body, path } = await fixture(), key = 'return-once';
    const beforeEvents = await success<{ events: unknown[] }>(await request(`/projects/${p.id}/events`));
    const receipt = await success<ReviewReceipt>(await request(path + '/request-changes', body, reviewer, key));
    expect(receipt).toMatchObject({ status: 'committed', operationId: key, flowVersion: f.version + 1, flowState: 'in-progress', decision: {
      flowId: f.id, subjectRevisionId: r.id, specContentDigest: f.specContentDigest, comment: body.comment.trim(), criterionRefs: body.criterionRefs, actorKind: 'human',
    } });
    expect(Object.keys(receipt).sort()).toEqual(Object.keys(legacyReviewOpenApi.components.schemas.receipt.properties).sort());
    expect(Object.keys(receipt.decision).sort()).toEqual(Object.keys(legacyReviewOpenApi.components.schemas.ReviewDecision.properties).sort());
    expect(receipt.decision.id).toBeTruthy(); expect(receipt.decision.actorId).toBeTruthy();
    expect(Number.isNaN(Date.parse(receipt.decision.createdAt))).toBe(false);
    app.close(); app = createHubApplication(config);
    const current = await success<FeedbackFlow>(await request(path, undefined, agent));
    expect(current).toMatchObject({ status: 'in-progress', subjectRevisionId: null, version: receipt.flowVersion, lastReturnDecisionId: receipt.decision.id, reviewFeedback: receipt.decision });
    const list = await success<{ flows: FeedbackFlow[] }>(await request(`/projects/${p.id}/flows`, undefined, agent));
    expect(list.flows.find(flow => flow.id === f.id)?.reviewFeedback).toEqual(receipt.decision);
    expect(await success<CodeRevision>(await request(`/projects/${p.id}/revisions/${r.id}`))).toEqual(r);
    expect((await success<{ evidence: Evidence[] }>(await request(path + '/evidence'))).evidence).toEqual([e]);
    const afterEvents = await success<{ events: { entityId: string }[] }>(await request(`/projects/${p.id}/events`));
    expect(afterEvents.events.length).toBe(beforeEvents.events.length + 1);
    expect(afterEvents.events.at(-1)?.entityId).toBe(f.id);
  });

  test('recovers a lost response by actor-bound lookup and exact retry even after resubmission', async () => {
    const { p, f, body, path } = await fixture(), key = 'lost-response';
    // Treat the first response as lost to the caller; recover through the documented lookup.
    expect((await request(path + '/request-changes', body, reviewer, key)).status).toBe(200);
    const receipt = await success<ReviewReceipt>(await request(path + '/review-operations/' + key, undefined, reviewer));
    const next = await revision(p, 'fixed'); await evidence(p, f, next);
    await success<FeedbackFlow>(await request(path + '/submit-for-review', { expectedVersion: receipt.flowVersion, subjectRevisionId: next.id, afterReturnDecisionId: receipt.decision.id }, agent));
    app.close(); app = createHubApplication(config);
    expect(await success<ReviewReceipt>(await request(path + '/request-changes', body, reviewer, key))).toEqual(receipt);
    expect(await success<ReviewReceipt>(await request(path + '/review-operations/' + key, undefined, reviewer))).toEqual(receipt);
    expect((await request(path + '/request-changes', { ...body, comment: 'changed payload' }, reviewer, key)).status).toBe(409);
    expect([403, 404]).toContain((await request(path + '/review-operations/' + key)).status);
    expect((await request(path + '/review-operations/' + key, undefined, agent)).status).toBe(403);
    const unknown = await request(path + '/review-operations/missing-key', undefined, reviewer);
    expect(unknown.status).toBe(404); expect(await unknown.json()).toMatchObject({ error: { code: 'operation-not-found' } });
  });

  test('permits empty criterion refs and a 4000-character comment at the documented boundary', async () => {
    const { body, path } = await fixture();
    const result = await success<ReviewReceipt>(await request(path + '/request-changes', { ...body, comment: 'x'.repeat(4000), criterionRefs: [] }));
    expect(result.decision.comment).toHaveLength(4000); expect(result.decision.criterionRefs).toEqual([]);
  });

  for (const [name, patch, code] of [
    ['blank comment', { comment: ' \n\t ' }, 'invalid-comment'],
    ['oversized comment', { comment: 'x'.repeat(4001) }, 'invalid-comment'],
    ['wrong pinned digest', { criterionRefs: [{ specContentDigest: 'f'.repeat(64), position: 1 }] }, 'invalid-criterion-ref'],
    ['out-of-range criterion', { criterionRefs: [{ position: 3 }] }, 'invalid-criterion-ref'],
    ['duplicate criterion', { criterionRefs: [{ position: 1 }, { position: 1 }] }, 'invalid-criterion-ref'],
    ['forged actor', { actorId: 'forged' }, 'invalid-request'],
  ] as const) test('rejects ' + name + ' without changing Flow, events or receipt history', async () => {
    const { p, f, body, path } = await fixture();
    const adjusted = { ...body, ...patch };
    if ('criterionRefs' in patch) adjusted.criterionRefs = patch.criterionRefs.map(ref => ({ specContentDigest: f.specContentDigest, ...ref }));
    const events = await success<unknown>(await request(`/projects/${p.id}/events`));
    const response = await request(path + '/request-changes', adjusted, reviewer, 'rejected');
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { code } });
    expect((await success<HubFlow>(await request(path))).version).toBe(f.version);
    expect(await success<unknown>(await request(`/projects/${p.id}/events`))).toEqual(events);
    expect((await request(path + '/review-operations/rejected', undefined, reviewer)).status).toBe(404);
  });

  test('refuses agents, stale versions, wrong subjects and cross-project lookup before mutation', async () => {
    const { p, f, body, path } = await fixture();
    expect((await request(path + '/request-changes', body, agent)).status).toBe(403);
    const stale = await request(path + '/request-changes', { ...body, expectedVersion: f.version - 1 });
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ error: { code: 'stale-version' } });
    const different = await revision(p, 'other result');
    const mismatch = await request(path + '/request-changes', { ...body, subjectRevisionId: different.id });
    expect(mismatch.status).toBe(409); expect(await mismatch.json()).toMatchObject({ error: { code: 'subject-changed' } });
    const other = await success<Project>(await request('/projects', { name: 'Outside' }));
    expect((await request(`/projects/${other.id}/flows/${f.id}/request-changes`, body)).status).toBe(404);
    expect((await success<HubFlow>(await request(path))).version).toBe(f.version);
  });

  test('rechecks revoked reviewer credentials before returning a committed receipt', async () => {
    const { body, path } = await fixture(), key = 'revoke-after-return';
    await success<ReviewReceipt>(await request(path + '/request-changes', body, reviewer, key));
    config.reviewerToken = 'rotated-reviewer-' + 'd'.repeat(64);
    expect((await request(path + '/review-operations/' + key, undefined, reviewer)).status).toBe(401);
    expect((await request(path + '/request-changes', body, reviewer, key)).status).toBe(401);
  });

  test('a concurrent accept and return cannot both commit and neither rewrites the winning result', async () => {
    const { f, r, body, path } = await fixture();
    const responses = await Promise.all([
      request(path + '/accept', { expectedVersion: f.version, subjectRevisionId: r.id, acknowledgeSelfReportedEvidence: true }),
      request(path + '/request-changes', body, reviewer),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const current = await success<FeedbackFlow>(await request(path));
    expect(current.version).toBe(f.version + 1);
    if (responses[0]!.status === 200) { expect(current.status).toBe('done'); expect(current.reviewFeedback).toBeNull(); }
    else { expect(current.status).toBe('in-progress'); expect(current.reviewFeedback?.subjectRevisionId).toBe(r.id); }
  });

  test('requires last return ID and a new immutable candidate, then preserves old decisions after resubmission', async () => {
    const { p, f, r, body, path } = await fixture();
    const receipt = await success<ReviewReceipt>(await request(path + '/request-changes', body, reviewer, 'history'));
    const next = await revision(p, 'fixed revision'); await evidence(p, f, next);
    const base = { expectedVersion: receipt.flowVersion, subjectRevisionId: next.id };
    for (const payload of [base, { ...base, afterReturnDecisionId: 'wrong' }, { ...base, subjectRevisionId: r.id, afterReturnDecisionId: receipt.decision.id }]) {
      expect((await request(path + '/submit-for-review', payload, agent)).status).toBe(409);
    }
    const updated = await success<FeedbackFlow>(await request(path + '/submit-for-review', { ...base, afterReturnDecisionId: receipt.decision.id }, agent));
    expect(updated).toMatchObject({ status: 'implemented', subjectRevisionId: next.id, reviewFeedback: null, lastReturnDecisionId: receipt.decision.id });
    expect((await request(path + '/accept', { expectedVersion: updated.version, subjectRevisionId: r.id, acknowledgeSelfReportedEvidence: true })).status).toBe(409);
    expect(await success<ReviewReceipt>(await request(path + '/review-operations/history', undefined, reviewer))).toEqual(receipt);
    // A second return preserves both immutable decision rows and is linked to the new candidate.
    const second = await success<ReviewReceipt>(await request(path + '/request-changes', { ...body, expectedVersion: updated.version, subjectRevisionId: next.id }, reviewer));
    expect(second.decision.id).not.toBe(receipt.decision.id);
    const db = new Database(join(dir, 'hub.sqlite'), { readonly: true });
    try { expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM hub_legacy_review_decisions').get()!.n).toBe(2); } finally { db.close(); }
  });

  for (const state of ['initializing', 'ready', 'completing'] as const) test('never returns a Flow in ' + state, async () => {
    const { openHubStore } = await import('./store');
    const { f, body, path } = await fixture();
    const store = openHubStore(dir), seeded = store.load();
    seeded.flows.find(flow => flow.id === f.id)!.status = state;
    try { store.save(seeded); } finally { store.close(); }
    const response = await request(path + '/request-changes', body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid-transition' } });
    expect((await success<HubFlow>(await request(path))).status).toBe(state);
  });

  test('does not return in-progress or historical done Flows and keeps old Flow feedback explicitly null', async () => {
    const { f, body, path } = await fixture(false);
    const inProgress = await request(path + '/request-changes', body);
    expect(inProgress.status).toBe(409); expect(await inProgress.json()).toMatchObject({ error: { code: 'invalid-transition' } });
    const submitted = await success<HubFlow>(await request(path + '/submit-for-review', { expectedVersion: f.version, subjectRevisionId: body.subjectRevisionId }, agent));
    const done = await success<HubFlow>(await request(path + '/accept', { expectedVersion: submitted.version, subjectRevisionId: body.subjectRevisionId, acknowledgeSelfReportedEvidence: true }));
    expect((await request(path + '/request-changes', { ...body, expectedVersion: done.version })).status).toBe(409);
    expect(await success<FeedbackFlow>(await request(path))).toMatchObject({ status: 'done', reviewFeedback: null, receipt: done.receipt });
  });
  test('rolls back the decision, Flow, event and operation together when durable decision storage fails', async () => {
    const { p, f, body, path } = await fixture(), key = 'atomic-return';
    const db = new Database(join(dir, 'hub.sqlite'));
    try {
      // Trigger a real SQLite transaction failure instead of replacing an internal service with a mock.
      db.exec("CREATE TRIGGER fail_review_insert BEFORE INSERT ON hub_legacy_review_decisions BEGIN SELECT RAISE(ABORT,'fixture-write-failure'); END");
      const before = await success<unknown>(await request(`/projects/${p.id}/events`));
      const failed = await request(path + '/request-changes', body, reviewer, key);
      expect(failed.status).toBe(500);
      expect(await failed.text()).not.toContain('fixture-write-failure');
      expect((await success<HubFlow>(await request(path))).version).toBe(f.version);
      expect(await success<unknown>(await request(`/projects/${p.id}/events`))).toEqual(before);
      expect((await request(path + '/review-operations/' + key, undefined, reviewer)).status).toBe(404);
      expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM hub_legacy_review_decisions').get()!.n).toBe(0);
      db.exec('DROP TRIGGER fail_review_insert');
      const retried = await success<ReviewReceipt>(await request(path + '/request-changes', body, reviewer, key));
      expect(retried.flowVersion).toBe(f.version + 1);
      expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM hub_legacy_review_decisions').get()!.n).toBe(1);
    } finally { db.close(); }
  });

  test('does not silently lose the durable last-return guard when old aggregate state is saved', async () => {
    const { openHubStore } = await import('./store');
    const { body, path } = await fixture();
    const before = openHubStore(dir), stale = before.load(); before.close();
    const receipt = await success<ReviewReceipt>(await request(path + '/request-changes', body, reviewer, 'guard'));
    const writer = openHubStore(dir);
    try {
      // A migrated aggregate/old snapshot must be rejected or retain the authoritative guard.
      try { writer.save(stale); } catch (error) { expect(error).toBeInstanceOf(Error); }
    } finally { writer.close(); }
    app.close(); app = createHubApplication(config);
    const current = await success<FeedbackFlow>(await request(path));
    expect(current.lastReturnDecisionId).toBe(receipt.decision.id);
    expect(current.reviewFeedback).toEqual(receipt.decision);
    expect(current.subjectRevisionId).toBeNull();
  });

  test('rejects a newly designated malformed review guide before persistence, without scanning ordinary JSON files', async () => {
    const { p } = await fixture();
    const revisionPath = `/projects/${p.id}/revisions`;
    const body = (path: string) => ({baseRevisionId:null,gitBaseSha:'a'.repeat(40),message:'guide',changes:[{path,contentBase64:Buffer.from('{malformed').toString('base64')}]});
    const ordinary = await request(revisionPath,body('fixtures/data.json'),agent);
    expect(ordinary.status).toBe(200);
    const rejected = await request(revisionPath,body('attempt/review-guide.json'),agent);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({error:{code:'invalid-review-guide'}});
    const revisions = await success<{revisions: CodeRevision[]}>(await request(revisionPath));
    expect(revisions.revisions.some(revision => revision.files.some(file => file.path==='attempt/review-guide.json'))).toBe(false);
  });

  test('checks designated guide membership against the pinned legacy criteria when submitting a new result', async () => {
    const { p, f, path } = await fixture(false);
    const guide = {format:'review-guide/v1',summary:'Added review',userImpact:'Human reviews work',limitations:[],prerequisites:[],steps:[{stepId:'check',criterionIds:['foreign-criterion'],location:'Browser',instruction:'Open the result',expectedResult:'The expected result is shown'}]};
    const created = await success<CodeRevision>(await request(`/projects/${p.id}/revisions`,{baseRevisionId:null,gitBaseSha:'a'.repeat(40),message:'guide with wrong membership',changes:[{path:'attempt/review-guide.json',contentBase64:Buffer.from(JSON.stringify(guide)).toString('base64')}]},agent));
    await evidence(p,f,created);
    const response = await request(path+'/submit-for-review',{expectedVersion:f.version,subjectRevisionId:created.id},agent);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({error:{code:'invalid-review-guide'}});
    expect((await success<HubFlow>(await request(path))).status).toBe('in-progress');
    guide.steps[0]!.criterionIds=[`legacy:${f.specContentDigest}:1`];
    const valid = await success<CodeRevision>(await request(`/projects/${p.id}/revisions`,{baseRevisionId:null,gitBaseSha:'a'.repeat(40),message:'valid guide',changes:[{path:'attempt/review-guide.json',contentBase64:Buffer.from(JSON.stringify(guide)).toString('base64')}]},agent));
    await evidence(p,f,valid);
    expect((await request(path+'/submit-for-review',{expectedVersion:f.version,subjectRevisionId:valid.id},agent)).status).toBe(200);
  });

  test('refuses a newly scoped human before recovering an older committed return operation', async () => {
    const {p,body,path} = await fixture(), key='scoped-operation';
    await success<ReviewReceipt>(await request(path+'/request-changes',body,reviewer,key));
    const login = await app.fetch(new Request('http://hub.test/hub/v1/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:reviewer})}));
    expect(login.status).toBe(200);
    const cookie=login.headers.get('set-cookie')!.split(';')[0]!, value=cookie.slice(cookie.indexOf('=')+1);
    const {openHubStore}=await import('./store'), store=openHubStore(dir), state=store.load();
    const session=state.sessions[createHash('sha256').update(value).digest('hex')]!;
    session.principal.projectIds=['another-project'];
    try {store.save(state);} finally {store.close();}
    const forbidden=await app.fetch(new Request('http://hub.test/hub/v1'+path+'/review-operations/'+key,{headers:{cookie}}));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).not.toContain(body.comment.trim());
    expect((await request(`/projects/${p.id}/flows`,undefined,agent)).status).toBe(200);
  });

  test('keeps the original receipt after event pruning and at replay quota, while rejecting a new return atomically', async () => {
    const {openHubStore}=await import('./store'), {legacyStorageLimits}=await import('./legacy-limits');
    const first=await fixture(), second=await fixture(), key='retained-operation';
    const receipt=await success<ReviewReceipt>(await request(first.path+'/request-changes',first.body,reviewer,key));
    const store=openHubStore(dir), state=store.load();
    const existing=Object.keys(state.replays).length;
    for (let i=existing;i<legacyStorageLimits.maxReplayRecords;i++) state.replays['retained-'+i]={digest:'fixture',status:200,body:null};
    state.events=Array.from({length:legacyStorageLimits.retainedEvents+5},(_,index)=>({projectId:first.p.id,sequence:index+1,type:'fixture-invalidation',entityId:first.f.id,actorId:'fixture',createdAt:'2026-01-01T00:00:00.000Z'}));
    try {store.save(state);} finally {store.close();}
    app.close();app=createHubApplication(config);
    expect(await success<ReviewReceipt>(await request(first.path+'/review-operations/'+key,undefined,reviewer))).toEqual(receipt);
    expect(await success<ReviewReceipt>(await request(first.path+'/request-changes',first.body,reviewer,key))).toEqual(receipt);
    expect((await request(second.path+'/request-changes',second.body,reviewer,'over-cap')).status).toBe(413);
    expect((await success<HubFlow>(await request(second.path))).version).toBe(second.f.version);
    expect((await request(second.path+'/review-operations/over-cap',undefined,reviewer)).status).toBe(404);
    const db=new Database(join(dir,'hub.sqlite'),{readonly:true});
    try {expect(db.query<{n:number},[]>('SELECT count(*) AS n FROM hub_legacy_review_decisions').get()!.n).toBe(1);} finally {db.close();}
  });

  test('rejects an oversized review request with the documented bounded-body error and no state change', async () => {
    const {f,body,path}=await fixture();
    const response=await request(path+'/request-changes',{...body,comment:'x'.repeat(70*1024)});
    expect(response.status).toBe(413);expect(await response.json()).toMatchObject({error:{code:'request-too-large'}});
    expect((await success<HubFlow>(await request(path))).version).toBe(f.version);
  });

  test('recovers an operation key containing printable URL separators through one encoded opaque segment', async () => {
    const {body,path}=await fixture(), key='review/a?b#c%';
    const receipt=await success<ReviewReceipt>(await request(path+'/request-changes',body,reviewer,key));
    expect(await success<ReviewReceipt>(await request(path+'/review-operations/'+encodeURIComponent(key),undefined,reviewer))).toEqual(receipt);
  });

  for (const key of ['.','..']) test('recovers dot-only operation key '+key+' through the bounded query alias without mutating Flow', async () => {
    const {body,path}=await fixture();
    const receipt=await success<ReviewReceipt>(await request(path+'/request-changes',body,reviewer,key));
    const before=await success<FeedbackFlow>(await request(path));
    expect(await success<ReviewReceipt>(await request(path+'/review-operations?operationId='+encodeURIComponent(key),undefined,reviewer))).toEqual(receipt);
    expect((await request(path+'/review-operations?operationId='+encodeURIComponent(key)+'&operationId=another',undefined,reviewer)).status).toBe(400);
    expect((await request(path+'/review-operations?operationId='+encodeURIComponent(key)+'&extra=1',undefined,reviewer)).status).toBe(400);
    expect((await request(path+'/review-operations?operationId='+encodeURIComponent(key),undefined,agent)).status).toBe(403);
    expect(await success<FeedbackFlow>(await request(path))).toEqual(before);
  });

});
