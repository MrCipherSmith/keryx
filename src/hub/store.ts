import { Database } from "bun:sqlite";
import { migrateRemote, syncProjectReferences, remoteRepository, type RemoteRepository } from "./remote-v2/storage";
import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {remoteBudgets as normalizeRemoteBudgets,type RemoteBudgets} from './remote-v2/budgets';
import type { CodeRevision, Delivery, Evidence, HubDocument, HubEvent, HubFlow, Principal, Project, Proposal } from "./contracts";
import type { VerifiedAccessIdentity } from "./cloudflare-access";
export type StoredSession = { principal: Principal; credentialDigest?: string; accessIdentity?: VerifiedAccessIdentity; expiresAt: number };
export type StoredReplay = { digest: string; status: number; body: unknown };
export type HubState = {
  projects: Project[]; documents: HubDocument[]; proposals: Proposal[]; flows: HubFlow[];
  evidence: Evidence[]; revisions: CodeRevision[]; deliveries: Delivery[]; events: HubEvent[];
  documentChanges: { projectId: string; revision: number; document: HubDocument }[];
  sessions: Record<string, StoredSession>; replays: Record<string, StoredReplay>;
};
function emptyState(): HubState {
  return { projects: [], documents: [], proposals: [], flows: [], evidence: [], revisions: [], deliveries: [], events: [], documentChanges: [], sessions: {}, replays: {} };
}
/** One-process prototype: a durable JSON aggregate committed atomically with its receipts/events. */
export function openHubStore(dataDir: string,budgets:Partial<RemoteBudgets>={}) {
  const budgetConfig=normalizeRemoteBudgets(budgets);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new Database(join(dataDir, "hub.sqlite"), { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS hub_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)");
  try { migrateRemote(db); } catch (error) { db.close(); throw error; }
  const remote = remoteRepository(db,budgetConfig);
  const load = (): HubState => {
    const row = db.query<{ body: string }, []>("SELECT body FROM hub_state WHERE id=1").get();
    return row ? JSON.parse(row.body) as HubState : emptyState();
  };
  const listeners = new Set<(state: HubState, previous: HubState) => void>();
  const notify = (state: HubState, previous: HubState) => { for (const listener of listeners) { try { listener(state, previous); } catch (error) { console.error("Hub committed notification failed", error instanceof Error ? error.name : "UnknownError"); } } };
  const persist = db.transaction((state: HubState) => {
    syncProjectReferences(db, state.projects);
    db.query("INSERT INTO hub_state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(JSON.stringify(state));
  });
  const save = (state: HubState) => { const previous = load(); persist(state); notify(state, previous); };
  const writeTransaction = <T>(action: (state: HubState, remote: RemoteRepository) => T): T => {
    const previous = load(); let committed: HubState;
    const result = db.transaction(() => {
    const state = load(); committed = state; const result = action(state, remote);
    if (result instanceof Promise) throw new TypeError("Hub transactions must be synchronous");
    syncProjectReferences(db, state.projects);
    db.query("INSERT INTO hub_state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(JSON.stringify(state));
    return result;
    })();
    notify(committed!, previous); return result;
  };
  let closed = false;
  const backup = (destination: string): void => {
    if (closed) throw new Error("Hub store is closed");
    if (!isAbsolute(destination)) throw new TypeError("Absolute backup destination required");
    // SQLite serializes this connection's committed main database including WAL;
    // one image contains both the legacy aggregate and remote control records.
    const image = db.serialize();
    const descriptor = openSync(destination, "wx", 0o600);
    try { writeFileSync(descriptor, image); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  };
  return { load, save, remote, writeTransaction, backup, subscribe(listener: (state: HubState, previous: HubState) => void) { listeners.add(listener); return () => listeners.delete(listener); }, close() { if (!closed) { closed = true; listeners.clear(); db.close(); } } };
}
export type HubStore = ReturnType<typeof openHubStore>;
