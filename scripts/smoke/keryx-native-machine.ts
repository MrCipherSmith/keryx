/** Production assembly smoke against a local synthetic provider HTTP protocol.
 * No providerFactory injection, vendor key, TUI, or readiness claim.
 * bun scripts/smoke/keryx-native-machine.ts [--child <isolated-directory> <loopback-origin>]
 */
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.argv[2] === '--child') {
  const directory=process.argv[3]!, origin=process.argv[4]!, candidate=process.argv[5]!;
  if(await realpath(Bun.which('keryx')??'')!==await realpath(candidate))throw new Error('Hook launcher must resolve exact isolated candidate');
  if(!directory||new URL(origin).hostname!=='127.0.0.1'||process.stdin.isTTY)throw new Error('Isolated non-TTY loopback smoke required');
  const {resolveKeryxArgv}=await import('../../src/harness/hooks/builtins');
  const hookArgv=resolveKeryxArgv(['keryx','security','check-input']);
  if(await realpath(Bun.which(hookArgv[0]!)??hookArgv[0]!)!==await realpath(candidate))throw new Error('Actual builtin hook argv escaped candidate installation');
  if(process.env.KERYX_HOOKS==='off')throw new Error('Production smoke must keep hooks enabled');
  const {saveShellConfig}=await import('../../src/lib/shell-config');
  const {resolveLocalProfile}=await import('../../src/harness/policy/profiles');
  const {assembleNativeSessionRuntime}=await import('../../src/session/native-runtime-production');
  const {createSessionHost}=await import('../../src/session/host');
  const {canonicalDigest}=await import('../../src/remote-control/protocol');
  type Control=import('../../src/remote-control/protocol').Control;
  saveShellConfig({provider:'ollama',model:'llama3.1:latest',baseUrl:origin},directory);
  const profile=resolveLocalProfile('read-only-review');const digest=canonicalDigest(profile);
  const runtime=await assembleNativeSessionRuntime({cwd:directory,configDir:directory,sessionId:'package-session',profile,providerId:'ollama',modelId:'llama3.1:latest',allowedTools:['read_file'],maxToolCalls:4,maxRounds:4});
  if(!runtime.ok)throw new Error('Actual native assembly refused: '+runtime.error.code);
  const binding=runtime.value.modelBindings()[0]!;
  const config:Control['SessionConfig']={configVersion:1,baselineCandidateId:'local',reasoningEffort:'none',routing:{enabled:false,profileId:'local',candidateIds:['local'],fallbackCandidateId:'local'},policyDigest:digest,capabilityDigest:digest};
  const record:Control['SessionRecord']={sessionId:'package-session',projectId:'project',machineId:'machine',checkoutId:'checkout',agentProfileId:'native',version:1,historyVersion:1,state:'idle',title:'Production package smoke',config,controller:{controllerLeaseId:'controller',sessionId:'package-session',version:1,actorId:'human',actorKind:'human-operator',expiresAt:new Date(Date.now()+60000).toISOString(),state:'held'},activeRunId:null,activeTurnId:null,nextTurnOrdinal:1,historyCursor:0,sessionEventCursor:0,queueVersion:0,workspaceBaseline:digest,forkedFromSessionId:null,capabilities:{literalText:true,attachments:false,attachmentReason:'typed-artifact-contract-required',commandCatalogue:true,modelRouting:true}};
  // Actual native provider/model identity and local availability; no remote arbitrary executable.
  const routing=runtime.value.routing(config).availability();
  config.baselineCandidateId=routing.candidates.find(c=>c.providerId===binding.providerId&&c.modelId===binding.modelId)!.candidateId;
  config.routing.candidateIds=[config.baselineCandidateId];config.routing.fallbackCandidateId=config.baselineCandidateId;
  const host=await createSessionHost({cwd:directory,dataDir:join(directory,'host'),record,runtime:runtime.value,workspace:{verify:async()=>({ok:true,baseline:digest}),checkpoint:async()=>({ok:true,baseline:digest})},authorizeAction:async()=>true});
  let terminal='',terminalReason='',progress='';const off=host.subscribeTurnOutcome(event=>{if(event.kind==='progress')progress=(progress+' '+event.text).slice(-4096);if(event.kind==='terminal'){terminal=event.outcome;terminalReason=event.reason;}});
  try{const request:Control['StartTurnRequest']={sessionId:record.sessionId,expectedSessionVersion:1,expectedConfigVersion:1,expectedHistoryVersion:1,expectedWorkspaceBaseline:digest,controller:{controllerLeaseId:'controller',expectedControllerVersion:1},association:{mode:'ad-hoc',profileConsentVersion:1},messageId:'read-seed',text:'Read seed.txt and report the exact marker.'};
    const receipt=await host.apply({kind:'message',operationId:'read-seed',payloadDigest:canonicalDigest(request),actorId:'human',runId:'package-run',turnId:'package-turn',request});if(receipt.status!=='admitted')throw new Error('Actual native turn was not admitted');
    const deadline=Date.now()+15000;while(!terminal&&Date.now()<deadline)await Bun.sleep(10);if(terminal!=='succeeded')throw new Error('Native turn terminal: '+terminal+' ('+terminalReason+'): '+progress);
    console.log('PASS: exact isolated candidate hook launcher, production makeProvider/HTTP adapter, native host, read_file registry, non-TTY turn succeeded');
  }finally{off();await host.dispose();}
}else{
  const candidate=process.argv[2]==='--candidate'?process.argv[3]:undefined;
  if(!candidate||!candidate.startsWith('/'))throw new Error('Usage: native smoke --candidate /absolute/isolated/bin/keryx (full installed candidate required)');
  const directory=await mkdtemp(join(tmpdir(),'keryx-native-package-'));let calls=0,toolResultSeen=false;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    if(new URL(request.url).pathname!=='/v1/chat/completions')return new Response('Unexpected provider route',{status:400});
    const body=await request.json() as {messages:{role:string;content?:unknown}[]};calls++;
    const marker='PACKAGE_NATIVE_MARKER';
    if(calls===2){toolResultSeen=body.messages.some(message=>message.role==='tool'&&JSON.stringify(message.content).includes(marker));if(!toolResultSeen)return new Response('Missing actual read_file result',{status:400});}
    const delta=calls===1?{role:'assistant',tool_calls:[{index:0,id:'read-seed',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'seed.txt'})}}]}:{role:'assistant',content:marker};
    return new Response('data: '+JSON.stringify({id:'smoke-'+calls,choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'smoke-'+calls,choices:[{index:0,delta:{},finish_reason:calls===1?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  }});
  try{await mkdir(join(directory,'.metaproject'));await writeFile(join(directory,'.metaproject/index.md'),'# Isolated package smoke\n');await writeFile(join(directory,'seed.txt'),'PACKAGE_NATIVE_MARKER\n');
    const command=process.execPath.endsWith('/bun')?[process.execPath,import.meta.path,'--child',directory,server.url.origin,candidate]:[process.execPath,'--child',directory,server.url.origin,candidate];
    const child=Bun.spawn(command,{env:{PATH:join(candidate,'..')+':/usr/local/bin:/usr/bin:/bin',HOME:directory,TMPDIR:directory,KERYX_CONFIG_DIR:directory},stdin:'ignore',stdout:'inherit',stderr:'inherit'});const timeout=setTimeout(()=>child.kill('SIGKILL'),20000);try{if(await child.exited!==0)throw new Error('Production native package smoke failed; provider HTTP calls='+calls);}finally{clearTimeout(timeout);}if(calls!==2||!toolResultSeen)throw new Error('Production tool/model sequence incomplete');
  }finally{server.stop(true);await rm(directory,{recursive:true,force:true});}
}
