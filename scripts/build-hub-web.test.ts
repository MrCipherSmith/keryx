import { test,expect } from 'bun:test';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,copyFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('embedded frontend freshness rejects changes to its shared owned-controls runtime input',()=>{
 const root=mkdtempSync(join(tmpdir(),'keryx-web-inputs-'));
 try{
  for(const path of ['scripts','src/hub','src/remote-control','apps/hub-web/src','apps/hub-web/public'])mkdirSync(join(root,path),{recursive:true});
  copyFileSync(resolve(import.meta.dir,'build-hub-web.ts'),join(root,'scripts/build-hub-web.ts'));
  const shared=join(root,'src/remote-control/owned-controls.ts');copyFileSync(resolve(import.meta.dir,'../src/remote-control/owned-controls.ts'),shared);
  const app=join(root,'apps/hub-web');writeFileSync(join(app,'src/main.ts'),"import { isOwnedControlCommand } from '../../../src/remote-control/owned-controls'; console.log(isOwnedControlCommand('tasks.kill'));\n");
  writeFileSync(join(app,'package.json'),JSON.stringify({name:'frontend-input-fixture',scripts:{build:'bun build-fixture.ts'}}));
  writeFileSync(join(app,'build-fixture.ts'),"import { mkdirSync,writeFileSync } from 'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/index.html','<!doctype html><title>Freshness fixture</title>');\n");
  for(const name of ['bun.lock','tsconfig.json','vite.config.ts'])writeFileSync(join(app,name),'{}\n');writeFileSync(join(app,'index.html'),'<!doctype html><title>Fixture source</title>');
  const run=(...args:string[])=>Bun.spawnSync([process.execPath,join(root,'scripts/build-hub-web.ts'),...args],{cwd:root,stdout:'pipe',stderr:'pipe',timeout:10000});
  const build=run();expect(build.exitCode).toBe(0);expect(run('--check').exitCode).toBe(0);
  writeFileSync(shared,readFileSync(shared,'utf8')+'\n// Changed shared browser runtime input.\n');
  const stale=run('--check');expect(stale.exitCode).not.toBe(0);expect(stale.stderr.toString()).toContain('Frontend assets are stale');
 }finally{rmSync(root,{recursive:true,force:true});}
});
