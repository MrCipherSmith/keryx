import type { Database } from "bun:sqlite";
import {remoteBudgets,type RemoteBudgets} from './budgets';
export const REMOTE_TABLES = ["remote_project_ref", "remote_machine", "remote_pairing", "remote_inventory", "remote_capability_page", "remote_projection", "remote_session", "remote_operation", "remote_queue", "remote_controller_release", "remote_confirmation", "remote_run", "remote_command", "remote_event", "remote_session_event", "remote_history", "remote_approval_projection", "remote_authorization_grant", "remote_reconciliation", "remote_result_receipt", "remote_run_check"] as const;
export type RemoteTable = typeof REMOTE_TABLES[number];
export class RemoteStorageFailure extends Error {}
export const REMOTE_SCHEMA_VERSION = 2;
function createRemoteTable(db: Database, table: RemoteTable, physical: string = table): void {
  const refs: string[] = [];
  if (table !== "remote_project_ref") refs.push("FOREIGN KEY(projectId) REFERENCES remote_project_ref(id) DEFERRABLE INITIALLY DEFERRED");
  if (table !== "remote_machine" && table !== "remote_project_ref") refs.push("FOREIGN KEY(machineId) REFERENCES remote_machine(id) DEFERRABLE INITIALLY DEFERRED");
  if (table !== "remote_session" && table !== "remote_machine" && table !== "remote_project_ref") refs.push("FOREIGN KEY(sessionId) REFERENCES remote_session(id) DEFERRABLE INITIALLY DEFERRED");
  if (table !== "remote_run" && table !== "remote_session" && table !== "remote_machine" && table !== "remote_project_ref") refs.push("FOREIGN KEY(runId) REFERENCES remote_run(id) DEFERRABLE INITIALLY DEFERRED");
  db.exec(`CREATE TABLE ${physical} (id TEXT PRIMARY KEY, projectId TEXT, machineId TEXT, sessionId TEXT, runId TEXT, seq INTEGER CHECK(seq IS NULL OR seq>=0), body TEXT NOT NULL CHECK(json_valid(body))${refs.length ? "," + refs.join(",") : ""})`);
}
function indexes(db: Database, table: RemoteTable): void { db.exec(`CREATE INDEX ${table}_project ON ${table}(projectId,id); CREATE INDEX ${table}_machine ON ${table}(machineId,seq); CREATE INDEX ${table}_session ON ${table}(sessionId,seq); CREATE INDEX ${table}_run ON ${table}(runId,seq)`); }
export function syncProjectReferences(db: Database, projects: { id: string }[]): void {
  const put = db.query("INSERT INTO remote_project_ref(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body");
  for (const project of projects) put.run(project.id, JSON.stringify({ id: project.id }));
}
export function migrateRemote(db: Database): void {
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.transaction(() => {
      db.exec("CREATE TABLE IF NOT EXISTS remote_schema_version(version INTEGER NOT NULL)");
      const row = db.query<{ version: number }, []>("SELECT version FROM remote_schema_version").get();
      if (row && row.version !== 1 && row.version !== REMOTE_SCHEMA_VERSION) throw new RemoteStorageFailure("Unsupported remote schema version");
      if (row?.version === REMOTE_SCHEMA_VERSION) return;
      for (const table of REMOTE_TABLES) {
        const old = db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
        const temporary = `${table}_v2`;
        createRemoteTable(db, table, temporary);
        if (old) { db.exec(`INSERT INTO ${temporary}(id,projectId,machineId,sessionId,runId,seq,body) SELECT id,projectId,machineId,sessionId,runId,seq,body FROM ${table}`); db.exec(`DROP TABLE ${table}`); }
        db.exec(`ALTER TABLE ${temporary} RENAME TO ${table}`); indexes(db, table);
      }
      const aggregate = db.query<{ body: string }, []>("SELECT body FROM hub_state WHERE id=1").get();
      if (aggregate) { const state = JSON.parse(aggregate.body) as { projects?: { id: string }[] }; syncProjectReferences(db, state.projects ?? []); }
      db.exec("CREATE UNIQUE INDEX remote_event_sequence ON remote_event(runId,seq); CREATE UNIQUE INDEX remote_session_event_sequence ON remote_session_event(sessionId,seq); CREATE UNIQUE INDEX remote_command_sequence ON remote_command(machineId,seq)");
      if (row) db.query("UPDATE remote_schema_version SET version=?").run(REMOTE_SCHEMA_VERSION); else db.query("INSERT INTO remote_schema_version(version) VALUES(?)").run(REMOTE_SCHEMA_VERSION);
      if (db.query("PRAGMA foreign_key_check").all().length) throw new RemoteStorageFailure("Remote migration contains orphaned references; restore the consistent backup");
    })();
  } finally { db.exec("PRAGMA foreign_keys=ON"); }
}

