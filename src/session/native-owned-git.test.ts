import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobRegistry, superviseSpawnedProcess } from '../harness/tool/builtin/background-job-registry';
import { createNativeOwnedGit } from './native-owned-git';

test('owned private Git uses fixed local argv and input while its raw blobs never enter public job output',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'native-private-git-'));const sessionDir=join(cwd,'native-session');await mkdir(sessionDir);const gitDir=join(sessionDir,'rewind','shadow.git');await mkdir(gitDir,{recursive:true});const jobs=createJobRegistry({cwd,initialBufferMs:0});let spawned=0;
 const runner=createNativeOwnedGit({cwd,sessionDir,jobs,authorize:async()=>{},assertOwnership(){},spawn(request){spawned++;const child=Bun.spawn(['git','--git-dir',gitDir,'--work-tree',cwd,...request.args],{cwd,stdout:'pipe',stderr:'pipe',stdin:request.stdin===undefined?'ignore':new Blob([request.stdin]),detached:true});return superviseSpawnedProcess(child,{kill(signal){try{process.kill(-child.pid,signal);}catch(cause){if(!(cause instanceof Error&&'code'in cause&&cause.code==='ESRCH'))throw cause;}}});}});
 const signal=new AbortController().signal;const base={repo:{gitDir,workTree:cwd},signal};
 try {expect((await runner.run({...base,args:['init','--quiet'],readOnly:false})).code).toBe(0);expect(spawned).toBe(1);expect(jobs.list().every(task=>task.visibility==='private')).toBe(true);
 await expect(runner.run({...base,args:['config','credential.helper','untrusted'],readOnly:false})).rejects.toThrow();expect(spawned).toBe(1);
 const file=Bun.spawnSync(['git','--git-dir',gitDir,'hash-object','-w','--stdin'],{cwd,stdin:Buffer.from('private blob fixture\n'),stdout:'pipe'}).stdout.toString().trim();const result=await runner.run({...base,args:['cat-file','--batch'],stdin:file+'\n',readOnly:true});expect(result.stdout).toContain('private blob fixture');expect(jobs.list().every(task=>{const output=jobs.readOutput(task.jobId);return output.ok&&!output.output.includes('private blob fixture')&&!task.command.includes(file);})).toBe(true);
 await expect(runner.run({...base,repo:{gitDir:join(cwd,'foreign'),workTree:cwd},args:['init','--quiet'],readOnly:false})).rejects.toThrow();
 }finally{await Promise.all(jobs.list().filter(task=>task.status==='running').map(task=>jobs.kill(task.jobId)));await rm(cwd,{recursive:true,force:true});}
});
