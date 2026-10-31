import { expect,test } from "bun:test";
import { mkdtempSync,rmSync,copyFileSync,statSync } from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Database} from "bun:sqlite";
import {openHubStore} from "../store";
test("consistent SQLite backup includes aggregate and remote WAL commits, restores atomically, and never overwrites",()=>{
 const dir=mkdtempSync(join(tmpdir(),"hub-backup-")); const restored=mkdtempSync(join(tmpdir(),"hub-restore-"));
 try {const store=openHubStore(dir); store.writeTransaction((state,repo)=>{state.sessions.original={principal:{id:"human:original",kind:"human",role:"operator"},expiresAt:9999999999999}; repo.put("remote_machine","owned-machine",{machineId:"owned-machine",marker:"same-commit"});});
 const before=store.load(); const target=join(dir,"consistent.sqlite"); store.backup(target); expect(statSync(target).mode&0o777).toBe(0o600); expect(()=>store.backup(target)).toThrow();
 store.writeTransaction((state,repo)=>{delete state.sessions.original;repo.put("remote_machine","owned-machine",{marker:"later"});});store.close();
 copyFileSync(target,join(restored,"hub.sqlite"));const recovered=openHubStore(restored);expect(recovered.load()).toEqual(before);expect(recovered.remote.get<{machineId:string;marker:string}>("remote_machine","owned-machine")).toEqual({machineId:"owned-machine",marker:"same-commit"});recovered.close();
 const db=new Database(join(restored,"hub.sqlite"));expect(db.query("PRAGMA integrity_check").get()).toEqual({integrity_check:"ok"});expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);db.close();
 }finally {rmSync(dir,{recursive:true,force:true});rmSync(restored,{recursive:true,force:true});}
});
