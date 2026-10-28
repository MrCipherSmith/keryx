import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobRegistry, superviseSpawnedProcess, type BackgroundSpawner } from '../harness/tool/builtin/background-job-registry';

function supervise(child: Parameters<typeof superviseSpawnedProcess>[0]) {
  return superviseSpawnedProcess(child, { kill(signal) { try { process.kill(-child.pid, signal); } catch (cause) { if (!(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')) throw cause; } } });
}
test('trusted local JobRegistry spawn preserves real fixed argv and stdin without invoking its string shell label', async () => {
  const cwd=await mkdtemp(join(tmpdir(),'native-local-spawn-'));const jobs=createJobRegistry({cwd,initialBufferMs:0});let starts=0;
  const localSpawn:BackgroundSpawner=()=>{starts++;const child=Bun.spawn(['git','hash-object','--stdin'],{cwd,stdin:'pipe',stdout:'pipe',stderr:'pipe',detached:true});child.stdin.write('bounded native fixture\n');void child.stdin.end();return supervise(child);};
  try {const begun=await jobs.start('/usr/bin/false',{localSpawn,phase:'foreground',description:'Native private Git operation'});expect(begun.ok).toBe(true);if(!begun.ok)throw new Error(begun.error);expect(await jobs.waitForExit(begun.jobId,3000)).toBe('exited');expect(starts).toBe(1);expect(jobs.get(begun.jobId)?.exitCode).toBe(0);const result=jobs.readOutput(begun.jobId);expect(result.ok&&result.output.trim()).toMatch(/^[a-f0-9]{40}$/);}
  finally {await Promise.all(jobs.list().filter(task=>task.status==='running').map(task=>jobs.kill(task.jobId)));await rm(cwd,{recursive:true,force:true});}
});
test('local fixed-argv jobs participate in actual owned group stop while another owned job remains running',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'native-local-stop-'));const jobs=createJobRegistry({cwd,initialBufferMs:0});const children:ReturnType<typeof Bun.spawn>[]=[];
 const localSpawn:BackgroundSpawner=()=>{const child=Bun.spawn([process.execPath,'-e','process.stdout.write("ready\\n");setInterval(()=>{},1000)'],{cwd,stdout:'pipe',stderr:'pipe',detached:true});children.push(child);return supervise(child);};
 try {const first=await jobs.start('/usr/bin/false',{localSpawn,phase:'foreground'});const second=await jobs.start('/usr/bin/false',{localSpawn,phase:'foreground'});if(!first.ok||!second.ok)throw new Error('owned process did not start');await jobs.kill(first.jobId);expect(await jobs.waitForExit(first.jobId,3000)).toBe('exited');expect(jobs.get(first.jobId)?.status).toBe('killed');expect(jobs.get(second.jobId)?.status).toBe('running');expect(children).toHaveLength(2);}
 finally{await Promise.all(jobs.list().filter(task=>task.status==='running').map(task=>jobs.kill(task.jobId)));await Promise.all(children.map(child=>child.exited));await rm(cwd,{recursive:true,force:true});}
});
