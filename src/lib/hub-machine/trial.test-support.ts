/** Disposable deterministic trial ONLY. Never imported by production startup or used as a provider fallback.
 * Each machine is a separate `keryx serve` process started from the shipped CLI entry (src/cli.ts) in a synthetic HOME/XDG
 * with a scrubbed environment. Nothing below injects a profile, runtime or provider into that process: serve itself starts its
 * machine bridges (startConfiguredMachineBridges), resolves the checkout through production profile resolution, and reaches the
 * deterministic model only as a configured loopback OpenAI-compatible endpoint. Hooks are left on. */
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';
import {startHub} from '../../hub/server';
import {hubIdentity,machineStateDir,saveEnrollment,allowCheckout} from './config';
import {MachineLedger} from './ledger';import {enrollMachine} from './client';import{protectedWrite}from'./secure-state';
import {canonicalDigest,type Control} from '../../remote-control/protocol';
import{isOperatorMessage}from'../../session/compact';
import type{NormalizedMessage}from'../../harness/provider/types';
import{writeMachinePolicy}from'./policy';
import{saveShellConfig}from'../shell-config';
import{defaultServeConfig,saveServeConfig}from'../serve-config';
import{issueServeToken}from'../serve-credential';
/** The shipped remote profile serve resolves for a Hub turn; production resolution refuses any name outside its closed set. */
export const TRIAL_PROFILE='remote-restricted';
/** A configured local provider: `ollama` carries the explicit loopback grant, and the saved baseUrl points it at the trial endpoint. */
export const TRIAL_PROVIDER='ollama',TRIAL_MODEL='keryx-trial-deterministic';
export const TRIAL_REPLY='Deterministic native trial completed. No vendor model was called.';
/** The tracked Keryx index of every trial checkout, committed as a developer's Keryx project commits it. */
export const TRIAL_INDEX='# Deterministic serve trial checkout\n';
/** Shared context the trial project holds on Hub before any machine connects, so every connect syncs a real canonical document. */
export const TRIAL_CONTEXT={path:'wiki/trial-context.md',content:'# Trial shared context\n\nCanonical Hub context the serve machines sync on connect.\n'};
/** An operator turn in this trial starts with this prefix; anything else the harness adds as a user message is not the operator's. */
const OPERATOR_TURN=/^keryx-trial-turn-(\d+): /;
export const trialTurn=(ordinal:number,text:string)=>`keryx-trial-turn-${ordinal}: ${text}`;
export const supervisedMarker=(machine:string,ordinal:number)=>`keryx-trial-supervised-${machine}-${ordinal}`;
export function trialSelection(messages:NormalizedMessage[]):{ordinal:number;toolName:'shell_exec'|'read_file'|'apply_patch'}{
 const users=messages.filter(isOperatorMessage),text=users.at(-1)?.content.toLowerCase()??'';
 return{ordinal:users.length,toolName:text.includes('sleep')||text.includes('cancel')?'shell_exec':text.includes('read')?'read_file':'apply_patch'};
}
type WireMessage={role?:unknown;content?:unknown;tool_calls?:unknown};
export interface ProviderCall{machine:string;ordinal:number;reply:'tool'|'text';toolName?:string}
/** One deterministic reply for an OpenAI-compatible chat request: the turn's tool once, then a final text. Wire messages carry no
 * injection flags, so only a message with the operator prefix is the operator's; every other user message is treated as injected. */
