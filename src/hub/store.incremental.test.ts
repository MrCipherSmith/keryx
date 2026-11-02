import { expect,test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHubStore } from './store';

test('legacy reads do not serialize history and remote-only transactions do not materialize it',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hub-serialization-')),store=openHubStore(dir);
 try {
  const state=store.load();state.replays.large={digest:'d',status:200,body:'x'.repeat(100_000)};store.save(state);
  const parse=JSON.parse,stringify=JSON.stringify;let parses=0,serializations=0;
  JSON.parse=((value:string,...rest:[])=>{if(value.length>50_000)parses++;return parse(value,...rest);}) as typeof JSON.parse;
  JSON.stringify=((value:unknown,...rest:[])=>{const result=stringify(value,...rest);if(result&&result.length>50_000)serializations++;return result;}) as typeof JSON.stringify;
  try {store.load();expect(serializations).toBe(0);parses=0;store.writeTransaction((_state,repo)=>{expect(repo).toBe(store.remote);});expect(parses).toBe(0);expect(serializations).toBe(0);store.writeTransaction(state=>{state.replays.changed={digest:'e',status:200,body:'ok'};});expect(parses).toBe(2);expect(serializations).toBe(1);}
  finally{JSON.parse=parse;JSON.stringify=stringify;}
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('rollback writer changes rebuild legacy and session projections on reupgrade',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hub-projection-'));let store=openHubStore(dir);
 try{
  const state=store.load();state.sessions.old={principal:{kind:'human',id:'old',role:'operator',projectIds:['*']},expiresAt:Date.now()+60_000};store.save(state);store.close();
  const db=new Database(join(dir,'hub.sqlite'));const raw=JSON.parse((db.query('SELECT body FROM hub_state WHERE id=1').get() as {body:string}).body);
  raw.sessions={};raw.projects.push({id:'rollback-project',name:'Rollback writer project',createdAt:'2026-01-01T00:00:00Z'});db.query('UPDATE hub_state SET body=? WHERE id=1').run(JSON.stringify(raw));db.close();
  store=openHubStore(dir);expect(store.session('old')).toBeUndefined();expect(store.project('rollback-project')?.name).toBe('Rollback writer project');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('lazy legacy transactions roll back changes and preserve optimistic concurrency',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hub-lazy-rollback-')),store=openHubStore(dir);
 try{const stale=store.load();expect(()=>store.writeTransaction(state=>{state.replays.failed={digest:'x',status:200,body:'x'};throw Error('abort');})).toThrow('abort');expect(store.load().replays.failed).toBeUndefined();store.writeTransaction(state=>{state.replays.winner={digest:'w',status:200,body:'winner'};});expect(()=>store.save(stale)).toThrow('Legacy state changed');expect(store.load().replays.winner?.body).toBe('winner');}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('returning the lazy transaction state preserves its original snapshot boundary',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hub-lazy-snapshot-')),store=openHubStore(dir);
 try{const snapshot=store.writeTransaction(state=>state);store.writeTransaction(state=>{state.replays.later={digest:'later',status:200,body:'later'};});expect(snapshot.replays.later).toBeUndefined();}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('async legacy callback is refused and its synchronous changes roll back',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hub-lazy-async-')),store=openHubStore(dir);
 try{expect(()=>store.writeTransaction(async state=>{state.replays.async={digest:'async',status:200,body:'async'};})).toThrow('must be synchronous');expect(store.load().replays.async).toBeUndefined();}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
