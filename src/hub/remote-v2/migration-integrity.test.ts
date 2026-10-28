import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHubStore } from "../store";
import { REMOTE_TABLES } from "./storage";
test("normalized remote relationships enforce actual SQLite foreign keys with rollback", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-fk-"));
  try { const store = openHubStore(dir); expect(() => store.writeTransaction((_state, repo) => repo.put("remote_event", "orphan", { runId: "missing" }, { machineId: "missing-machine", sessionId: "missing-session", runId: "missing" }))).toThrow(); expect(store.remote.get("remote_event", "orphan")).toBeUndefined(); store.close(); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
test("an actual startup migration failure rolls back all rebuilt remote tables and legacy aggregate", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-migration-fault-")); const database = join(dir, "hub.sqlite");
  try {
    const db = new Database(database);
    db.exec("CREATE TABLE hub_state(id INTEGER PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE remote_schema_version(version INTEGER NOT NULL); INSERT INTO remote_schema_version VALUES(1)");
    for (const table of REMOTE_TABLES) db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,projectId TEXT,machineId TEXT,sessionId TEXT,runId TEXT,seq INTEGER,body TEXT NOT NULL)`);
    const aggregate = JSON.stringify({ projects: [], documents: [], proposals: [], flows: [], evidence: [], revisions: [], deliveries: [], events: [], documentChanges: [], sessions: { legacy: { principal: { id: "cloudflare:original", kind: "human", role: "operator" }, expiresAt: 9999999999999 } }, replays: {} });
    db.query("INSERT INTO hub_state VALUES(1,?)").run(aggregate);
    db.exec("CREATE TRIGGER migration_fault BEFORE UPDATE OF version ON remote_schema_version WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT,'injected migration fault'); END"); db.close();
    expect(() => openHubStore(dir)).toThrow("injected migration fault");
    const after = new Database(database); expect(after.query("SELECT version FROM remote_schema_version").get()).toEqual({ version: 1 }); expect(after.query("SELECT body FROM hub_state").get()).toEqual({ body: aggregate }); expect(after.query("PRAGMA foreign_key_list(remote_event)").all()).toHaveLength(0); after.exec("DROP TRIGGER migration_fault"); after.close();
    const recovered = openHubStore(dir); expect(recovered.load().sessions.legacy?.principal.id).toBe("cloudflare:original"); recovered.close();
    const ready = new Database(database); expect(ready.query("SELECT version FROM remote_schema_version").get()).toEqual({ version: 2 }); expect(ready.query("PRAGMA foreign_key_check").all()).toHaveLength(0); ready.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("normalized resource identity cannot be reassigned to a different existing owner",()=>{
 const dir=mkdtempSync(join(tmpdir(),"hub-owner-integrity-"));try{const store=openHubStore(dir);
 store.writeTransaction((_state,repo)=>{repo.put("remote_machine","one",{machineId:"one"});repo.put("remote_machine","two",{machineId:"two"});repo.put("remote_session","owned",{owner:"one"},{machineId:"one"});});
 expect(()=>store.writeTransaction((_state,repo)=>repo.put("remote_session","owned",{owner:"two"},{machineId:"two"}))).toThrow();expect(store.remote.get<{owner:string}>("remote_session","owned")).toEqual({owner:"one"});
 store.writeTransaction((_state,repo)=>repo.put("remote_session","owned",{owner:"one",updated:true}));expect(store.remote.all("remote_session",{machineId:"one"})).toEqual([{owner:"one",updated:true}]);store.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
