import type { HubPreferences } from "./contracts";
import { createHash } from "node:crypto";
import { legacyReviewRepository } from "./legacy-review-storage";
import { legacyArtifacts } from "./legacy-artifacts";
import { deliveryJobs } from "./delivery-jobs";
import { fail } from "./domain";
import { Database } from "bun:sqlite";
import { migrateWork, workRepository } from "./work/storage";
import { REMOTE_TABLES, migrateRemote, syncProjectReferences, remoteRepository, type RemoteRepository } from "./remote-v2/storage";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {remoteBudgets as normalizeRemoteBudgets,type RemoteBudgets} from './remote-v2/budgets';
import type { CodeRevision, Delivery, Evidence, HubDocument, HubEvent, HubFlow, Principal, Project, Proposal } from "./contracts";
import type { VerifiedAccessIdentity } from "./cloudflare-access";
export type StoredSession = { principal: Principal; credentialDigest?: string; accessIdentity?: VerifiedAccessIdentity; expiresAt: number };
export type StoredReplay = { digest: string; status: number; body: unknown; revisionId?: string };
export type HubState = {
  projects: Project[]; documents: HubDocument[]; proposals: Proposal[]; flows: HubFlow[];
  evidence: Evidence[]; revisions: CodeRevision[]; deliveries: Delivery[]; events: HubEvent[];
  documentChanges: { projectId: string; revision: number; document: HubDocument }[];
  legacyReviewDecision?: (projectId: string, flowId: string, id: string) => import("./contracts").LegacyReviewDecision | undefined;
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
  db.exec("CREATE TABLE IF NOT EXISTS hub_user_preferences (actor_id TEXT PRIMARY KEY, theme TEXT, language TEXT)");
  const readPreferences = db.query<HubPreferences, [string]>("SELECT theme, language FROM hub_user_preferences WHERE actor_id=?");
  const updatePreferences = db.query<HubPreferences, [string, HubPreferences["theme"], HubPreferences["language"]]>(
    "INSERT INTO hub_user_preferences(actor_id, theme, language) VALUES (?, ?, ?) ON CONFLICT(actor_id) DO UPDATE SET theme=coalesce(excluded.theme, theme), language=coalesce(excluded.language, language) RETURNING theme, language",
  );
  const preferences = {
    read(actorId: string): HubPreferences {
      return readPreferences.get(actorId) ?? { theme: null, language: null };
    },
    update(actorId: string, patch: Partial<HubPreferences>): HubPreferences {
      return updatePreferences.get(actorId, patch.theme ?? null, patch.language ?? null)!;
    },
  };
  const remote = remoteRepository(db,budgetConfig);
  const work = workRepository(db);
  const deliveries = deliveryJobs(db);
  const artifacts = legacyArtifacts(db);
  let legacyReview: ReturnType<typeof legacyReviewRepository> | undefined;
  const withConversionProjection = (state: HubState): HubState => {
    delete state.legacyConversions;
    Object.defineProperty(state,'legacyReviewDecision',{configurable:true,enumerable:false,value:(projectId:string,flowId:string,id:string)=>legacyReview?.decision(projectId,flowId,id)});
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
    artifacts.hydrate(state);
    withConversionProjection(state);
    legacyBaselines.set(state, row?.body ?? JSON.stringify(emptyState()));
    return state;
  };
  const listeners = new Set<(state: HubState, previous: HubState) => void>();
  const notify = (state: HubState, previous: HubState) => { for (const listener of listeners) { try { listener(state, previous); } catch (error) { console.error("Hub committed notification failed", error instanceof Error ? error.name : "UnknownError"); } } };
  const project = (id: string): Project | undefined => {
    const row = db.query<{ body: string }, [string]>("SELECT body FROM hub_legacy_records WHERE kind='projects' AND id=?").get(id);
    return row ? JSON.parse(row.body) as Project : undefined;
  };
  const syncLegacy = (state: HubState, previous?: HubState) => {
    const kinds = ['projects','documents','proposals','flows','evidence','revisions','deliveries'] as const;
    const put = db.query('INSERT INTO hub_legacy_records(kind,id,project_id,body) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET project_id=excluded.project_id,body=excluded.body WHERE body<>excluded.body');
    for (const kind of kinds) {
      const old = new Map((previous?.[kind] ?? []).map(record => [record.id, kind === 'revisions' ? JSON.stringify(artifacts.metadataRevision(record as CodeRevision)) : JSON.stringify(record)]));
      for (const record of state[kind]) {
        const body = kind === 'revisions' ? JSON.stringify(artifacts.metadataRevision(record as CodeRevision)) : JSON.stringify(record);
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
    for (const document of state.documents) work.archiveDocument(document,true);
    for (const change of state.documentChanges) work.archiveDocument(change.document,true);
  };
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
      const record = JSON.parse(row.body);
      values.push(row.kind === 'revisions' ? artifacts.hydrateRevision(record) : record);
    }
    return state;
  };
  const projectionDigest = (body: string) => createHash('sha256').update(body).digest('hex');
  const setProjectionDigest = (body: string) => db.query("INSERT OR REPLACE INTO hub_work_settings(key,value) VALUES('legacy-projection-digest',?)").run(projectionDigest(body));
  const persisted = db.query<{body:string},[]>('SELECT body FROM hub_state WHERE id=1').get();
  const projected = db.query<{value:string},[]>("SELECT value FROM hub_work_settings WHERE key='legacy-projection-digest'").get();
  if (projected?.value !== projectionDigest(persisted?.body ?? '')) db.transaction(() => {
    db.exec('DELETE FROM hub_legacy_records; DELETE FROM hub_sessions');
    syncLegacy(load());
    setProjectionDigest(persisted?.body ?? '');
  })();
  const persist = db.transaction((state: HubState, previous?: HubState, allowExisting = false, prepared?: {body:string;previousBytes:number}) => {
    legacyReview?.assertGuards(state.flows);
    syncProjectReferences(db, state.projects);
    syncLegacy(state, previous);
    const body = artifacts.persist(state, allowExisting, previous, prepared);
    db.query("INSERT INTO hub_state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE body<>excluded.body").run(body);
    setProjectionDigest(body);
    return body;
  });
  const save = (state: HubState) => {
    let previous!: HubState;
    db.transaction(() => {
      previous = load();
      const baseline = legacyBaselines.get(state);
      if (baseline !== undefined && baseline !== legacyBaselines.get(previous)) fail(409, 'version-conflict', 'Legacy state changed; reload before saving');
      const body = artifacts.prepare(state);
      persist(state, previous, false, {body,previousBytes:Buffer.byteLength(legacyBaselines.get(previous)!)});
      legacyBaselines.set(state, body);
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
    let previous!: HubState, committed: HubState | undefined, baseline: string | undefined, changed = false;
    const materialize = (): HubState => {
      if (!committed) { committed = load(); baseline = legacyBaselines.get(committed)!; }
      return committed;
    };
    // Most remote frames use only the normalized repository. Do not parse legacy history
    // until a callback actually reads or writes a legacy field.
    const state = new Proxy({} as HubState, {
      get: (_target,key) => Reflect.get(materialize(),key),
      set: (_target,key,value) => Reflect.set(materialize(),key,value),
      deleteProperty: (_target,key) => Reflect.deleteProperty(materialize(),key),
      has: (_target,key) => Reflect.has(materialize(),key),
      ownKeys: () => Reflect.ownKeys(materialize()),
      getOwnPropertyDescriptor: (_target,key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(materialize(),key);
        return descriptor ? {...descriptor,configurable:true} : undefined;
      },
      defineProperty: (_target,key,descriptor) => Reflect.defineProperty(materialize(),key,descriptor),
    });
    const result = db.transaction(() => {
      let result = action(state, remote);
      if (result instanceof Promise) throw new TypeError('Hub transactions must be synchronous');
      if (result === state) result = materialize() as T;
      if (committed) {
        const body = artifacts.prepare(committed);
        changed = body !== baseline;
        if (changed) {
          previous = withConversionProjection(artifacts.hydrate(JSON.parse(baseline!) as HubState));
          persist(committed,previous,false,{body,previousBytes:Buffer.byteLength(baseline!)});
        }
      }
      return result;
    })();
    if (changed) notify(committed!, previous);
    return result;
  };
  try {
    if (!db.query("SELECT 1 FROM hub_work_settings WHERE key='legacy-artifacts-v1'").get()) db.transaction(() => {
      const state = load(); persist(state, undefined, true);
      db.query("INSERT INTO hub_work_settings(key,value) VALUES('legacy-artifacts-v1','1')").run();
    })();
  } catch (error) { db.close(); throw error; }
  try { legacyReview = legacyReviewRepository(db); } catch (error) { db.close(); throw error; }
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
  const projectDeletionBlockers = (state: HubState, projectId: string): string[] => {
    const blockers: string[] = [];
    const exists = (sql: string) => !!db.query(sql).get(projectId);
    const openFlow = state.flows.some(flow => flow.projectId === projectId && flow.status !== "done") ||
      exists("SELECT 1 FROM hub_work_records WHERE project_id=? AND json_extract(body,'$.kind')='flow' AND json_extract(body,'$.state') NOT IN ('accepted','cancelled') LIMIT 1");
    if (openFlow) blockers.push("open-flows");
    if (exists("SELECT 1 FROM remote_machine, json_each(remote_machine.body,'$.projectIds') WHERE value=? AND json_extract(remote_machine.body,'$.revoked')=0 LIMIT 1") ||
        exists("SELECT 1 FROM remote_pairing, json_each(remote_pairing.body,'$.projectIds') WHERE value=? AND json_extract(remote_pairing.body,'$.consumed')=0 AND json_extract(remote_pairing.body,'$.expiresAt')>strftime('%Y-%m-%dT%H:%M:%fZ','now') LIMIT 1"))
      blockers.push("machines");
    if (exists("SELECT 1 FROM remote_session WHERE projectId=? AND coalesce(json_extract(body,'$.record.state'),'unknown') NOT IN ('closed','failed') LIMIT 1"))
      blockers.push("sessions");
    if (exists("SELECT 1 FROM remote_run WHERE projectId=? AND coalesce(json_extract(body,'$.state'),'unknown') NOT IN ('succeeded','failed','cancelled','rejected','lost') LIMIT 1") ||
        state.proposals.some(proposal => proposal.projectId === projectId && proposal.status === "pending") ||
        exists("SELECT 1 FROM hub_delivery_jobs WHERE project_id=? AND status IN ('queued','running','uncertain') LIMIT 1") ||
        exists("SELECT 1 FROM hub_work_execution_reservations WHERE project_id=? LIMIT 1"))
      blockers.push("unfinished-work");
    const retained = [state.documents, state.flows, state.proposals, state.revisions, state.evidence, state.deliveries, state.documentChanges]
      .some(records => records.some(record => record.projectId === projectId)) ||
      ["hub_work_records", "hub_work_documents", "hub_delivery_jobs"].some(table => exists(`SELECT 1 FROM ${table} WHERE project_id=? LIMIT 1`)) ||
      REMOTE_TABLES.some(table => table !== "remote_project_ref" && exists(`SELECT 1 FROM ${table} WHERE projectId=? LIMIT 1`));
    if (retained && blockers.length === 0) blockers.push("retained-history");
    return blockers;
  };
  const removeEmptyProject = (state: HubState, projectId: string) => {
    db.query("DELETE FROM remote_project_ref WHERE id=?").run(projectId);
    state.projects = state.projects.filter(project => project.id !== projectId);
  };
  return { load, save, preferences, projectDeletionBlockers, removeEmptyProject, remote, work, deliveries, legacyReview, project, session, workLegacyContext, workTransaction, writeTransaction, backup, subscribe(listener: (state: HubState, previous: HubState) => void) { listeners.add(listener); return () => listeners.delete(listener); }, close() { if (!closed) { closed = true; listeners.clear(); db.close(); } } };
}
export type HubStore = ReturnType<typeof openHubStore>;
