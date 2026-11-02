import { expect,test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHubStore } from './store';

test('rollback writer changes rebuild legacy and session projections on reupgrade',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hub-projection-'));let store=openHubStore(dir);
 try{
  const state=store.load();state.sessions.old={principal:{id:'old',role:'operator',projectIds:['*']},expiresAt:Date.now()+60_000};store.save(state);store.close();
  const db=new Database(join(dir,'hub.sqlite'));const raw=JSON.parse((db.query('SELECT body FROM hub_state WHERE id=1').get() as {body:string}).body);
  raw.sessions={};raw.projects.push({id:'rollback-project',name:'Rollback writer project',createdAt:'2026-01-01T00:00:00Z'});db.query('UPDATE hub_state SET body=? WHERE id=1').run(JSON.stringify(raw));db.close();
  store=openHubStore(dir);expect(store.session('old')).toBeUndefined();expect(store.project('rollback-project')?.name).toBe('Rollback writer project');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
