import {expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createOwnedWorkspace} from './workspace';
import {renderMetaprojectGitignoreBlock} from '../metaproject-gitignore';
import {impactEvidenceDataRoot,logPath} from '../../impact-evidence/state';
function fixture(){const cwd=mkdtempSync(path.join(tmpdir(),'machine-owned-'));Bun.spawnSync(['git','init','-q',cwd]);writeFileSync(path.join(cwd,'a'),'initial');Bun.spawnSync(['git','-C',cwd,'add','.']);Bun.spawnSync(['git','-C',cwd,'-c','user.name=Fixture','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','fixture']);return cwd;}
test('only exact successful patch target deltas become the next owned baseline',async()=>{
 const cwd=fixture();try{const workspace=createOwnedWorkspace(cwd);const first=await workspace.checkpoint();expect(first.ok).toBe(true);if(!first.ok)return;
 const effect=await workspace.beforeEffect('apply_patch',{patch:'--- a/a\n+++ b/a\n@@ -1 +1 @@\n-initial\n+owned'});expect(effect.ok).toBe(true);if(!effect.ok)return;writeFileSync(path.join(cwd,'a'),'owned');expect((await workspace.afterEffect(effect.value.effectId,{isError:false})).ok).toBe(true);expect((await workspace.verify(first.value.baseline)).ok).toBe(true);
 const second=await workspace.beforeEffect('apply_patch',{patch:'--- a/a\n+++ b/a\n@@ -1 +1 @@\n-owned\n+second'});expect(second.ok).toBe(true);if(!second.ok)return;writeFileSync(path.join(cwd,'a'),'second');writeFileSync(path.join(cwd,'foreign'),'external');expect((await workspace.afterEffect(second.value.effectId,{isError:false})).ok).toBe(false);expect((await workspace.checkpoint()).ok).toBe(false);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
test('shell writes and failed tool partial edits remain ambiguous and cannot be packaged',async()=>{
 const cwd=fixture();try{const workspace=createOwnedWorkspace(cwd);const effect=await workspace.beforeEffect('shell_exec',{command:'unpredictable'});expect(effect.ok).toBe(true);if(!effect.ok)return;writeFileSync(path.join(cwd,'a'),'ambiguous');expect((await workspace.afterEffect(effect.value.effectId,{isError:false})).ok).toBe(false);expect(()=>workspace.resultChanges()).toThrow('workspace-conflict');}finally{rmSync(cwd,{recursive:true,force:true});}
});
test('trusted analysis writes adopt only fixed regular cache outputs and reject arbitrary paths before effects',async()=>{
 const cwd=fixture();try{
  const {mkdirSync}=await import('node:fs');const relative='.metaproject/data/review-jev-rules/clause-tags.json';mkdirSync(path.dirname(path.join(cwd,relative)),{recursive:true});
  const workspace=createOwnedWorkspace(cwd);const effect=await workspace.beforeEffect('analysis_cache_write',{paths:[relative]});expect(effect.ok).toBe(true);if(!effect.ok)return;
  writeFileSync(path.join(cwd,relative),'{}');expect((await workspace.afterEffect(effect.value.effectId,{isError:false})).ok).toBe(true);
  expect((await workspace.beforeEffect('analysis_cache_write',{paths:['arbitrary.json']})).ok).toBe(false);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
test('patching ignored files is refused before mutation instead of disappearing from provenance',async()=>{
 const cwd=fixture();try{writeFileSync(path.join(cwd,'.gitignore'),'ignored.txt\n');Bun.spawnSync(['git','-C',cwd,'add','.gitignore']);Bun.spawnSync(['git','-C',cwd,'-c','user.name=Fixture','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','ignore']);const workspace=createOwnedWorkspace(cwd);expect((await workspace.beforeEffect('apply_patch',{patch:'diff --git a/ignored.txt b/ignored.txt\nnew file mode 100644\n--- /dev/null\n+++ b/ignored.txt\n@@ -0,0 +1 @@\n+invisible\n'})).ok).toBe(false);}finally{rmSync(cwd,{recursive:true,force:true});}
});
test('trusted cache output is rechecked for regular-file ownership after the actual write',async()=>{
 const cwd=fixture(),outside=fixture();try{const fs=await import('node:fs');const relative='.metaproject/data/review-conform/recent-docs.json';fs.mkdirSync(path.dirname(path.join(cwd,relative)),{recursive:true});writeFileSync(path.join(cwd,'.gitignore'),'.metaproject/data/\n');Bun.spawnSync(['git','-C',cwd,'add','.gitignore']);Bun.spawnSync(['git','-C',cwd,'-c','user.name=Fixture','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','ignore cache']);const workspace=createOwnedWorkspace(cwd);const effect=await workspace.beforeEffect('analysis_cache_write',{paths:[relative]});expect(effect.ok).toBe(true);if(!effect.ok)return;fs.symlinkSync(path.join(outside,'a'),path.join(cwd,relative));expect((await workspace.afterEffect(effect.value.effectId,{isError:false})).ok).toBe(false);}finally{rmSync(cwd,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
test('rewind adopts only exact trusted preview paths under current owned baseline and nonce',async()=>{
 const cwd=fixture();try{let held=true;const workspace=createOwnedWorkspace(cwd,()=>{if(!held)throw new Error('lease-lost');});const input={paths:['a'],previewDigest:'b'.repeat(64),snapshotSeq:1,workspaceBaseline:workspace.baseline().digest};const effect=await workspace.beforeEffect('rewind_restore',input);expect(effect.ok).toBe(true);if(!effect.ok)return;writeFileSync(path.join(cwd,'a'),'restored snapshot');expect((await workspace.afterEffect(effect.value.effectId,{isError:false})).ok).toBe(true);expect(workspace.resultChanges().map(change=>change.path)).toEqual(['a']);held=false;expect((await workspace.beforeEffect('rewind_restore',{...input,workspaceBaseline:workspace.baseline().digest})).ok).toBe(false);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
test('rewind rejects stale previews and partial unlisted edits without laundering ownership',async()=>{
 for(const variant of ['stale','partial','foreign']){const cwd=fixture();try{const workspace=createOwnedWorkspace(cwd);const effect=await workspace.beforeEffect('rewind_restore',{paths:['a'],previewDigest:'b'.repeat(64),snapshotSeq:1,workspaceBaseline:variant==='stale'?'a'.repeat(64):workspace.baseline().digest});if(variant==='stale'){expect(effect.ok).toBe(false);continue;}expect(effect.ok).toBe(true);if(!effect.ok)continue;writeFileSync(path.join(cwd,'a'),'partially restored');if(variant==='foreign')writeFileSync(path.join(cwd,'foreign'),'external');expect((await workspace.afterEffect(effect.value.effectId,{isError:variant==='partial'})).ok).toBe(false);expect(()=>workspace.resultChanges()).toThrow('workspace-conflict');}finally{rmSync(cwd,{recursive:true,force:true});}}
});

const git=(cwd:string,...args:string[])=>expect(Bun.spawnSync(['git','-C',cwd,'-c','user.name=Fixture','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{env:{PATH:process.env.PATH??'',HOME:cwd,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}).exitCode).toBe(0);
/** What the production hook runtime writes into the project at turn start. */
function writeRuntimeData(cwd:string){for(const dir of ['.metaproject/data/learning/observations','.metaproject/data/security/raw'])mkdirSync(path.join(cwd,dir),{recursive:true});
 // The impact-evidence gate's per-session state and log, at the paths its own writer uses.
 mkdirSync(path.join(impactEvidenceDataRoot(cwd),'sessions'),{recursive:true});appendFileSync(logPath(cwd),'{"event":"disabled-config"}\n');writeFileSync(path.join(impactEvidenceDataRoot(cwd),'sessions','native-0000.json'),'{}');
 appendFileSync(path.join(cwd,'.metaproject/data/learning/observations/2026-10-28.jsonl'),'{"event":"prompt"}\n');writeFileSync(path.join(cwd,'.metaproject/data/security/raw/hmac.key'),'k');writeFileSync(path.join(cwd,'.metaproject/data/security/raw/state.json'),'{}');}
const newFile=(file:string)=>`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+owned\n`;
test('a plain checkout already holding keryx runtime data is a clean owned admission',async()=>{
 const cwd=fixture();try{writeRuntimeData(cwd);const workspace=createOwnedWorkspace(cwd);expect((await workspace.checkpoint()).ok).toBe(true);expect(Object.keys(workspace.baseline().files)).toEqual(['a']);}finally{rmSync(cwd,{recursive:true,force:true});}
});
test('plain and keryx-initialized checkouts observe the same files and refuse the same runtime-data patch targets',async()=>{
 const plain=fixture(),initialized=fixture();try{writeFileSync(path.join(initialized,'.gitignore'),renderMetaprojectGitignoreBlock());git(initialized,'add','.gitignore');git(initialized,'commit','-qm','keryx init');
 const observed:string[][]=[];for(const cwd of [plain,initialized]){const workspace=createOwnedWorkspace(cwd);writeRuntimeData(cwd);expect((await workspace.checkpoint()).ok).toBe(true);observed.push(Object.keys(workspace.baseline().files).filter(name=>name!=='.gitignore'));
  // Keryx's own runtime data is never an owned agent effect either: the same refusal with or without the ignore block.
  expect((await workspace.beforeEffect('apply_patch',{patch:newFile('.metaproject/data/learning/observations/forged.jsonl')})).ok).toBe(false);}
 expect(observed[0]).toEqual(observed[1]!);
 }finally{rmSync(plain,{recursive:true,force:true});rmSync(initialized,{recursive:true,force:true});}
});
test('keryx runtime data written mid-session, even during an owned effect, is not a foreign change',async()=>{
 const cwd=fixture();try{const workspace=createOwnedWorkspace(cwd);const first=await workspace.checkpoint();expect(first.ok).toBe(true);if(!first.ok)return;
 writeRuntimeData(cwd);expect((await workspace.verify(first.value.baseline)).ok).toBe(true);
 const effect=await workspace.beforeEffect('apply_patch',{patch:newFile('owned.txt')});expect(effect.ok).toBe(true);if(!effect.ok)return;
 writeFileSync(path.join(cwd,'owned.txt'),'owned\n');writeRuntimeData(cwd);
 expect((await workspace.afterEffect(effect.value.effectId,{isError:false})).ok).toBe(true);expect((await workspace.verify(first.value.baseline)).ok).toBe(true);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
test('a genuine foreign edit still fences the session alongside keryx runtime data',async()=>{
 for(const foreign of [(cwd:string)=>writeFileSync(path.join(cwd,'a'),'edited by someone else'),(cwd:string)=>writeFileSync(path.join(cwd,'new-source.ts'),'export {};\n'),(cwd:string)=>{mkdirSync(path.join(cwd,'.metaproject/data/wiki'),{recursive:true});writeFileSync(path.join(cwd,'.metaproject/data/wiki/page.md'),'not runtime data');}]){
  const cwd=fixture();try{const workspace=createOwnedWorkspace(cwd);const first=await workspace.checkpoint();expect(first.ok).toBe(true);if(!first.ok)return;
  writeRuntimeData(cwd);foreign(cwd);expect((await workspace.verify(first.value.baseline)).ok).toBe(false);}finally{rmSync(cwd,{recursive:true,force:true});}
 }
});