export function wireReply(machine:string,body:{messages?:WireMessage[];tools?:{function?:{name?:unknown}}[]}):{call:ProviderCall;chunks:object[]}{
 const messages=body.messages??[];const normalized:NormalizedMessage[]=messages.flatMap(m=>m.role==='user'&&typeof m.content==='string'?[OPERATOR_TURN.test(m.content)?{role:'user' as const,content:m.content,provenance:'project' as const}:{role:'user' as const,content:m.content,injected:true as const}]:[]);
 const selection=trialSelection(normalized);let last=-1;messages.forEach((m,index)=>{if(m.role==='user'&&typeof m.content==='string'&&OPERATOR_TURN.test(m.content))last=index;});
 if(last<0||Number(OPERATOR_TURN.exec(messages[last]!.content as string)![1])!==selection.ordinal)return{call:{machine,ordinal:selection.ordinal,reply:'text'},chunks:[{delta:{role:'assistant',content:'keryx-trial-unrecognised-request'},finish:'stop'}]};
 const answered=messages.slice(last+1).some(m=>m.role==='assistant'&&Array.isArray(m.tool_calls)&&m.tool_calls.length>0);
 const offered=(body.tools??[]).some(t=>t.function?.name===selection.toolName);
 if(answered||!offered)return{call:{machine,ordinal:selection.ordinal,reply:'text'},chunks:[{delta:{role:'assistant',content:offered?TRIAL_REPLY:`keryx-trial-tool-not-offered:${selection.toolName}`},finish:'stop'}]};
 const ordinal=selection.ordinal,toolName=selection.toolName;
 // A crash trial outlives its serve process and the operator's recovery steps, so its supervised child sleeps longer than a cancel trial's.
 const seconds=(messages[last]!.content as string).toLowerCase().includes('crash')?120:30;
 const input=toolName==='shell_exec'?{command:`sleep ${seconds}; echo ${supervisedMarker(machine,ordinal)}`}:toolName==='read_file'?{path:'seed.txt'}:{patch:`diff --git a/trial-edit-${ordinal}.txt b/trial-edit-${ordinal}.txt\nnew file mode 100644\n--- /dev/null\n+++ b/trial-edit-${ordinal}.txt\n@@ -0,0 +1 @@\n+deterministic native edit ${ordinal}\n`};
 return{call:{machine,ordinal,reply:'tool',toolName},chunks:[{delta:{role:'assistant',tool_calls:[{index:0,id:`call_trial_${machine}_${ordinal}`,type:'function',function:{name:toolName,arguments:JSON.stringify(input)}}]},finish:null},{delta:{},finish:'tool_calls'}]};
}
/** A loopback OpenAI-compatible endpoint per machine path prefix (`/<machine>/v1/chat/completions`). No vendor is ever reached. */
function startLoopbackProvider(){
 const calls:ProviderCall[]=[],unexpected:string[]=[];
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  const route=new URL(request.url).pathname,match=/^\/(m\d+)\/v1\/chat\/completions$/.exec(route);
  if(request.method!=='POST'||!match){unexpected.push(`${request.method} ${route}`);return Response.json({error:{message:'not found'}},{status:404});}
  const body=await request.json() as Parameters<typeof wireReply>[1]&{model?:string};const reply=wireReply(match[1]!,body);calls.push(reply.call);
  const frames=reply.chunks.map(c=>{const{delta,finish}=c as {delta:object;finish:string|null};return`data: ${JSON.stringify({id:'keryx-trial',object:'chat.completion.chunk',created:0,model:body.model??TRIAL_MODEL,choices:[{index:0,delta,finish_reason:finish}]})}\n\n`;});
  return new Response(`${frames.join('')}data: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-cache'}});
 }});
 return{origin:server.url.origin,calls,unexpected,stop:()=>server.stop(true)};
}
/** Only what the serve child needs; nothing from the operator's environment beyond PATH reaches it. A packaged candidate's own bin
 * directory goes first on PATH, so its builtin hook launcher resolves to that exact installation. */
function scrubbedEnv(machineRoot:string,binDir?:string):Record<string,string>{
 const inherited=process.env.PATH??'/usr/bin:/bin:/usr/sbin:/sbin';
 return{PATH:binDir?`${binDir}:${inherited}`:inherited,HOME:path.join(machineRoot,'home'),XDG_DATA_HOME:path.join(machineRoot,'data'),XDG_CONFIG_HOME:path.join(machineRoot,'xdg-config'),XDG_CACHE_HOME:path.join(machineRoot,'xdg-cache'),XDG_STATE_HOME:path.join(machineRoot,'xdg-state'),TMPDIR:path.join(machineRoot,'tmp'),LANG:'C.UTF-8',NO_COLOR:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'};
}
const gitEnv={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'};
export const SERVE_ENTRY=path.resolve(import.meta.dir,'../../cli.ts');
export interface ServeChild{pid:number;argv:string[];stdout:string[];stderr:string[];exited:Promise<number>;servePort:number;serveToken:string}
/** The shipped CLI entry run from source, or an absolute packaged `keryx` executable (a native candidate's compiled bin/keryx). */
const serveCommand=(candidate?:string)=>candidate?[candidate]:[process.execPath,'--no-env-file','--config=/dev/null',SERVE_ENTRY];
async function startServeChild(machineRoot:string,candidate?:string):Promise<ServeChild>{
 const argv=[...serveCommand(candidate),'serve','--port','0'];
 const handle=Bun.spawn(argv,{cwd:machineRoot,stdin:'ignore',stdout:'pipe',stderr:'pipe',env:scrubbedEnv(machineRoot,candidate?path.dirname(candidate):undefined)});
 const stdout:string[]=[],stderr:string[]=[];
 const follow=(stream:ReadableStream<Uint8Array>,lines:string[])=>(async()=>{const decoder=new TextDecoder();let rest='';for await(const chunk of stream){rest+=decoder.decode(chunk,{stream:true});const parts=rest.split('\n');rest=parts.pop()!;lines.push(...parts);}if(rest)lines.push(rest);})();
 const drained=Promise.all([follow(handle.stdout,stdout),follow(handle.stderr,stderr)]);
 const exited=handle.exited.then(async code=>{await drained;return code;});
 const deadline=Date.now()+30000;let port:number|undefined;
 while(Date.now()<deadline&&port===undefined&&handle.exitCode===null){const line=stdout.find(l=>/listening on http:\/\/127\.0\.0\.1:\d+/.test(l));if(line)port=Number(/127\.0\.0\.1:(\d+)/.exec(line)![1]);else await Bun.sleep(20);}
 if(port===undefined){handle.kill('SIGKILL');await exited;throw new Error(`trial-serve-not-listening: ${JSON.stringify({stdout,stderr}).slice(0,4000)}`);}
 return{pid:handle.pid,argv,stdout,stderr,exited,servePort:port,serveToken:''};
}
/** Terminate like an operator's Ctrl-C (serve drains bridges first); a child that ignores it is killed and reported as such. */
async function stopServeChild(child:ServeChild):Promise<number>{
 try{process.kill(child.pid,'SIGTERM');}catch{/* already exited */}
 const forced=setTimeout(()=>{try{process.kill(child.pid,'SIGKILL');}catch{/* already exited */}},15000);
 try{return await child.exited;}finally{clearTimeout(forced);}
}
/** Asynchronous on purpose: the Hub runs in the test process and must keep answering while an operator command talks to serve. */
async function runOperatorCommand(machineRoot:string,args:string[],candidate?:string):Promise<{exitCode:number;stdout:string;stderr:string}>{
 const handle=Bun.spawn([...serveCommand(candidate),...args],{cwd:machineRoot,stdin:'ignore',stdout:'pipe',stderr:'pipe',env:scrubbedEnv(machineRoot,candidate?path.dirname(candidate):undefined)});
 const forced=setTimeout(()=>handle.kill('SIGKILL'),30000);
 try{const[stdout,stderr,exitCode]=await Promise.all([new Response(handle.stdout).text(),new Response(handle.stderr).text(),handle.exited]);return{exitCode,stdout,stderr};}finally{clearTimeout(forced);}
}
/** `contextRoot`: the machine's own keryx-managed Hub context cache (never inside the checkout). */
export interface TrialTarget{machine:string;machineId:string;checkoutId:string;cwd:string;configDir:string;machineRoot:string;hookLog:string;contextRoot:string;machinePolicyDigest:string;serve:ServeChild}
/** `candidate`: run every machine's serve from that absolute packaged executable instead of the checkout's source CLI. */
export async function startMachineTrial(options:{port?:number;root?:string;candidate?:string}={}){
 if(options.candidate!==undefined&&!path.isAbsolute(options.candidate))throw new Error('trial-candidate-not-absolute');
 // A darwin owner socket path must stay under 104 bytes, so the trial root is short and real (startup.test.ts does the same).
 const root=options.root??mkdtempSync(process.platform==='darwin'?'/private/tmp/keryx-serve-trial-':path.join(realpathSync(tmpdir()),'keryx-serve-trial-'));mkdirSync(root,{recursive:true,mode:0o700});const operatorToken=`trial-operator-${randomBytes(32).toString('base64url')}`;const reviewerToken=`trial-reviewer-${randomBytes(32).toString('base64url')}`;const agentToken=`trial-agent-${randomBytes(32).toString('base64url')}`;
 const provider=startLoopbackProvider();
 let hub=startHub({host:'127.0.0.1',port:options.port??0,dataDir:path.join(root,'hub'),operatorToken,reviewerToken,agentToken});const origin=hub.url.origin;
 async function request(route:string,body?:unknown,cookie?:string){const response=await fetch(`${origin}${route}`,{method:body===undefined?'GET':'POST',headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':randomUUID()})},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json() as Record<string,unknown>;if(!response.ok)throw new Error(`trial-http-${response.status}`);return{value,response};}
 const targets:TrialTarget[]=[];
 // Product code run here to write the synthetic installation (checkout mapping) also invokes git; keep it off the operator's git config.
 const previousGit={global:process.env.GIT_CONFIG_GLOBAL,system:process.env.GIT_CONFIG_NOSYSTEM};process.env.GIT_CONFIG_GLOBAL='/dev/null';process.env.GIT_CONFIG_NOSYSTEM='1';
 const restoreGit=()=>{for(const[key,value]of[['GIT_CONFIG_GLOBAL',previousGit.global],['GIT_CONFIG_NOSYSTEM',previousGit.system]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}};
 const stopAll=async()=>{const codes=await Promise.all(targets.map(t=>stopServeChild(t.serve)));await hub.stop(true);await provider.stop();restoreGit();return codes;};
 try{
  const login=await request('/hub/v1/session',{token:operatorToken});const cookie=login.response.headers.get('set-cookie')!.split(';')[0]!;const project=(await request('/hub/v1/projects',{name:'Deterministic two-process serve trial'},cookie)).value as {id:string;version:number};
  await request(`/hub/v1/projects/${project.id}/import`,{expectedVersion:project.version,sourceRevision:'deterministic-trial',documents:[{path:TRIAL_CONTEXT.path,kind:'wiki',content:TRIAL_CONTEXT.content}]},cookie);
  for(let i=1;i<=2;i++){
   // The hook log sits in the checkout's ignored .metaproject/: under the shipped untrusted profile a hook runs isolated and may write only there.
   const machine=`m${i}`,machineRoot=path.join(root,machine),cwd=path.join(machineRoot,'checkout'),env=scrubbedEnv(machineRoot),configDir=path.join(env.XDG_DATA_HOME!,'keryx'),hookLog=path.join(cwd,'.metaproject','trial-hook-events.jsonl');
   for(const dir of [cwd,env.HOME!,configDir,env.XDG_CONFIG_HOME!,env.XDG_CACHE_HOME!,env.XDG_STATE_HOME!,env.TMPDIR!])mkdirSync(dir,{recursive:true,mode:0o700});
   const git=(args:string[])=>{const r=Bun.spawnSync(['git','-C',cwd,'-c','user.name=Trial','-c','user.email=trial@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{env:gitEnv});if(r.exitCode!==0)throw new Error(`trial-git-failed: ${r.stderr.toString()}`);};
   // Production resolution requires a Keryx project checkout. Its index is tracked, as in a developer's project, so anything that rewrites it
   // (a context sync on connect) dirties the checkout; the rest of .metaproject/ is ignored local state (the hook log below).
   mkdirSync(path.join(cwd,'.metaproject'),{recursive:true});writeFileSync(path.join(cwd,'.metaproject','index.md'),TRIAL_INDEX);
   git(['init','-q']);writeFileSync(path.join(cwd,'seed.txt'),'deterministic native trial seed\n');writeFileSync(path.join(cwd,'.gitignore'),'.metaproject/*\n!.metaproject/index.md\n');git(['add','.']);git(['commit','-qm','trial baseline']);
   const hubId=hubIdentity(origin);const ledger=new MachineLedger(path.join(machineStateDir(configDir,hubId),'control.sqlite'));const pairing=(await request('/hub/v2/machines/pairings',{displayName:`Deterministic serve machine ${i}`,projectIds:[project.id]},cookie)).value as {code:string};const enrolled=await enrollMachine(origin,{code:pairing.code,agentVersion:'explicit-deterministic-trial',ledgerId:ledger.ledgerId});ledger.close();saveEnrollment(configDir,{hubUrl:origin,...enrolled});const checkoutId=`trial-checkout-${i}`;allowCheckout(configDir,{projectId:project.id,checkoutId,cwd,profileId:TRIAL_PROFILE});
   const candidateId=canonicalDigest([TRIAL_PROVIDER,TRIAL_MODEL]);
   const policy:Control['LocalMachinePolicy']={version:2,hubId,enabled:true,maxConcurrentRuns:2,checkouts:[{projectId:project.id,checkoutId,localBindingId:canonicalDigest([hubId,checkoutId]),path:realpathSync(cwd),profileIds:[TRIAL_PROFILE]}],allowAdHocSessions:true,allowedCandidateIds:[candidateId],profiles:[{profileId:TRIAL_PROFILE,allowAdHocTurns:true,consentVersion:1,allowedCandidateIds:[candidateId]}]};writeMachinePolicy(configDir,policy);
   saveShellConfig({provider:TRIAL_PROVIDER,model:TRIAL_MODEL,baseUrl:`${provider.origin}/${machine}`},configDir);
   const issued=issueServeToken(configDir);if(!issued.ok)throw new Error(`trial-serve-token: ${issued.reason}`);if(!saveServeConfig(defaultServeConfig(issued.record.id,{address:'127.0.0.1'}),configDir))throw new Error('trial-serve-config');
   // A user-scope observe hook: proof that the shipped hook runtime is on in the serve child, without changing any decision.
   mkdirSync(path.join(env.HOME!,'.keryx'),{recursive:true,mode:0o700});writeFileSync(path.join(env.HOME!,'.keryx','hooks.json'),JSON.stringify({schemaVersion:'1.0.0',hooks:{PreToolUse:[{id:'trial-observer',matcher:'.*',class:'observe',command:{argv:['/bin/sh','-c','/bin/cat >> "$KERYX_PROJECT_ROOT/.metaproject/trial-hook-events.jsonl"; echo >> "$KERYX_PROJECT_ROOT/.metaproject/trial-hook-events.jsonl"']}}]}}));
   const serve=await startServeChild(machineRoot,options.candidate);serve.serveToken=issued.token;
   targets.push({machine,machineId:enrolled.machineId,checkoutId,cwd:realpathSync(cwd),configDir,machineRoot,hookLog,contextRoot:path.join(machineStateDir(configDir,hubId),'context'),machinePolicyDigest:canonicalDigest(policy),serve});
  }
  const credentialsFile=path.join(root,'operator-token');protectedWrite(credentialsFile,operatorToken,true);
  let stopped:Promise<number[]>|undefined;
  return {root,origin,hubId:hubIdentity(origin),projectId:project.id,targets,credentialsFile,provider:{calls:provider.calls,unexpected:provider.unexpected},
   /** SIGKILL, like an out-of-memory kill or a power loss: serve drains nothing, so its daemon lock, leases and launch tombstones stay behind. */
   async crashServe(target:TrialTarget){process.kill(target.serve.pid,'SIGKILL');return target.serve.exited;},
   /** A fresh `keryx serve` for the same installation (same synthetic HOME/XDG and serve token); `target.serve` then names the new process. */
   async restartServe(target:TrialTarget){const token=target.serve.serveToken;target.serve=await startServeChild(target.machineRoot,options.candidate);target.serve.serveToken=token;return target.serve;},
   /** The operator's Ctrl-C on one machine; its exit code. */
   stopServe:(target:TrialTarget)=>stopServeChild(target.serve),
   /** An operator's own `keryx <args>` on that machine: the shipped CLI entry in the installation's environment, never an in-process call. */
   operator:(target:TrialTarget,args:string[])=>runOperatorCommand(target.machineRoot,args,options.candidate),
   /** Stops the Hub process and starts a replacement on the same port and data directory while every serve child keeps running. */
   async restartHub(between?:()=>Promise<void>|void){await hub.stop(true);await between?.();hub=startHub({host:'127.0.0.1',port:Number(new URL(origin).port),dataDir:path.join(root,'hub'),operatorToken,reviewerToken,agentToken});},
   stop(remove=false){stopped??=stopAll().then(codes=>{if(remove)rmSync(root,{recursive:true,force:true});return codes;});return stopped;}};
 }catch(cause){await stopAll();if(options.root===undefined)rmSync(root,{recursive:true,force:true});throw cause;}
}
if(import.meta.main){
 const value=process.argv[2];const trial=await startMachineTrial(value?{port:Number(value)}:{});console.log(JSON.stringify({kind:'trial-ready',root:trial.root,origin:trial.origin,projectId:trial.projectId,targets:trial.targets.map(({serve,...t})=>({...t,servePid:serve.pid,servePort:serve.servePort})),credentialsFile:trial.credentialsFile,mode:'deterministic-native-two-serve-processes-not-vendor-or-physical-machines'}));let stopping=false;const stop=()=>{if(stopping)return;stopping=true;void trial.stop().then(()=>process.exit(0));};process.on('SIGINT',stop);process.on('SIGTERM',stop);await new Promise(()=>{});
}
