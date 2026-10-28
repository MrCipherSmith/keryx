import{expect,test}from'bun:test';import{lstatSync,readFileSync,rmSync}from'node:fs';import path from'node:path';
import{startMachineTrial,SERVE_ENTRY,TRIAL_PROFILE,supervisedMarker,trialTurn,type TrialTarget}from'./trial.test-support';
import{canonicalDigest,type Control,type FrameOf}from'../../remote-control/protocol';import{createMachineCommandCatalogue}from'./production';import{localControlPath}from'./local-control';import{resolveRemoteProfile}from'../../harness/policy/profiles';
type Trial=Awaited<ReturnType<typeof startMachineTrial>>;type RunEvent=FrameOf<'run-event'>['payload'];
type Inventory={connected:boolean;inventory:{inventoryVersion:number;checkouts:{checkoutId:string;headSha:string;agentProfiles:{profileId:string;adapter:string;readiness:string;reason:string;capabilityDigest:string;policyDigest:string}[]}[]}|null};
/** Production resolution refuses a profile with `adapter-unsupported` while the shipped command catalogue still lists an implementation gap. */
const catalogueGaps=createMachineCommandCatalogue(canonicalDigest([])).entries.filter(entry=>entry.availability==='implementation-gap').map(entry=>entry.commandName);
function hubClient(trial:Trial){
 let cookie='';
 const raw=async(route:string,body?:unknown)=>{const response=await fetch(`${trial.origin}${route}`,{method:body===undefined?'GET':'POST',headers:{Origin:trial.origin,...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()})},...(body===undefined?{}:{body:JSON.stringify(body)})});if(route==='/hub/v1/session'&&response.ok)cookie=response.headers.get('set-cookie')!.split(';')[0]!;return{status:response.status,data:await response.json() as unknown};};
 const call=async<T>(route:string,body?:unknown):Promise<T>=>{const result=await raw(route,body);expect(result).toMatchObject({status:200});return result.data as T;};
 // A timeout names what each serve child said, so a stuck run is diagnosable from the failure alone.
 const children=()=>JSON.stringify({serve:trial.targets.map(t=>({machine:t.machine,stdout:t.serve.stdout.slice(-12),stderr:t.serve.stderr.slice(-12)})),provider:trial.provider});
 const wait=async<T>(read:()=>Promise<T>,done:(v:T)=>boolean,ms=20000)=>{const deadline=Date.now()+ms;for(;;){const v=await read();if(done(v))return v;if(Date.now()>deadline)throw new Error(`trial-timeout: ${JSON.stringify(v).slice(0,2000)} ${children().slice(0,6000)}`);await Bun.sleep(20);}};
 return{raw,call,wait,login:()=>call('/hub/v1/session',{token:readFileSync(trial.credentialsFile,'utf8')})};
}
const processCommand=(pid:number)=>Bun.spawnSync(['ps','-o','command=','-p',String(pid)]).stdout.toString().trim();
const processesWith=(marker:string)=>Bun.spawnSync(['ps','-axo','pid=,command=']).stdout.toString().split('\n').filter(line=>line.includes(marker));
const notices=(target:TrialTarget)=>target.serve.stdout.flatMap(line=>{const m=/Hub machine: ([a-z0-9-]+)/.exec(line);return m?[m[1]!]:[];});

