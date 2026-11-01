// Frozen production startup/migration code from c1c29b04dacd96360e394bfa8a4ea5c7cf06abcb src/hub/remote-v2/storage.ts.
// Only the unused budgets import was removed. Never update this fixture with the current gate.
// Original full source SHA256: 3643d64b63c21ce2b33735bca5cd2977966ff25ccf3b265570a33924172b4de3
import type { Database } from "bun:sqlite";
export const REMOTE_TABLES = ["remote_project_ref", "remote_machine", "remote_pairing", "remote_inventory", "remote_capability_page", "remote_projection", "remote_session", "remote_operation", "remote_queue", "remote_controller_release", "remote_confirmation", "remote_run", "remote_command", "remote_event", "remote_session_event", "remote_history", "remote_approval_projection", "remote_authorization_grant", "remote_reconciliation", "remote_result_receipt", "remote_run_check"] as const;
export type RemoteTable = typeof REMOTE_TABLES[number];
export class RemoteStorageFailure extends Error {}
export const REMOTE_SCHEMA_VERSION = 2;
/** Existing 0.4.1 startup rejects this marker; remote wire/table layout stays v2. */
export const MANAGED_WORK_WRITER_VERSION = 3;
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
      if (row && row.version !== 1 && row.version !== REMOTE_SCHEMA_VERSION && row.version !== MANAGED_WORK_WRITER_VERSION) throw new RemoteStorageFailure("Unsupported remote schema version");
      if (row?.version === REMOTE_SCHEMA_VERSION || row?.version === MANAGED_WORK_WRITER_VERSION) return;
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
