import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHubStore } from './store';

const principal = { id: 'human:owner', kind: 'human' as const, role: 'operator' as const };
const project = (id: string) => ({ id, name: id, version: 1, lineRevisionId: null, lineVersion: 0, contextRevision: 0 });

test('projections are rebuilt when another writer changed hub_state behind them (rollback, then re-upgrade)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-projection-drift-'));
  try {
    const first = openHubStore(dir), state = first.load();
    state.projects.push(project('p-old'));
    state.sessions['logged-out'] = { principal, expiresAt: Date.now() + 3_600_000 };
    state.sessions['kept'] = { principal, expiresAt: Date.now() + 3_600_000 };
    first.save(state); first.close();
    // A release that does not know the projections writes hub_state only: a logout and a new project.
    const db = new Database(join(dir, 'hub.sqlite'));
    const body = JSON.parse(db.query<{ body: string }, []>('SELECT body FROM hub_state WHERE id=1').get()!.body);
    delete body.sessions['logged-out']; body.sessions['created-there'] = { principal, expiresAt: Date.now() + 3_600_000 }; body.projects.push(project('p-new'));
    db.query('UPDATE hub_state SET body=? WHERE id=1').run(JSON.stringify(body)); db.close();
    const reopened = openHubStore(dir);
    try {
      expect(reopened.session('logged-out')).toBeUndefined();
      expect(reopened.session('created-there')).toBeDefined();
      expect(reopened.session('kept')).toBeDefined();
      expect(reopened.project('p-new')).toEqual(project('p-new'));
      expect(reopened.project('p-old')).toEqual(project('p-old'));
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a full document archive skips unpinned legacy versions instead of refusing legacy edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-archive-full-'));
  const document = (id: string, content: string) => ({ id, projectId: 'p', path: id + '.md', kind: 'wiki' as const, version: 1, content, contentDigest: createHash('sha256').update(content).digest('hex'), sourceRevision: 'source', approval: 'accepted' as const });
  const store = openHubStore(dir);
  try {
    const state = store.load(); state.projects.push(project('p')); state.documents.push(document('a', 'first'));
    store.save(state);
    const db = new Database(join(dir, 'hub.sqlite')); db.exec('UPDATE hub_work_document_usage SET count=100001'); db.close();
    const edited = store.load(); edited.documents.push(document('b', 'second'));
    expect(() => store.save(edited)).not.toThrow();
    expect(store.load().documents.map(item => item.id)).toEqual(['a', 'b']);
    const b = document('b', 'second');
    expect(store.work.documentVersion('p', { documentId: 'b', version: 1, contentDigest: b.contentDigest })).toBeUndefined();
    // A managed-work pin still needs the exact bytes archived, so it is the one that is refused.
    expect(() => store.work.archiveDocument(b)).toThrow('Immutable document archive quota');
    expect(store.work.documentVersion('p', { documentId: 'a', version: 1, contentDigest: document('a', 'first').contentDigest })).toEqual(document('a', 'first'));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('immutable document versions refuse conflicting content or metadata without replacing the original archive',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hub-archive-conflict-')),store=openHubStore(dir);
 const document={id:'d',projectId:'p',path:'wiki.md',kind:'wiki' as const,version:1,content:'Original',contentDigest:createHash('sha256').update('Original').digest('hex'),sourceRevision:'source',approval:'accepted' as const};
 try{
  store.work.archiveDocument(document);
  const reference={documentId:document.id,version:document.version,contentDigest:document.contentDigest};
  for(const changed of [{...document,content:'Other',contentDigest:createHash('sha256').update('Other').digest('hex')},{...document,sourceRevision:'different-source'}]){
   expect(()=>store.work.archiveDocument(changed)).toThrow('Immutable document version already has a different representation');
   expect(store.work.documentVersion('p',reference)).toEqual(document);
  }
  expect(store.work.archiveDocument(document)).toBe(true);
  const reordered=Object.fromEntries(Object.entries(document).reverse()) as typeof document;
  expect(store.work.archiveDocument(reordered)).toBe(true);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