export type RemoteIdentity = { projectId?: string | undefined; machineId?: string | undefined; sessionId?: string | undefined; runId?: string | undefined; seq?: number | undefined };
export function remoteRepository(db: Database, options:Partial<RemoteBudgets>={}) {
  const budgets=remoteBudgets(options);
  return {
    budgets,
    sessionRuns(sessionId:string):number{return db.query<{n:number},[string]>("SELECT COUNT(*) AS n FROM remote_run WHERE sessionId=?").get(sessionId)!.n;},
    unresolvedSessionCommands(sessionId:string):number{return db.query<{n:number},[string]>("SELECT COUNT(*) AS n FROM remote_command WHERE sessionId=? AND COALESCE(json_extract(body,'$.status'),'unknown') NOT IN ('applied','not-applied','rejected','expired-unconfirmed')").get(sessionId)!.n;},
    dispatchCommands<T>():T[]{return db.query<{body:string},[]>("SELECT body FROM remote_command WHERE json_extract(body,'$.status')='pending' ORDER BY machineId,seq,id").all().map(r=>JSON.parse(r.body) as T);},
    expiringCommands<T>(now:number):T[]{return db.query<{body:string},[string]>("SELECT body FROM remote_command WHERE COALESCE(json_extract(body,'$.capacityReleased'),0)=0 AND json_extract(body,'$.envelope.expiresAt')<=? AND (json_extract(body,'$.status')='pending' OR (json_extract(body,'$.status') IN ('received','admitted') AND (json_extract(body,'$.capacity') IN ('cancel','denial') OR json_extract(body,'$.envelope.kind')='cancel-run'))) ORDER BY machineId,seq,id").all(new Date(now).toISOString()).map(r=>JSON.parse(r.body) as T);},
    unresolvedSessionRuns(sessionId:string):number{return db.query<{n:number},[string]>("SELECT COUNT(*) AS n FROM remote_run WHERE sessionId=? AND json_extract(body,'$.state') NOT IN ('succeeded','failed','cancelled','rejected','lost')").get(sessionId)!.n;},
    hasAdmittedTurn(runId:string):boolean{return !!db.query<{id:string},[string]>("SELECT id FROM remote_session_event WHERE json_extract(body,'$.kind')='turn-admitted' AND json_extract(body,'$.runId')=? LIMIT 1").get(runId);},
    retryableSessions(now:number):string[]{return db.query<{sessionId:string},[number]>("SELECT DISTINCT sessionId FROM remote_queue WHERE json_extract(body,'$.item.state')='queued' AND json_extract(body,'$.admissionCommandId') IS NULL AND json_extract(body,'$.retryAfter')<=?").all(now).map(r=>r.sessionId);},
    releaseRunCapacity(runId:string):void{db.query("UPDATE remote_command SET body=json_set(body,'$.capacityReleased',json('true')) WHERE json_extract(body,'$.envelope.runId')=? OR json_extract(body,'$.envelope.target.runId')=?").run(runId,runId);},
    pendingCancel(runId:string):boolean{return !!db.query<{id:string},[string]>("SELECT id FROM remote_command WHERE json_extract(body,'$.envelope.runId')=? AND json_extract(body,'$.capacity')='cancel' AND json_extract(body,'$.status') NOT IN ('applied','not-applied','rejected','expired-unconfirmed') LIMIT 1").get(runId);},
    commandUsage(capacity:'ordinary'|'cancel'|'denial') {return db.query<{count:number;bytes:number},[string]>("SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM remote_command WHERE COALESCE(json_extract(body,'$.capacityReleased'),0)=0 AND COALESCE(json_extract(body,'$.capacity'),'ordinary')=? AND COALESCE(json_extract(body,'$.status'),'unknown') NOT IN ('applied','not-applied','rejected','expired-unconfirmed')").get(capacity)!;},
    activeRuns():number{return db.query<{n:number},[]>("SELECT COUNT(*) AS n FROM remote_run WHERE json_extract(body,'$.state') NOT IN ('succeeded','failed','cancelled','rejected','lost')").get()!.n;},
    stagingBytes(base?:string):number{return db.query<{n:number},[string]>("SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) AS n FROM remote_capability_page WHERE id LIKE ?").get(base?`${base}:%`:'%')!.n;},
    projectionPages<T>(base:string):T[]{return db.query<{body:string},[string]>("SELECT body FROM remote_capability_page WHERE id LIKE ? ORDER BY seq,id").all(`${base}:%`).map(r=>JSON.parse(r.body) as T);},
    *sessionValues<T>(table:RemoteTable,sessionId:string):Generator<T>{const query=db.prepare<{body:string},[string]>(`SELECT body FROM ${table} WHERE sessionId=? ORDER BY seq,id`);try{for(const row of query.iterate(sessionId))yield JSON.parse(row.body) as T;}finally{query.finalize();}},
    terminalEvent<T>(runId:string,state:string):T|undefined{const row=db.query<{body:string},[string,string]>("SELECT body FROM remote_event WHERE runId=? AND COALESCE(json_extract(body,'$.event.kind'),json_extract(body,'$.kind'))='state' AND COALESCE(json_extract(body,'$.event.state'),json_extract(body,'$.state'))=? ORDER BY seq DESC LIMIT 1").get(runId,state);return row?JSON.parse(row.body) as T:undefined;},
    /** The machine's own accounting unit: each chunk's bytes as sent (`logBytes`), not the masked text Hub stores. */
    runLogBytes(runId:string):number{return db.query<{n:number},[string]>("SELECT COALESCE(SUM(CASE WHEN COALESCE(json_extract(body,'$.event.kind'),json_extract(body,'$.kind'))='log' THEN COALESCE(json_extract(body,'$.logBytes'),length(CAST(COALESCE(json_extract(body,'$.event.text'),json_extract(body,'$.text')) AS BLOB))) ELSE 0 END),0) AS n FROM remote_event WHERE runId=?").get(runId)!.n;},
    *runEventsAfter<T>(runId:string,after:number):Generator<T>{const query=db.prepare<{body:string},[string,number]>("SELECT body FROM remote_event WHERE runId=? AND seq>? ORDER BY seq,id");try{for(const row of query.iterate(runId,after))yield JSON.parse(row.body) as T;}finally{query.finalize();}},
    get<T>(table: RemoteTable, id: string): T | undefined { const row = db.query<{ body: string }, [string]>(`SELECT body FROM ${table} WHERE id=?`).get(id); return row ? JSON.parse(row.body) as T : undefined; },
    all<T>(table: RemoteTable, filter: RemoteIdentity = {}): T[] {
      const keys = Object.keys(filter) as (keyof RemoteIdentity)[];
      const rows = db.query<{ body: string }, (string | number)[]>(`SELECT body FROM ${table}${keys.length ? " WHERE " + keys.map((key) => `${key}=?`).join(" AND ") : ""} ORDER BY COALESCE(seq,0),id`).all(...keys.map((key) => filter[key]!));
      return rows.map((row) => JSON.parse(row.body) as T);
    },
    put(table: RemoteTable, id: string, value: unknown, identity: RemoteIdentity = {}) {
      const unchangedOwner = ["projectId","machineId","sessionId","runId"].map((key)=>`(excluded.${key} IS NULL OR ${key} IS NULL OR excluded.${key}=${key})`).join(" AND ");
      const result = db.query(`INSERT INTO ${table}(id,projectId,machineId,sessionId,runId,seq,body) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,projectId=COALESCE(excluded.projectId,projectId),machineId=COALESCE(excluded.machineId,machineId),sessionId=COALESCE(excluded.sessionId,sessionId),runId=COALESCE(excluded.runId,runId),seq=COALESCE(excluded.seq,seq) WHERE ${unchangedOwner}`).run(id, identity.projectId ?? null, identity.machineId ?? null, identity.sessionId ?? null, identity.runId ?? null, identity.seq ?? null, JSON.stringify(value));
      if (!result.changes) throw new RemoteStorageFailure("Remote resource identity cannot change owner");
    },
    unresolvedCommands(machineId: string): number { return db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM remote_command WHERE machineId=? AND COALESCE(json_extract(body,'$.capacityReleased'),0)=0 AND COALESCE(json_extract(body,'$.status'),'unknown') NOT IN ('applied','not-applied','rejected','expired-unconfirmed')").get(machineId)!.n; },
    clearCapabilityStaging(machineId: string) { db.query("DELETE FROM remote_capability_page WHERE machineId=?").run(machineId); },
    delete(table: RemoteTable, id: string) { db.query(`DELETE FROM ${table} WHERE id=?`).run(id); },
  };
}
export type RemoteRepository = ReturnType<typeof remoteRepository>;
