import { test,expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync,mkdirSync,readdirSync,readFileSync,writeFileSync,rmSync,copyFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';

/** Every path under `dir` with its content digest, so a write anywhere in the fixture changes the result. */
const tree=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{const path=join(dir,entry.name);return entry.isDirectory()?[path+'/',...tree(path)]:[path+' '+createHash('sha256').update(readFileSync(path)).digest('hex')];}).sort();

// `--check` writing nothing, fresh or stale, is what lets the release build run it as a
// non-building step (src/lib/production-graph.test.ts, READ_ONLY_RELEASE_CHECKS).
/** A minimal copy of the frontend inputs with a stand-in build, so the real script runs against it. */
function fixture(root:string){
 for(const path of ['scripts','src/hub','src/remote-control','apps/hub-web/src','apps/hub-web/public'])mkdirSync(join(root,path),{recursive:true});
 copyFileSync(resolve(import.meta.dir,'build-hub-web.ts'),join(root,'scripts/build-hub-web.ts'));
 const shared=join(root,'src/remote-control/owned-controls.ts');copyFileSync(resolve(import.meta.dir,'../src/remote-control/owned-controls.ts'),shared);
 const app=join(root,'apps/hub-web');writeFileSync(join(app,'src/main.ts'),"import { isOwnedControlCommand } from '../../../src/remote-control/owned-controls'; console.log(isOwnedControlCommand('tasks.kill'));\n");
 writeFileSync(join(app,'package.json'),JSON.stringify({name:'frontend-input-fixture',scripts:{build:'bun build-fixture.ts'}}));
 writeFileSync(join(app,'build-fixture.ts'),"import { mkdirSync,writeFileSync } from 'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/index.html','<!doctype html><title>Freshness fixture</title>');\n");
 for(const name of ['bun.lock','tsconfig.json','vite.config.ts'])writeFileSync(join(app,name),'{}\n');writeFileSync(join(app,'index.html'),'<!doctype html><title>Fixture source</title>\n');
 const run=(...args:string[])=>Bun.spawnSync([process.execPath,join(root,'scripts/build-hub-web.ts'),...args],{cwd:root,stdout:'pipe',stderr:'pipe',timeout:10000});
 return{shared,app,run};
}

// `--check` writing nothing, fresh or stale, is what lets the release build run it as a
// non-building step (src/lib/production-graph.test.ts, READ_ONLY_RELEASE_CHECKS).
test('embedded frontend freshness rejects changes to its shared owned-controls runtime input, and --check writes nothing',()=>{
 const root=mkdtempSync(join(tmpdir(),'keryx-web-inputs-'));
 try{
  const{shared,run}=fixture(root);
  const sources=tree(root);const build=run();expect(build.exitCode).toBe(0);
  // Anti-vacuous: the snapshot does see the writes of a real build.
  const built=tree(root);expect(built).not.toEqual(sources);expect(run('--check').exitCode).toBe(0);expect(tree(root)).toEqual(built);
  writeFileSync(shared,readFileSync(shared,'utf8')+'\n// Changed shared browser runtime input.\n');
  const changed=tree(root);
  const stale=run('--check');expect(stale.exitCode).not.toBe(0);expect(stale.stderr.toString()).toContain('Frontend assets are stale');expect(tree(root)).toEqual(changed);
 }finally{rmSync(root,{recursive:true,force:true});}
});

// A Windows checkout may hold CRLF: the digest is taken over LF text, or the committed artifact could never verify there.
test('embedded frontend freshness is the same for CRLF and LF text inputs, including the script itself',()=>{
 const root=mkdtempSync(join(tmpdir(),'keryx-web-crlf-'));
 try{
  const{shared,app,run}=fixture(root);expect(run().exitCode).toBe(0);expect(run('--check').exitCode).toBe(0);
  const crlf=(file:string)=>writeFileSync(file,readFileSync(file,'utf8').replaceAll('\r\n','\n').replaceAll('\n','\r\n'));
  for(const file of [shared,join(root,'scripts/build-hub-web.ts'),join(app,'src/main.ts'),join(app,'index.html'),join(app,'package.json'),join(app,'bun.lock'),join(app,'tsconfig.json'),join(app,'vite.config.ts')])crlf(file);
  expect(readFileSync(shared,'utf8')).toContain('\r\n');
  expect(run('--check').exitCode).toBe(0);
  // A real content change is still stale.
  writeFileSync(shared,readFileSync(shared,'utf8')+'// changed\r\n');
  expect(run('--check').exitCode).not.toBe(0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
