import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {activeArchiveIndices} from './host-context';
import {createSession,persistHistory,forkSession,loadContext,loadArchive} from './store';
import type {NormalizedMessage} from '../harness/provider/types';

test('exact native prefix forks retain the selected active window and complete executed audit across resets',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'native-fork-window-'));const dataDir=join(cwd,'state');
 const archive:NormalizedMessage[]=[{role:'user',content:'first'},{role:'assistant',content:'one'},{role:'user',content:'removed second'},{role:'assistant',content:'two'},{role:'user',content:'continued first'},{role:'assistant',content:'three'}];
 const resets=[{cursor:5,archiveCount:4,activeCount:2}];
 try{const original=createSession({cwd,dataDir,title:'Source'});const handle=persistHistory(original,activeArchiveIndices(archive.length,8,resets).map(index=>archive[index]!),{archive});
 const old=forkSession({cwd,dataDir,sourceIdOrPrefix:handle.summary.id,throughArchiveCount:4,contextArchiveIndices:activeArchiveIndices(4,4,resets)});expect(JSON.stringify(loadContext(cwd,old.handle.summary.id,dataDir))).toContain('removed second');
 const current=forkSession({cwd,dataDir,sourceIdOrPrefix:handle.summary.id,throughArchiveCount:6,contextArchiveIndices:activeArchiveIndices(6,8,resets)});expect(JSON.stringify(loadContext(cwd,current.handle.summary.id,dataDir))).not.toContain('removed second');expect(JSON.stringify(loadArchive(cwd,current.handle.summary.id,dataDir))).toContain('removed second');expect(JSON.stringify(loadArchive(cwd,handle.summary.id,dataDir))).toContain('removed second');
 expect(()=>activeArchiveIndices(6,8,[{cursor:5,archiveCount:4,activeCount:5}])).toThrow();expect(()=>forkSession({cwd,dataDir,sourceIdOrPrefix:handle.summary.id,throughArchiveCount:6,contextArchiveIndices:[0,100]})).toThrow();
 }finally{await rm(cwd,{recursive:true,force:true});}
});
