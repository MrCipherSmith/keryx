import { fail } from "./domain";
import { Database } from "bun:sqlite";
import { migrateWork, workRepository } from "./work/storage";
import { migrateRemote, syncProjectReferences, remoteRepository, type RemoteRepository } from "./remote-v2/storage";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {remoteBudgets as normalizeRemoteBudgets,type RemoteBudgets} from './remote-v2/budgets';
import type { CodeRevision, Delivery, Evidence, HubDocument, HubEvent, HubFlow, Principal, Project, Proposal } from "./contracts";
import type { VerifiedAccessIdentity } from "./cloudflare-access";
export type StoredSession = { principal: Principal; credentialDigest?: string; accessIdentity?: VerifiedAccessIdentity; expiresAt: number };
export type StoredReplay = { digest: string; status: number; body: unknown };
export type HubState = {
  projects: Project[]; documents: HubDocument[]; proposals: Proposal[]; flows: HubFlow[];
  evidence: Evidence[]; revisions: CodeRevision[]; deliveries: Delivery[]; events: HubEvent[];
  documentChanges: { projectId: string; revision: number; document: HubDocument }[];
  legacyConversions?: Record<string,{projectId:string;managedFlowId:string}>;
  sessions: Record<string, StoredSession>; replays: Record<string, StoredReplay>;
};
function emptyState(): HubState {
  return { projects: [], documents: [], proposals: [], flows: [], evidence: [], revisions: [], deliveries: [], events: [], documentChanges: [], sessions: {}, replays: {} };
}
/** One-process prototype: a durable JSON aggregate committed atomically with its receipts/events. */
export function openHubStore(dataDir: string,budgets:Partial<RemoteBudgets>={}) {
  const budgetConfig=normalizeRemoteBudgets(budgets);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const databasePath = join(dataDir, 'hub.sqlite');
  const db = new Database(databasePath, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS hub_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)");
  try { migrateRemote(db); migrateWork(db); } catch (error) { db.close(); throw error; }
  for (const path of [databasePath, databasePath + '-wal', databasePath + '-shm']) if (existsSync(path)) chmodSync(path, 0o600);
  db.exec('CREATE TABLE IF NOT EXISTS hub_legacy_records(kind TEXT NOT NULL,id TEXT NOT NULL,project_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE INDEX IF NOT EXISTS hub_legacy_project ON hub_legacy_records(project_id,kind); CREATE INDEX IF NOT EXISTS hub_legacy_id ON hub_legacy_records(project_id,id)');
  db.exec('CREATE TABLE IF NOT EXISTS hub_sessions(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  const remote = remoteRepository(db,budgetConfig);
  const work = workRepository(db);
  const withConversionProjection = (state: HubState): HubState => {
    delete state.legacyConversions;
    const conversions = new Proxy<Record<string, {projectId:string;managedFlowId:string}>>({}, {
      get(_target, key) { return typeof key === 'string' ? work.conversionForLegacy(key) : undefined; },
    });
    Object.defineProperty(state, 'legacyConversions', { configurable: true, enumerable: false, value: conversions });
    return state;
  };
  const legacyBaselines = new WeakMap<HubState, string>();
  const load = (): HubState => {
    const row = db.query<{ body: string }, []>("SELECT body FROM hub_state WHERE id=1").get();
    const state=row ? JSON.parse(row.body) as HubState : emptyState();
    withConversionProjection(state);
    legacyBaselines.set(state, serializedLegacy(state));
    return state;
  };
  const listeners = new Set<(state: HubState, previous: HubState) => void>();
  const notify = (state: HubState, previous: HubState) => { for (const listener of listeners) { try { listener(state, previous); } catch (error) { console.error("Hub committed notification failed", error instanceof Error ? error.name : "UnknownError"); } } };
  const serializedLegacy = (state: HubState): string => {
    const { legacyConversions: unused, ...durable } = state; void unused;
    return JSON.stringify(durable);
  };
  const project = (id: string): Project | undefined => {
    const row = db.query<{ body: string }, [string]>("SELECT body FROM hub_legacy_records WHERE kind='projects' AND id=?").get(id);
    return row ? JSON.parse(row.body) as Project : undefined;
  };
  const syncLegacy = (state: HubState, previous?: HubState) => {
    const kinds = ['projects','documents','proposals','flows','evidence','revisions','deliveries'] as const;
    const put = db.query('INSERT INTO hub_legacy_records(kind,id,project_id,body) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET project_id=excluded.project_id,body=excluded.body WHERE body<>excluded.body');
    for (const kind of kinds) {
      const old = new Map((previous?.[kind] ?? []).map(record => [record.id, JSON.stringify(record)]));
      for (const record of state[kind]) {
        const body = JSON.stringify(record);
        if (body !== old.get(record.id)) put.run(kind, record.id, kind === 'projects' ? record.id : 'projectId' in record ? record.projectId : '', body);
        old.delete(record.id);
      }
      for (const id of old.keys()) db.query('DELETE FROM hub_legacy_records WHERE kind=? AND id=?').run(kind, id);
    }
    const previousSessions = new Map(Object.entries(previous?.sessions ?? {}).map(([id, value]) => [id, JSON.stringify(value)]));
    for (const [id, value] of Object.entries(state.sessions)) {
      const body = JSON.stringify(value);
      if (body !== previousSessions.get(id)) db.query('INSERT INTO hub_sessions(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id,body);
      previousSessions.delete(id);
    }
    for (const id of previousSessions.keys()) db.query('DELETE FROM hub_sessions WHERE id=?').run(id);
    for (const document of state.documents) work.archiveDocument(document);
    for (const change of state.documentChanges) work.archiveDocument(change.document);
  };
  // The projection is additive. Bootstrap once from old databases, never on a work request.
  if (!db.query("SELECT 1 FROM hub_work_settings WHERE key='legacy-projection-v1'").get()) db.transaction(() => {
    syncLegacy(load());
    db.query("INSERT INTO hub_work_settings(key,value) VALUES('legacy-projection-v1','1')").run();
  })();
  if (!db.query("SELECT 1 FROM hub_work_settings WHERE key='session-projection-v1'").get()) db.transaction(() => {
    for (const [id, value] of Object.entries(load().sessions)) db.query('INSERT OR REPLACE INTO hub_sessions(id,body) VALUES(?,?)').run(id,JSON.stringify(value));
    db.query("INSERT INTO hub_work_settings(key,value) VALUES('session-projection-v1','1')").run();
  })();
  const session = (id: string): StoredSession | undefined => {
    const row = db.query<{body:string},[string]>('SELECT body FROM hub_sessions WHERE id=?').get(id);
    return row ? JSON.parse(row.body) as StoredSession : undefined;
  };
  const workLegacyContext = (projectId: string, records: readonly import('./work/model').WorkRecord[] = [], payload?: unknown): HubState => {
    const state = emptyState(), currentProject = project(projectId);
    if (currentProject) state.projects.push(currentProject);
    const ids = new Set<string>();
    const visit = (value: unknown): void => {
      if (typeof value === 'string') ids.add(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    records.forEach(visit); visit(payload);
    for (const id of ids) for (const row of db.query<{ kind: string; body: string }, [string,string]>('SELECT kind,body FROM hub_legacy_records WHERE project_id=? AND id=?').all(projectId,id)) {
      if (row.kind === 'projects') continue;
      const values = state[row.kind as 'documents'];
      values.push(JSON.parse(row.body));
    }
    return state;
  };
  const persist = db.transaction((state: HubState, previous?: HubState) => {
    syncProjectReferences(db, state.projects);
    syncLegacy(state, previous);
    db.query("INSERT INTO hub_state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE body<>excluded.body").run(serializedLegacy(state));
  });
  const save = (state: HubState) => {
    let previous!: HubState;
    db.transaction(() => {
      previous = load();
      const baseline = legacyBaselines.get(state);
      if (baseline !== undefined && baseline !== serializedLegacy(previous)) fail(409, 'version-conflict', 'Legacy state changed; reload before saving');
      persist(state, previous);
      legacyBaselines.set(state, serializedLegacy(state));
    })();
    notify(state, previous);
  };
  /** Managed work shares the SQLite authority transaction without touching legacy JSON. */
  const workTransaction = <T>(action: () => T): T => db.transaction(() => {
    const result = action();
    if (result instanceof Promise) throw new TypeError('Hub transactions must be synchronous');
    return result;
  })();
  const writeTransaction = <T>(action: (state: HubState, remote: RemoteRepository) => T): T => {
    let previous!: HubState, committed!: HubState, changed = false;
    const result = db.transaction(() => {
      previous = load(); const state = withConversionProjection(structuredClone(previous)); committed = state;
      const result = action(state, remote);
      if (result instanceof Promise) throw new TypeError('Hub transactions must be synchronous');
      changed = serializedLegacy(state) !== serializedLegacy(previous);
      if (changed) persist(state, previous);
      return result;
    })();
    if (changed) notify(committed, previous);
    return result;
  };
  let closed = false;
  const backup = (destination: string): void => {
    if (closed) throw new Error("Hub store is closed");
    if (!isAbsolute(destination)) throw new TypeError("Absolute backup destination required");
    // VACUUM INTO copies committed WAL data using SQLite's bounded page cache.
    // Reserve with wx first so an existing destination can never be overwritten.
    const descriptor = openSync(destination, 'wx', 0o600);
    const temporaryDirectory = mkdtempSync(join(dirname(destination), '.hub-backup-'));
    try {
      chmodSync(temporaryDirectory, 0o700);
      const temporary = join(temporaryDirectory, 'snapshot.sqlite');
      db.query('VACUUM INTO ?').run(temporary);
      const source = openSync(temporary, 'r');
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        for (let length = readSync(source, buffer, 0, buffer.length, null); length; length = readSync(source, buffer, 0, buffer.length, null)) {
          let written = 0;
          while (written < length) written += writeSync(descriptor, buffer, written, length - written);
        }
      } finally { closeSync(source); }
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); rmSync(temporaryDirectory, { recursive: true, force: true }); }
  };
  return { load, save, remote, work, project, session, workLegacyContext, workTransaction, writeTransaction, backup, subscribe(listener: (state: HubState, previous: HubState) => void) { listeners.add(listener); return () => listeners.delete(listener); }, close() { if (!closed) { closed = true; listeners.clear(); db.close(); } } };
}
export type HubStore = ReturnType<typeof openHubStore>;
