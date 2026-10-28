import { expect, test } from 'bun:test';
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveProductionMachineProfile } from './production';
import type { NativeCommandContribution } from '../../session/commands/handlers';
test('production profile never supplies an executor for absent provider, unsupported profile or incomplete parity',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'machine-production-'));
 try{for(const profileId of ['native','remote-restricted','remote-read-only']){const result=await resolveProductionMachineProfile({projectId:'p',checkoutId:'c',cwd:dir,profileId},{configDir:dir,allowedCandidateIds:[]});expect(result.ok).toBe(false);if(!result.ok)expect(['provider-setup','local-policy','adapter-unsupported','containment-missing']).toContain(result.error.code);}}finally{rmSync(dir,{recursive:true,force:true});}
});
test('production routing exposes closed wire aliases for slash model IDs while retaining the consented candidate identity',async()=>{
 const{createLocalMachineRouting}=await import('./production');const{validateControl,canonicalDigest}=await import('../../remote-control/protocol');const provider='openrouter',model='anthropic/claude-sonnet-4.5',d='a'.repeat(64);const routing=createLocalMachineRouting(provider,model,d,d);expect(validateControl('RoutingAvailability',routing).ok).toBe(true);expect(routing.candidates[0]!.candidateId).toBe(canonicalDigest([provider,model]));expect(routing.candidates[0]!.modelId).not.toContain('/');
});
test('the readiness gate still refuses a catalogue listing any implementation gap, and the shipped machine catalogue lists none',async()=>{
 const{catalogueImplementationGaps,createMachineCommandCatalogue}=await import('./production');const d='a'.repeat(64);
 expect(catalogueImplementationGaps(createMachineCommandCatalogue(d))).toEqual([]);
 const unimplemented:NativeCommandContribution={entry:{commandName:'fixture.unimplemented',summary:'A required domain operation with no owner',handlerId:'native.fixture.unimplemented',inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},resultSchema:{type:'string',maxLength:32768},
  mutationClass:'read',states:['idle'],busyPolicy:'read-only',confirmation:'none',availability:'implementation-gap',reason:'owner-not-implemented'},execute:async()=>null};
 expect(catalogueImplementationGaps(createMachineCommandCatalogue(d,[unimplemented]))).toEqual(['fixture.unimplemented']);
});
test('a production profile publishes exactly the catalogue its bridge-composed host enforces: same entries, same digest',async()=>{
 const{canonicalDigest}=await import('../../remote-control/protocol');const{saveShellConfig}=await import('../shell-config');const{createOwnedWorkspace}=await import('./workspace');const{createSessionHost}=await import('../../session/host');
 const root=mkdtempSync(path.join(tmpdir(),'machine-production-catalogue-'));const cwd=path.join(root,'checkout'),configDir=path.join(root,'config');
 const git=(...args:string[])=>Bun.spawnSync(['git','-C',cwd,'-c','user.name=Fixture','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
 let host:Awaited<ReturnType<typeof createSessionHost>>|undefined;
 try{
  mkdirSync(path.join(cwd,'.metaproject'),{recursive:true});writeFileSync(path.join(cwd,'.metaproject','index.md'),'# Fixture\n');expect(git('init','-q').exitCode).toBe(0);git('add','.');expect(git('commit','-qm','fixture').exitCode).toBe(0);
  // A configured local endpoint the profile may name; no request reaches it, nothing here runs a turn.
  saveShellConfig({provider:'ollama',model:'fixture-model',baseUrl:'http://127.0.0.1:9'},configDir);const candidateId=canonicalDigest(['ollama','fixture-model']);
  const resolved=await resolveProductionMachineProfile({projectId:'p',checkoutId:'c',cwd,profileId:'remote-read-only'},{configDir,allowedCandidateIds:[candidateId]});
  if(!resolved.ok)throw new Error(resolved.error.code);const profile=resolved.value;const runtime=await profile.createRuntime('session');if(!runtime.ok)throw new Error(runtime.error.code);
  // The host exactly as the machine bridge composes it (bridge.ts materializeRecord): a lifecycle port and the owned rewind workspace.
  const workspace=createOwnedWorkspace(cwd);const refused={ok:false as const,error:{code:'authorization-not-applied',message:'authorization-not-applied'}};
  host=await createSessionHost({cwd,dataDir:path.join(root,'data'),configDir,runtime:runtime.value,inspectionMode:'hub-remote',lifecycle:{apply:async()=>refused,list:async()=>refused,open:async()=>refused},
   record:{sessionId:'session',projectId:'p',machineId:'m',checkoutId:'c',agentProfileId:'remote-read-only',version:1,historyVersion:1,state:'idle',title:'Catalogue',config:{configVersion:1,baselineCandidateId:candidateId,reasoningEffort:'none',routing:{enabled:false,profileId:'local',candidateIds:[candidateId],fallbackCandidateId:candidateId},policyDigest:profile.policyDigest,capabilityDigest:profile.capabilityDigest},
    controller:null,activeRunId:null,activeTurnId:null,nextTurnOrdinal:1,historyCursor:0,sessionEventCursor:0,queueVersion:0,workspaceBaseline:workspace.baseline().digest,forkedFromSessionId:null,capabilities:{literalText:true,attachments:false,attachmentReason:'typed-artifact-contract-required',commandCatalogue:true,modelRouting:true}},
   workspace:{...workspace,rewind:{ownership:()=>({nonce:'nonce',gitHead:workspace.baseline().head,paths:Object.keys(workspace.baseline().files)}),validatePaths:async()=>{}}}});
  const enforced=await host.catalogue();
  // Every Hub-delivered CommandInvoke carries the published digest; the host refuses any other as stale-catalogue.
  expect(enforced.entries.filter((entry,index)=>JSON.stringify(entry)!==JSON.stringify(profile.catalogue.entries[index])).map(entry=>entry.commandName)).toEqual([]);
  expect(enforced).toEqual(profile.catalogue);
 }finally{await host?.dispose('test');rmSync(root,{recursive:true,force:true});}
});
