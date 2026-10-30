import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, utimesSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRewindRecorder } from "../../rewind/recorder";
import { assertNativeShadowPath, git, type ShadowGitRequest } from "../../rewind/shadow";
import { createNativeRewindPort, type NativeRewindOwnership } from "./rewind";
import { acquireCheckoutLease } from "../../lib/hub-machine/checkout-lease";
import { createOwnedWorkspace } from "../../lib/hub-machine/workspace";
import type { NormalizedMessage } from "../../harness/provider/types";
import { applyRewind } from "../../rewind/apply";
import { signNativeRewindEntry, verifyNativeRewindEntry } from "../../rewind/manifest";
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const sha=(data:string)=>createHash("sha256").update(data).digest("hex");
function fixtureGit(cwd:string,args:string[]){const proc=Bun.spawnSync(["git","-c","core.hooksPath=/dev/null","-c","commit.gpgsign=false",...args],{cwd,env:{PATH:process.env.PATH??"",GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1"},stdout:"pipe",stderr:"pipe"});if(proc.exitCode!==0)throw new Error("fixture-git");return proc.stdout.toString().trim();}
async function fixture(extraFiles=0,maxSnapshots=50,assets=false,largeAsset=false){
 const base=mkdtempSync(path.join(tmpdir(),"native-rewind-"));roots.push(base);const cwd=path.join(base,"project");mkdirSync(cwd);const dir=path.join(base,"session/rewind");
 fixtureGit(cwd,["init","-q"]);fixtureGit(cwd,["config","user.name","fixture"]);fixtureGit(cwd,["config","user.email","fixture@example.invalid"]);writeFileSync(path.join(cwd,"a.txt"),"before\n");writeFileSync(path.join(cwd,".gitignore"),"ignored.log\n");for(let i=0;i<extraFiles;i++)writeFileSync(path.join(cwd,`source-${i}.txt`),`fixture ${i}\n`);if(assets){writeFileSync(path.join(cwd,"logo.png"),largeAsset?Buffer.alloc(6*1024*1024):Buffer.from([137,80,78,71,0,1,2]));mkdirSync(path.join(cwd,"node_modules"));symlinkSync(path.join(base,"external-package"),path.join(cwd,"node_modules","ignored-link"));writeFileSync(path.join(cwd,".gitignore"),"ignored.log\nnode_modules/\n");}fixtureGit(cwd,["add","."]);fixtureGit(cwd,["commit","-qm","initial"]);
 let historyVersion=1;const signal=new AbortController();let permitted=true;let baselineOverride:string|undefined;let persistFailure=false;
 const lease=acquireCheckoutLease(cwd,{hubId:"fixture-hub",runId:"fixture-run",daemonId:"fixture-daemon"});
 const workspace=createOwnedWorkspace(cwd,()=>{if(!permitted)throw new Error("owner-lost");lease.assertOwnership();});
 const ownership=():NativeRewindOwnership=>({sessionId:"hub-session",nativeSessionId:"native-session",checkoutId:"checkout-one",nonce:lease.nonce,gitHead:fixtureGit(cwd,["rev-parse","HEAD"]),workspaceBaseline:baselineOverride??workspace.baseline().digest,historyVersion});
 const currentPaths=()=>Object.keys(workspace.baseline().files);
 let gitHook:((request:ShadowGitRequest)=>void)|undefined;let reads=0;const runGit=(request:ShadowGitRequest)=>{if(request.readOnly)reads++;gitHook?.(request);return git(request.repo,request.args,{...(request.stdin===undefined?{}:{stdin:request.stdin}),signal:request.signal});};
 const recorder=createRewindRecorder({workTree:cwd,dir:()=>dir,enabled:()=>true,maxSnapshots,native:{runGit,signal:()=>signal.signal,currentPaths,validatePaths:async paths=>{for(const file of paths){const ignored=Bun.spawnSync(["git","check-ignore","--no-index","--quiet","--",file],{cwd,env:{PATH:process.env.PATH??"",GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1"}});if(ignored.exitCode!==1)throw new Error("ignored-or-invalid");}},assertOwnership:()=>{if(!permitted)throw new Error("owner-lost");lease.assertOwnership();},ownership}});
 const history:NormalizedMessage[]=[{role:"user",content:"one"},{role:"assistant",content:"done"},{role:"user",content:"two"},{role:"assistant",content:"done two"}];const archive=[...history];
 recorder.beginTurn({archiveIndex:2,prompt:"two"});await recorder.beforeMutation();const mutation=await workspace.beforeEffect("apply_patch",{patch:"--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n"});if(!mutation.ok)throw new Error("fixture-owned-mutation:"+JSON.stringify(mutation.error));writeFileSync(path.join(cwd,"a.txt"),"after\n");if(!(await workspace.afterEffect(mutation.value.effectId,{isError:false})).ok)throw new Error("fixture-checkpoint");
 const port=createNativeRewindPort({cwd,recorder,history,archive,ownership,canPersist:()=>permitted,persist:(history,archive)=>{if(persistFailure)throw new Error("fixture-persist-failure");writeFileSync(path.join(base,"session/context.json"),JSON.stringify({history,archive}));},afterHistoryRewind:()=>{historyVersion++;},assertCurrent:async expected=>{if(!permitted||!(await workspace.verify(expected)).ok)throw new Error("stale-baseline");}});
 const inspection={signal:signal.signal,beforeAction:async()=>{}};
 const effect={runId:"run-one",turnId:"turn-one",signal:signal.signal,beforeAction:async()=>{},rewind:async<T>(input:import("./rewind").RewindEffectInput,write:()=>Promise<T>)=>{if(!input.paths.length)return write();const start=await workspace.beforeEffect("rewind_restore",{...input});if(!start.ok)throw new Error("fixture-rewind-boundary");try{const value=await write();if(!(await workspace.afterEffect(start.value.effectId,{isError:false})).ok)throw new Error("fixture-post-boundary");return value;}catch(error){await workspace.afterEffect(start.value.effectId,{isError:true});throw error;}}};
 return{cwd,dir,recorder,port,history,archive,ownership,inspection,signal,effect,workspace,readCalls:()=>reads,setGitHook:(hook:(request:ShadowGitRequest)=>void)=>{gitHook=hook;},failPersist:()=>{persistFailure=true;},lose:()=>{permitted=false;},setBaseline:(value:string)=>{baselineOverride=value;}};
}
test("native preview is read-only and actual files/history restoration uses the shared recorder and applyRewind",async()=>{
 const f=await fixture();const seq=f.recorder.entries()[0]!.seq;const count=f.recorder.snapshotCount();const preview=await f.port.preview({seq,mode:"both",expectedHistoryVersion:1},f.inspection);expect(preview.ok).toBe(true);expect(f.recorder.snapshotCount()).toBe(count);if(!preview.ok||preview.status!=="preview")throw new Error("fixture-preview");
 const outcome=await f.port.apply({seq,mode:"both",expectedHistoryVersion:1,previewDigest:preview.data.previewDigest,workspaceBaseline:f.ownership().workspaceBaseline},f.effect);
 expect(outcome).toMatchObject({ok:true,status:"applied",data:{filesRestored:true,historyRewound:true,historyVersion:2}});expect(readFileSync(path.join(f.cwd,"a.txt"),"utf8")).toBe("before\n");expect(f.history).toHaveLength(2);expect(f.archive).toHaveLength(2);
 expect(JSON.stringify(preview)).not.toContain(f.ownership().nonce);expect(JSON.stringify(outcome)).not.toContain(f.ownership().nonce);
});
test("stale preview or lost ownership refuses before file/history effects",async()=>{
 const f=await fixture();const seq=f.recorder.entries()[0]!.seq;const preview=await f.port.preview({seq,mode:"both",expectedHistoryVersion:1},f.inspection);if(!preview.ok||preview.status!=="preview")throw new Error("fixture-preview");f.setBaseline(sha("foreign"));
 const outcome=await f.port.apply({seq,mode:"both",expectedHistoryVersion:1,previewDigest:preview.data.previewDigest,workspaceBaseline:preview.data.workspaceBaseline},f.effect);expect(outcome).toMatchObject({ok:false});expect(readFileSync(path.join(f.cwd,"a.txt"),"utf8")).toBe("after\n");expect(f.history).toHaveLength(4);
});
test("strict preview rejects target/live symlinks and current ignored paths",async()=>{
 const f=await fixture();writeFileSync(path.join(f.cwd,"ignored.log"),"private fixture");symlinkSync("a.txt",path.join(f.cwd,"link"));
 f.recorder.beginTurn({archiveIndex:2,prompt:"unsafe"});await expect(f.recorder.beforeMutation()).rejects.toThrow();
});
test("preview batches bounded raw object reads instead of spending one subprocess per project file",async()=>{
 const f=await fixture(25);const reads=f.readCalls();const result=await f.port.preview({seq:1,mode:"files",expectedHistoryVersion:1},f.inspection);expect(result.ok).toBe(true);expect(f.readCalls()-reads).toBeLessThanOrEqual(4);
});
test("strict capture refuses observed interference while its real Git snapshot is being recorded",async()=>{
 const f=await fixture();const before=f.recorder.snapshotCount();let changed=false;f.setGitHook(request=>{if(!changed&&request.args[0]==="update-index"){changed=true;writeFileSync(path.join(f.cwd,"a.txt"),"alien\n");utimesSync(path.join(f.cwd,"a.txt"),new Date(),new Date(Date.now()+2000));}});
 f.recorder.beginTurn({archiveIndex:2,prompt:"interference"});await expect(f.recorder.beforeMutation()).rejects.toThrow();expect(f.recorder.snapshotCount()).toBe(before);expect(readFileSync(path.join(f.cwd,"a.txt"),"utf8")).toBe("alien\n");
});
test("corrupted or legacy provenance is never upgraded into a native restore",async()=>{
 const f=await fixture();const file=path.join(f.dir,"manifest.json");const manifest=JSON.parse(readFileSync(file,"utf8"));manifest.entries[0].native.signature="0".repeat(64);writeFileSync(file,JSON.stringify(manifest));
 expect(await f.port.preview({seq:1,mode:"both",expectedHistoryVersion:1},f.inspection)).toMatchObject({ok:false,error:{code:"unsupported-snapshot"}});
 delete manifest.entries[0].native;writeFileSync(file,JSON.stringify(manifest));expect(await f.port.preview({seq:1,mode:"files",expectedHistoryVersion:1},f.inspection)).toMatchObject({ok:false});expect(readFileSync(path.join(f.cwd,"a.txt"),"utf8")).toBe("after\n");
});
test("cancelled inspection and changed working files refuse without consuming a snapshot or history",async()=>{
 const f=await fixture();const preview=await f.port.preview({seq:1,mode:"both",expectedHistoryVersion:1},f.inspection);if(!preview.ok||preview.status!=="preview")throw new Error("fixture-preview");const count=f.recorder.snapshotCount();writeFileSync(path.join(f.cwd,"a.txt"),"external edit\n");
 expect(await f.port.apply({seq:1,mode:"both",expectedHistoryVersion:1,previewDigest:preview.data.previewDigest,workspaceBaseline:preview.data.workspaceBaseline},f.effect)).toMatchObject({ok:false});expect(f.recorder.snapshotCount()).toBe(count);expect(f.history).toHaveLength(4);expect(readFileSync(path.join(f.cwd,"a.txt"),"utf8")).toBe("external edit\n");f.signal.abort();expect(await f.port.preview({seq:1,mode:"files",expectedHistoryVersion:1},f.inspection)).toMatchObject({ok:false,error:{code:"cancelled"}});
});
test("history persistence failure reports recovery after real files restore and never silently cuts active history",async()=>{
 const f=await fixture();const preview=await f.port.preview({seq:1,mode:"both",expectedHistoryVersion:1},f.inspection);if(!preview.ok||preview.status!=="preview")throw new Error("fixture-preview");f.failPersist();
 expect(await f.port.apply({seq:1,mode:"both",expectedHistoryVersion:1,previewDigest:preview.data.previewDigest,workspaceBaseline:preview.data.workspaceBaseline},f.effect)).toMatchObject({ok:false,partial:true,recoveryRequired:true});expect(readFileSync(path.join(f.cwd,"a.txt"),"utf8")).toBe("before\n");expect(f.history).toHaveLength(4);expect(f.archive).toHaveLength(4);
});
test("actual shared local service and native adapter restore the same files and history without changing project Git",async()=>{
 const local=await fixture();const remote=await fixture();const fingerprint=(cwd:string)=>fixtureGit(cwd,["rev-parse","HEAD"])+sha(readFileSync(path.join(cwd,".git/index"),"binary"));const beforeLocal=fingerprint(local.cwd),beforeRemote=fingerprint(remote.cwd);
 const localResult=await applyRewind({recorder:local.recorder,seq:1,mode:"both",history:local.history,archive:local.archive,canPersist:()=>true,persist:()=>{}});
 const preview=await remote.port.preview({seq:1,mode:"both",expectedHistoryVersion:1},remote.inspection);if(!preview.ok||preview.status!=="preview")throw new Error("fixture-preview");const remoteResult=await remote.port.apply({seq:1,mode:"both",expectedHistoryVersion:1,previewDigest:preview.data.previewDigest,workspaceBaseline:preview.data.workspaceBaseline},remote.effect);
 expect(localResult).toMatchObject({ok:true,filesRestored:true,historyRewound:true});expect(remoteResult).toMatchObject({ok:true,data:{filesRestored:true,historyRewound:true}});expect(local.history).toEqual(remote.history);expect(local.archive).toEqual(remote.archive);expect(readFileSync(path.join(local.cwd,"a.txt"),"utf8")).toBe(readFileSync(path.join(remote.cwd,"a.txt"),"utf8"));expect(fingerprint(local.cwd)).toBe(beforeLocal);expect(fingerprint(remote.cwd)).toBe(beforeRemote);
});
test("private Git native boundary rejects arbitrary batch expressions before invoking its runner",async()=>{
 const f=await fixture();let called=false;const repo={gitDir:path.join(f.dir,"shadow.git"),workTree:f.cwd,native:{runGit:async()=>{called=true;return{code:0,stdout:"",stderr:""};},signal:()=>f.signal.signal,assertOwnership:()=>{},validatePaths:async()=>{},currentPaths:()=>[]}};
 await expect(git(repo,["cat-file","--batch"],{stdin:"HEAD:a.txt\n"})).rejects.toThrow();expect(called).toBe(false);
});
test("public checkpoint projection is bounded before returning data",async()=>{
 const f=await fixture();const file=path.join(f.dir,"manifest.json");const manifest=JSON.parse(readFileSync(file,"utf8"));manifest.entries[0].prompt="x".repeat(40000);manifest.entries[0].native=signNativeRewindEntry(manifest.entries[0],f.ownership());writeFileSync(file,JSON.stringify(manifest));expect(await f.port.list(f.inspection)).toMatchObject({ok:false,error:{code:"quota-exceeded"}});
});
test("over-budget native capture refuses instead of claiming a complete snapshot with skipped files",async()=>{
 const f=await fixture();const count=f.recorder.snapshotCount();writeFileSync(path.join(f.cwd,"a.txt"),"x".repeat(20*1024*1024+1));f.recorder.beginTurn({archiveIndex:2,prompt:"large"});await expect(f.recorder.beforeMutation()).rejects.toThrow();expect(f.recorder.snapshotCount()).toBe(count);
});
test("shared recorder honors an explicitly cancelled restore scope before making an undo point",async()=>{
 const f=await fixture();const count=f.recorder.snapshotCount();const abort=new AbortController();abort.abort();expect(await f.recorder.restoreFiles(1,{signal:abort.signal})).toMatchObject({ok:false});expect(f.recorder.snapshotCount()).toBe(count);expect(readFileSync(path.join(f.cwd,"a.txt"),"utf8")).toBe("after\n");
});
test("foreign native ownership, protected paths, checkout ignore rules and absent effect admission fail closed",async()=>{
 const f=await fixture();const entry=f.recorder.entries()[0]!;expect(verifyNativeRewindEntry(entry,{...f.ownership(),nativeSessionId:"foreign"})).toBe(false);expect(verifyNativeRewindEntry(entry,{...f.ownership(),nonce:"different-private-nonce"})).toBe(false);
 for(const relative of ["../outside",".git/config","node_modules/private","/tmp/outside"])expect(()=>assertNativeShadowPath(f.cwd,relative)).toThrow();
 const preview=await f.port.preview({seq:1,mode:"files",expectedHistoryVersion:1},f.inspection);if(!preview.ok||preview.status!=="preview")throw new Error("fixture-preview");expect(await f.port.apply({seq:1,mode:"files",expectedHistoryVersion:1,previewDigest:preview.data.previewDigest,workspaceBaseline:preview.data.workspaceBaseline},{runId:"r",turnId:"t",signal:f.signal.signal,beforeAction:async()=>{}})).toMatchObject({ok:false,error:{code:"setup-required"}});
 writeFileSync(path.join(f.cwd,".git/info/exclude"),"a.txt\n");expect(await f.port.preview({seq:1,mode:"files",expectedHistoryVersion:1},f.inspection)).toMatchObject({ok:false});expect(readFileSync(path.join(f.cwd,"a.txt"),"utf8")).toBe("after\n");
});
test("native recorder retains actual bounded snapshots through its existing private Git retention service",async()=>{
 const f=await fixture(0,2);for(let i=0;i<2;i++){f.recorder.beginTurn({archiveIndex:2,prompt:`capture ${i}`});await f.recorder.beforeMutation();}expect(f.recorder.entries().map(entry=>entry.seq)).toEqual([2,3]);
});

test("unchanged binary assets and ignored dependency symlinks do not block an affected text rewind",async()=>{
 const f=await fixture(0,50,true);const before=readFileSync(path.join(f.cwd,"logo.png"));const preview=await f.port.preview({seq:1,mode:"files",expectedHistoryVersion:1},f.inspection);expect(preview).toMatchObject({ok:true,status:"preview",data:{paths:["a.txt"]}});if(!preview.ok||preview.status!=="preview")throw new Error("fixture-preview");
 expect(await f.port.apply({seq:1,mode:"files",expectedHistoryVersion:1,previewDigest:preview.data.previewDigest,workspaceBaseline:preview.data.workspaceBaseline},f.effect)).toMatchObject({ok:true});expect(readFileSync(path.join(f.cwd,"logo.png"))).toEqual(before);
});
test("affected binary restoration remains an explicit refusal before writes",async()=>{
 const f=await fixture(0,50,true);const begun=await f.workspace.beforeEffect("apply_patch",{patch:"--- a/logo.png\n+++ b/logo.png\n@@ -1 +1 @@\n-before\n+after\n"});if(!begun.ok)throw new Error("fixture-owned-binary");writeFileSync(path.join(f.cwd,"logo.png"),Buffer.from([137,80,78,71,0,4,5]));expect((await f.workspace.afterEffect(begun.value.effectId,{isError:false})).ok).toBe(true);
 expect(await f.port.preview({seq:1,mode:"files",expectedHistoryVersion:1},f.inspection)).toMatchObject({ok:false,error:{code:"unsupported-snapshot"}});expect(readFileSync(path.join(f.cwd,"a.txt"),"utf8")).toBe("after\n");
});

test("unchanged oversized assets are retained opaquely while affected oversized restores refuse",async()=>{
 const f=await fixture(0,50,true,true);const preview=await f.port.preview({seq:1,mode:"files",expectedHistoryVersion:1},f.inspection);expect(preview).toMatchObject({ok:true,status:"preview",data:{paths:["a.txt"]}});
 const begun=await f.workspace.beforeEffect("apply_patch",{patch:"--- a/logo.png\n+++ b/logo.png\n@@ -1 +1 @@\n-before\n+after\n"});if(!begun.ok)throw new Error("fixture-owned-large");writeFileSync(path.join(f.cwd,"logo.png"),Buffer.alloc(6*1024*1024,1));expect((await f.workspace.afterEffect(begun.value.effectId,{isError:false})).ok).toBe(true);
 expect(await f.port.preview({seq:1,mode:"files",expectedHistoryVersion:1},f.inspection)).toMatchObject({ok:false});expect(readFileSync(path.join(f.cwd,"a.txt"),"utf8")).toBe("after\n");
});