test('two keryx serve processes start their machine bridges through the shipped startup path and production profile resolution',async()=>{
 const trial=await startMachineTrial();try{
 const hub=hubClient(trial);await hub.login();
 expect(trial.targets).toHaveLength(2);expect(new Set(trial.targets.map(t=>t.serve.pid)).size).toBe(2);expect(new Set(trial.targets.map(t=>t.configDir)).size).toBe(2);
 for(const target of trial.targets){
  // The child is the shipped CLI entry running `serve`, never a test-support host constructing MachineBridge directly.
  expect(target.serve.argv.slice(1)).toEqual(['--no-env-file','--config=/dev/null',SERVE_ENTRY,'serve','--port','0']);
  const command=processCommand(target.serve.pid);expect(command).toContain(`${SERVE_ENTRY} serve --port 0`);expect(command).not.toContain('trial.test-support');
  // Serve-only startup: its own authenticated loopback listener answers from that process, and startConfiguredMachineBridges published the owner socket.
  expect((await fetch(`http://127.0.0.1:${target.serve.servePort}/v1/status`,{headers:{Authorization:`Bearer ${target.serve.serveToken}`}})).status).toBe(200);
  expect((await fetch(`http://127.0.0.1:${target.serve.servePort}/v1/status`)).status).toBe(401);expect((await fetch(`http://127.0.0.1:${target.serve.servePort}/v1/status`,{headers:{Authorization:`Bearer ${trial.targets.find(t=>t!==target)!.serve.serveToken}`}})).status).toBe(401);
  expect(lstatSync(localControlPath(target.configDir)).mode&0o777).toBe(0o600);
  // The serve-owned bridge reached the Hub over its WebSocket transport and published the mapped checkout as production resolution decided it.
  const machine=await hub.wait(()=>hub.call<Inventory>(`/hub/v2/machines/${target.machineId}`),v=>v.connected&&v.inventory!==null);
  const checkout=machine.inventory!.checkouts.find(c=>c.checkoutId===target.checkoutId)!;expect(checkout.agentProfiles).toHaveLength(1);
  if(catalogueGaps.length>0){
   expect(checkout.agentProfiles[0]).toEqual({profileId:TRIAL_PROFILE,adapter:'keryx-native-v1',readiness:'setup-required',reason:'adapter-unsupported',capabilityDigest:canonicalDigest([]),policyDigest:target.machinePolicyDigest});
   // A Hub session is refused end to end: nothing starts on a checkout production resolution did not make ready.
   const profile=checkout.agentProfiles[0]!;expect(await hub.raw(`/hub/v2/projects/${trial.projectId}/sessions`,{machineId:target.machineId,checkoutId:target.checkoutId,agentProfileId:TRIAL_PROFILE,expectedInventoryVersion:machine.inventory!.inventoryVersion,expectedHeadSha:checkout.headSha,capabilityDigest:profile.capabilityDigest,policyDigest:profile.policyDigest,title:'Refused on an unready profile'})).toMatchObject({status:409,data:{error:{code:'stale-reference'}}});
  }else expect(checkout.agentProfiles[0]).toMatchObject({profileId:TRIAL_PROFILE,adapter:'keryx-native-v1',readiness:'ready',reason:'none',policyDigest:canonicalDigest(resolveRemoteProfile(TRIAL_PROFILE))});
  expect(notices(target)).toEqual([]);
 }
 if(catalogueGaps.length>0)expect(trial.provider.calls).toEqual([]);
 // Ctrl-C drains through serve itself: the bridges and the owner socket go before the listener, and the process exits cleanly.
 expect(await trial.stop()).toEqual([0,0]);
 for(const target of trial.targets){expect(target.serve.stdout.some(line=>/\bstopped\b/.test(line))).toBe(true);expect(()=>lstatSync(localControlPath(target.configDir))).toThrow();}
 }finally{await trial.stop();rmSync(trial.root,{recursive:true,force:true});}
},60000);

