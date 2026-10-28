import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MachineContextSync} from './context';
import {createOwnedWorkspace} from './workspace';
import {createSessionHost} from '../../session/host';
import {createNativeSessionRuntime} from '../../session/native-runtime';
import {scriptedProvider,callRound,okReply} from '../../commands/agent.test-helpers';
import {canonicalDigest,type Control} from '../../remote-control/protocol';

test('two actual native providers reread one validated shared cache after a canonical invalidation',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'machine-context-native-'));let revision=1,calls=0;const digest='a'.repeat(64);
 const server=Bun.serve({port:0,fetch(){calls++;const content=`Canonical native revision ${revision}`,contentDigest=createHash('sha256').update(content).digest('hex');return Response.json({revision,fullSnapshot:true,manifest:[{id:'doc',path:'wiki/source.md',kind:'wiki',version:revision,contentDigest}],documents:[{id:'doc',projectId:'p',path:'wiki/source.md',kind:'wiki',version:revision,contentDigest,content,approval:'accepted',sourceRevision:'source'}],deletedDocumentIds:[]});}});
 const hosts:Awaited<ReturnType<typeof createSessionHost>>[]=[];
 try{
  const mappings=['one','two'].map(checkoutId=>{const cwd=path.join(root,checkoutId);mkdirSync(path.join(cwd,'.metaproject'),{recursive:true});writeFileSync(path.join(cwd,'.metaproject','index.md'),'# Local project\n');return{projectId:'p',checkoutId,cwd,profileId:'native'};});
  const sync=new MachineContextSync({hubUrl:server.url.origin,token:'isolated-only',cacheRoot:path.join(root,'shared-cache'),mappings});await sync.initialize();
  const providers=[];
  for(const mapping of mappings){
   Bun.spawnSync(['git','init','-q',mapping.cwd]);Bun.spawnSync(['git','-C',mapping.cwd,'add','.']);expect(Bun.spawnSync(['git','-C',mapping.cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','fixture']).exitCode).toBe(0);
   const workspace=createOwnedWorkspace(mapping.cwd);const provider=scriptedProvider([callRound('read-one','hub_context','{"documentId":"doc"}'),okReply,callRound('read-two','hub_context','{"documentId":"doc"}'),okReply]);providers.push(provider);
   const record:Control['SessionRecord']={sessionId:`s-${mapping.checkoutId}`,projectId:'p',machineId:'m',checkoutId:mapping.checkoutId,agentProfileId:'native',version:1,historyVersion:1,state:'idle',title:'Canonical cache native fixture',config:{configVersion:1,baselineCandidateId:'scripted:m',reasoningEffort:'none',routing:{enabled:false,profileId:'local',candidateIds:['scripted:m'],fallbackCandidateId:'scripted:m'},policyDigest:digest,capabilityDigest:digest},controller:{controllerLeaseId:'controller',sessionId:`s-${mapping.checkoutId}`,version:1,actorId:'human',actorKind:'human-operator',expiresAt:new Date(Date.now()+60000).toISOString(),state:'held'},activeRunId:null,activeTurnId:null,nextTurnOrdinal:1,historyCursor:0,sessionEventCursor:0,queueVersion:0,workspaceBaseline:workspace.baseline().digest,forkedFromSessionId:null,capabilities:{literalText:true,attachments:false,attachmentReason:'typed-artifact-contract-required',commandCatalogue:true,modelRouting:true}};
   const runtime=createNativeSessionRuntime({cwd:mapping.cwd,provider:provider.provider,providerId:'scripted',modelId:'m'});
   hosts.push(await createSessionHost({cwd:mapping.cwd,dataDir:path.join(root,`native-${mapping.checkoutId}`),record,runtime,workspace,authorizeAction:async()=>true,inspectionMode:'hub-remote',projectContext:{source:'hub-canonical',listFlows:async()=>[],readFlow:async()=>null,readContext:id=>sync.read('p',id)}}));
  }
  async function turn(index:number,ordinal:number){const host=hosts[index]!,current=await host.inspect(),operationId=`context-${index}-${ordinal}`;const request:Control['StartTurnRequest']={sessionId:current.sessionId,expectedSessionVersion:current.version,controller:{controllerLeaseId:'controller',expectedControllerVersion:1},expectedConfigVersion:1,expectedHistoryVersion:current.historyVersion,expectedWorkspaceBaseline:current.workspaceBaseline,association:{mode:'ad-hoc',profileConsentVersion:1},messageId:operationId,text:'Read canonical document through the scoped tool'};expect((await host.apply({kind:'message',operationId,payloadDigest:canonicalDigest(request),actorId:'human',runId:`r-${operationId}`,turnId:`t-${operationId}`,request})).status).toBe('admitted');for(let n=0;n<200;n++){if((await host.inspect()).state==='idle')return;await Bun.sleep(5);}throw new Error('native context turn did not finish');}
  await turn(0,1);await turn(1,1);for(const provider of providers)expect(JSON.stringify(provider.requests.at(-1))).toContain('Canonical native revision 1');
  revision=2;await Promise.all([sync.invalidate('p',2),sync.invalidate('p',2)]);expect(calls).toBe(2);
  await turn(0,2);await turn(1,2);for(const provider of providers){expect(JSON.stringify(provider.requests.at(-1))).toContain('Canonical native revision 2');expect(provider.requests).toHaveLength(4);expect(provider.requests[0]!.tools?.some(tool=>tool.name.startsWith('flow_'))).toBe(false);}
 }finally{for(const host of hosts)await host.dispose('test');server.stop(true);rmSync(root,{recursive:true,force:true});}
});