test.skipIf(catalogueGaps.length>0)(`two serve machines run a real tool turn and a real supervised cancellation on production profiles${catalogueGaps.length>0?` (pending P3: production resolution refuses adapter-unsupported while the catalogue lists ${catalogueGaps.join(', ')})`:''}`,async()=>{
 const trial=await startMachineTrial();try{
 const hub=hubClient(trial);await hub.login();expect(trial.targets).toHaveLength(2);
 const calls=(target:TrialTarget,ordinal:number)=>trial.provider.calls.filter(c=>c.machine===target.machine&&c.ordinal===ordinal).map(({reply,toolName})=>toolName?{reply,toolName}:{reply});
 for(const target of trial.targets){
  const metadata=await hub.wait(()=>hub.call<Inventory>(`/hub/v2/machines/${target.machineId}`),v=>v.connected&&v.inventory?.checkouts.some(c=>c.checkoutId===target.checkoutId&&c.agentProfiles[0]?.readiness==='ready')===true);
  const checkout=metadata.inventory!.checkouts.find(c=>c.checkoutId===target.checkoutId)!,profile=checkout.agentProfiles[0]!;expect(profile.policyDigest).toBe(canonicalDigest(resolveRemoteProfile(TRIAL_PROFILE)));
  const created=await hub.call<Control['SessionOperationReceipt']>(`/hub/v2/projects/${trial.projectId}/sessions`,{machineId:target.machineId,checkoutId:target.checkoutId,agentProfileId:TRIAL_PROFILE,expectedInventoryVersion:metadata.inventory!.inventoryVersion,expectedHeadSha:checkout.headSha,capabilityDigest:profile.capabilityDigest,policyDigest:profile.policyDigest,title:'Two-process serve proof'});
  const base=`/hub/v2/projects/${trial.projectId}/sessions/${created.sessionId}`,runs=`/hub/v2/projects/${trial.projectId}/runs`;
  const idle=()=>hub.wait(()=>hub.call<Control['SessionRecord']>(base),s=>s.state==='idle');
  const initial=await idle();const claim=await hub.call<Control['ControllerReceipt']>(`${base}/controller/claim`,{expectedSessionVersion:initial.version,expectedControllerVersion:0,requestedLeaseSeconds:60,mode:'claim'});
  await hub.wait(()=>hub.call<Control['SessionRecord']>(base),s=>s.controller?.controllerLeaseId===claim.lease.controllerLeaseId&&s.sessionEventCursor>=initial.sessionEventCursor+2);const controller={controllerLeaseId:claim.lease.controllerLeaseId,expectedControllerVersion:claim.lease.version};
  const send=async(ordinal:number,text:string)=>{const session=await idle();const receipt=await hub.call<Control['TurnReceipt']>(`${base}/messages`,{expectedSessionVersion:session.version,expectedConfigVersion:session.config.configVersion,controller,text:trialTurn(ordinal,text),interpretation:'literal-message',busyPolicy:'enqueue',association:{mode:'ad-hoc',profileConsentVersion:1}});expect(receipt.status).toBe('admitted');if(receipt.runId===null)throw new Error('trial-turn-without-run');return{runId:receipt.runId};};
  const events=(runId:string)=>hub.call<{events:RunEvent[]}>(`${runs}/${runId}/events`);
  const approveOnce=async(runId:string)=>{const page=await hub.wait(()=>events(runId),p=>p.events.some(e=>e.kind==='approval-request'));const question=page.events.find((e):e is Extract<RunEvent,{kind:'approval-request'}>=>e.kind==='approval-request')!;const current=await hub.wait(()=>hub.call<{version:number;state:string}>(`${runs}/${runId}`),r=>r.state==='waiting-approval');const session=await hub.call<Control['SessionRecord']>(base);
   await hub.call(`${runs}/${runId}/approvals/${question.approvalId}/answer`,{expectedRunVersion:current.version,expectedSessionVersion:session.version,controller,actionFingerprint:question.actionFingerprint,policyDigest:question.policyDigest,decision:'allow-once'});};
  // A real approved patch written by the production runtime in this serve child, from one tool round and one final round.
  const patch=await send(1,'write an approved native patch');await approveOnce(patch.runId);
  await hub.wait(()=>hub.call<{state:string;result?:Control['ResultReceipt']}>(`${runs}/${patch.runId}`),r=>r.state==='succeeded'&&r.result?.checksKind==='RunChecks');
  expect(readFileSync(path.join(target.cwd,'trial-edit-1.txt'),'utf8')).toBe('deterministic native edit 1\n');expect(calls(target,1)).toEqual([{reply:'tool',toolName:'apply_patch'},{reply:'text'}]);
  // A real read tool needs no approval under the shipped profile.
  const read=await send(2,'read seed.txt');await hub.wait(()=>hub.call<{state:string}>(`${runs}/${read.runId}`),r=>r.state==='succeeded');
  const readEvents=await events(read.runId);expect(readEvents.events.some(e=>e.kind==='log'&&e.text.includes('read_file'))).toBe(true);expect(readEvents.events.some(e=>e.kind==='approval-request')).toBe(false);expect(calls(target,2)).toEqual([{reply:'tool',toolName:'read_file'},{reply:'text'}]);
  // A real supervised shell child: it is visible as an OS process while the run waits, and the Hub cancel stops it.
  const sleeper=await send(3,'cancel supervised sleep work');await approveOnce(sleeper.runId);const marker=supervisedMarker(target.machine,3);
  await hub.wait(async()=>processesWith(marker),found=>found.length>0);
  const running=await hub.call<{version:number}>(`${runs}/${sleeper.runId}`),session=await hub.call<Control['SessionRecord']>(base);
  await hub.call(`${runs}/${sleeper.runId}/cancel`,{expectedRunVersion:running.version,expectedSessionVersion:session.version,controller,reason:'Stop the supervised trial sleep'});
  await hub.wait(()=>hub.call<{state:string}>(`${runs}/${sleeper.runId}`),r=>r.state==='cancelled');await hub.wait(async()=>processesWith(marker),found=>found.length===0,5000);
  expect(calls(target,3)).toEqual([{reply:'tool',toolName:'shell_exec'}]);
  // Hooks are on in the shipped composition: the user-scope observer saw every tool call this serve child made.
  const hooks=readFileSync(target.hookLog,'utf8');for(const tool of ['apply_patch','read_file','shell_exec'])expect(hooks).toContain(`"keryxToolName":"${tool}"`);
  expect(notices(target)).toEqual([]);
 }
 }finally{await trial.stop();rmSync(trial.root,{recursive:true,force:true});}
},120000);
