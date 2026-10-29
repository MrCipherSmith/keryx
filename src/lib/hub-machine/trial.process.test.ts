import{expect,test}from'bun:test';import{existsSync,lstatSync,readFileSync,readdirSync,rmSync,writeFileSync}from'node:fs';import path from'node:path';
import{startMachineTrial,ledgerDiagnosis,SERVE_ENTRY,TRIAL_CONTEXT,TRIAL_INDEX,TRIAL_PROFILE,supervisedMarker,trialTurn,type TrialTarget}from'./trial.test-support';
import{hubCommandReceipt,hubSessionPending}from'../../hub/remote-v2/fixture.test-support';
import{canonicalDigest,type Control,type FrameOf}from'../../remote-control/protocol';import{createMachineCommandCatalogue}from'./production';import{localControlPath}from'./local-control';import{resolveRemoteProfile}from'../../harness/policy/profiles';import{detectSandboxLauncher}from'../../harness/process/sandbox/detect';
type Trial=Awaited<ReturnType<typeof startMachineTrial>>;type RunEvent=FrameOf<'run-event'>['payload'];
type Inventory={connected:boolean;inventory:{inventoryVersion:number;checkouts:{checkoutId:string;headSha:string;clean:boolean;available:boolean;agentProfiles:{profileId:string;adapter:string;readiness:string;reason:string;capabilityDigest:string;policyDigest:string}[]}[]}|null};
/** Production resolution refuses a profile with `adapter-unsupported` while the shipped command catalogue still lists an implementation gap. */
const catalogueGaps=createMachineCommandCatalogue(canonicalDigest([])).entries.filter(entry=>entry.availability==='implementation-gap').map(entry=>entry.commandName);
/**
 * The trial serves the production `remote-restricted` profile, whose isolation is required-fail-closed: production resolution
 * reports it `containment-missing` on a host without the platform sandbox launcher (sandbox-exec on macOS, bwrap on Linux), so no
 * session can start. These tests skip only there; the macOS real-host CI job runs this file with zero skips.
 */
const launcher=detectSandboxLauncher();const needsSandbox=launcher.available?'':` (skipped: production profiles need the OS sandbox launcher; ${launcher.reason})`;
function hubClient(trial:Trial){
 let cookie='';
 const raw=async(route:string,body?:unknown)=>{const response=await fetch(`${trial.origin}${route}`,{method:body===undefined?'GET':'POST',headers:{Origin:trial.origin,...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()})},...(body===undefined?{}:{body:JSON.stringify(body)})});if(route==='/hub/v1/session'&&response.ok)cookie=response.headers.get('set-cookie')!.split(';')[0]!;return{status:response.status,data:await response.json() as unknown};};
 const call=async<T>(route:string,body?:unknown):Promise<T>=>{const result=await raw(route,body);expect(result).toMatchObject({status:200});return result.data as T;};
 // A timeout names what each serve child said and what its ledger holds unresolved or recorded as a refusal (code and reason token), so
 // a stuck run is diagnosable from the failure alone even where a notice only says recovery-required.
 const children=()=>JSON.stringify({serve:trial.targets.map(t=>({machine:t.machine,stdout:t.serve.stdout.slice(-12),stderr:t.serve.stderr.slice(-12),ledger:ledgerDiagnosis(t,trial.hubId)})),provider:trial.provider});
 const wait=async<T>(read:()=>Promise<T>,done:(v:T)=>boolean,ms=20000)=>{const deadline=Date.now()+ms;for(;;){const v=await read();if(done(v))return v;if(Date.now()>deadline)throw new Error(`trial-timeout: ${JSON.stringify(v).slice(0,2000)} ${children().slice(0,10000)}`);await Bun.sleep(20);}};
 return{raw,call,wait,login:()=>call('/hub/v1/session',{token:readFileSync(trial.credentialsFile,'utf8')})};
}
const processCommand=(pid:number)=>Bun.spawnSync(['ps','-o','command=','-p',String(pid)]).stdout.toString().trim();
const processesWith=(marker:string)=>Bun.spawnSync(['ps','-axo','pid=,command=']).stdout.toString().split('\n').filter(line=>line.includes(marker));
/** The process group of the supervised shell carrying `marker`, which the native runtime starts as its own group leader. */
const processGroup=(marker:string)=>{const line=Bun.spawnSync(['ps','-axo','pgid=,command=']).stdout.toString().split('\n').find(l=>l.includes(marker));return line===undefined?undefined:Number(line.trim().split(/\s+/)[0]);};
const killGroup=(marker:string)=>{const pgid=processGroup(marker);if(pgid!==undefined){try{process.kill(-pgid,'SIGKILL');}catch{/* The group is already gone. */}}};
const notices=(target:TrialTarget)=>target.serve.stdout.flatMap(line=>{const m=/Hub machine: ([a-z0-9-]+)/.exec(line);return m?[m[1]!]:[];});
/** The developer's own git in a trial checkout, off the operator's git config and hooks. */
const git=(target:TrialTarget,args:string[])=>{const r=Bun.spawnSync(['git','-C',target.cwd,'-c','user.name=Trial developer','-c','user.email=trial@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});expect(r.exitCode).toBe(0);return r.stdout.toString().trim();};
/** The developer-visible checkout: its tracked index bytes and git's porcelain status (the trial's .metaproject/ local state is ignored). */
const checkoutState=(target:TrialTarget)=>({index:readFileSync(path.join(target.cwd,'.metaproject','index.md'),'utf8'),status:Bun.spawnSync(['git','-C',target.cwd,'status','--porcelain=v1','--untracked-files=all'],{env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}).stdout.toString()});
/** The shared context the serve machine synced on connect, read from its own keryx-managed cache. */
function syncedContext(target:TrialTarget):{revision:number;documents:{path:string;content:string}[]}{
 const caches=existsSync(target.contextRoot)?readdirSync(target.contextRoot).map(dir=>path.join(target.contextRoot,dir,'context.json')).filter(file=>existsSync(file)):[];
 expect(caches).toHaveLength(1);return JSON.parse(readFileSync(caches[0]!,'utf8')) as {revision:number;documents:{path:string;content:string}[]};
}
type RunRecord={state:string;version:number;lastLocalSeq:number;result?:Control['ResultReceipt'];connected?:boolean};
/** An ad-hoc session on `target` once production resolution made its profile ready, with the controller claimed by the human operator. */
async function controlledSession(trial:Trial,hub:ReturnType<typeof hubClient>,target:TrialTarget,title:string){
 const metadata=await hub.wait(()=>hub.call<Inventory>(`/hub/v2/machines/${target.machineId}`),v=>v.connected&&v.inventory?.checkouts.some(c=>c.checkoutId===target.checkoutId&&c.agentProfiles[0]?.readiness==='ready')===true);
 const checkout=metadata.inventory!.checkouts.find(c=>c.checkoutId===target.checkoutId)!,profile=checkout.agentProfiles[0]!;expect(profile.policyDigest).toBe(canonicalDigest(resolveRemoteProfile(TRIAL_PROFILE)));
 const created=await hub.call<Control['SessionOperationReceipt']>(`/hub/v2/projects/${trial.projectId}/sessions`,{machineId:target.machineId,checkoutId:target.checkoutId,agentProfileId:TRIAL_PROFILE,expectedInventoryVersion:metadata.inventory!.inventoryVersion,expectedHeadSha:checkout.headSha,capabilityDigest:profile.capabilityDigest,policyDigest:profile.policyDigest,title});
 const base=`/hub/v2/projects/${trial.projectId}/sessions/${created.sessionId}`,runs=`/hub/v2/projects/${trial.projectId}/runs`;
 // Idle as Hub's own fence reads it: the session row holds no accepted operation still awaiting the machine. The session events of a
 // controller change or an applied command show its effect before the machine's receipt settles it, and until then Hub refuses the
 // next submission as session-busy. Hub's row is read before the record, so the returned record is never older than that settlement.
 const read=()=>hub.call<Control['SessionRecord']>(base);
 const idle=async()=>(await hub.wait(async()=>{const pending=hubSessionPending(trial.hubDataDir,created.sessionId);return{pending,session:await read()};},v=>v.pending===false&&v.session.state==='idle')).session;
 const initial=await idle();const claim=await hub.call<Control['ControllerReceipt']>(`${base}/controller/claim`,{expectedSessionVersion:initial.version,expectedControllerVersion:0,requestedLeaseSeconds:60,mode:'claim'});
 await hub.wait(read,s=>s.controller?.controllerLeaseId===claim.lease.controllerLeaseId&&s.sessionEventCursor>=initial.sessionEventCursor+2);const controller={controllerLeaseId:claim.lease.controllerLeaseId,expectedControllerVersion:claim.lease.version};
 const message=(ordinal:number,text:string,session:Control['SessionRecord'])=>hub.call<Control['TurnReceipt']>(`${base}/messages`,{expectedSessionVersion:session.version,expectedConfigVersion:session.config.configVersion,controller,text:trialTurn(ordinal,text),interpretation:'literal-message',busyPolicy:'enqueue',association:{mode:'ad-hoc',profileConsentVersion:1}});
 const send=async(ordinal:number,text:string)=>{const receipt=await message(ordinal,text,await idle());expect(receipt.status).toBe('admitted');if(receipt.runId===null)throw new Error('trial-turn-without-run');return{runId:receipt.runId};};
 const run=(runId:string)=>hub.call<RunRecord>(`${runs}/${runId}`);
 const events=(runId:string)=>hub.call<{events:RunEvent[]}>(`${runs}/${runId}/events`);
 const approveOnce=async(runId:string)=>{const page=await hub.wait(()=>events(runId),p=>p.events.some(e=>e.kind==='approval-request'));const question=page.events.find((e):e is Extract<RunEvent,{kind:'approval-request'}>=>e.kind==='approval-request')!;const current=await hub.wait(()=>run(runId),r=>r.state==='waiting-approval');const session=await read();
  await hub.call(`${runs}/${runId}/approvals/${question.approvalId}/answer`,{expectedRunVersion:current.version,expectedSessionVersion:session.version,controller,actionFingerprint:question.actionFingerprint,policyDigest:question.policyDigest,decision:'allow-once'});};
 return{created,base,runs,read,idle,controller,message,send,run,events,approveOnce};
}
/** `keryx hub machine recover --hub <hub> ...` exactly as the operator types it on that machine: its one JSON line, or its refusal code. */
async function recover(trial:Trial,target:TrialTarget,args:string[]):Promise<{ok:true;value:Record<string,unknown>}|{ok:false;code:string}>{
 const result=await trial.operator(target,['hub','machine','recover','--hub',trial.hubId,...args]);
 return result.exitCode===0?{ok:true,value:JSON.parse(result.stdout.trim()) as Record<string,unknown>}:{ok:false,code:result.stderr.trim()};
}

test.skipIf(!launcher.available)(`two keryx serve processes start their machine bridges through the shipped startup path and production profile resolution${needsSandbox}`,async()=>{
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
  // The project's shared Hub context synced on connect into the machine's own managed cache; the developer's checkout stayed untouched and clean.
  expect(syncedContext(target).documents.map(d=>({path:d.path,content:d.content}))).toContainEqual(TRIAL_CONTEXT);expect(checkoutState(target)).toEqual({index:TRIAL_INDEX,status:''});
  expect(notices(target)).toEqual([]);
 }
 if(catalogueGaps.length>0)expect(trial.provider.calls).toEqual([]);
 // Ctrl-C drains through serve itself: the bridges and the owner socket go before the listener, and the process exits cleanly.
 expect(await trial.stop()).toEqual([0,0]);
 for(const target of trial.targets){expect(target.serve.stdout.some(line=>/\bstopped\b/.test(line))).toBe(true);expect(()=>lstatSync(localControlPath(target.configDir))).toThrow();}
 }finally{await trial.stop();rmSync(trial.root,{recursive:true,force:true});}
},60000);

test.skipIf(catalogueGaps.length>0||!launcher.available)(`two serve machines run a real tool turn and a real supervised cancellation on production profiles${catalogueGaps.length>0?` (pending P3: production resolution refuses adapter-unsupported while the catalogue lists ${catalogueGaps.join(', ')})`:''}${needsSandbox}`,async()=>{
 const trial=await startMachineTrial();try{
 const hub=hubClient(trial);await hub.login();expect(trial.targets).toHaveLength(2);
 const calls=(target:TrialTarget,ordinal:number)=>trial.provider.calls.filter(c=>c.machine===target.machine&&c.ordinal===ordinal).map(({reply,toolName})=>toolName?{reply,toolName}:{reply});
 for(const target of trial.targets){
  const{base,runs,idle,controller,send,events,approveOnce}=await controlledSession(trial,hub,target,'Two-process serve proof');
  // The checkout synced its project's shared Hub context on connect and still hosts this session, its tracked index untouched.
  expect(syncedContext(target).documents.map(d=>({path:d.path,content:d.content}))).toContainEqual(TRIAL_CONTEXT);expect(checkoutState(target)).toEqual({index:TRIAL_INDEX,status:''});
  // A slash command exactly as the Hub web client sends it: the catalogue Hub publishes for this session, delivered to and applied by this serve child.
  const published=await hub.call<Control['CommandCatalogue']>(`${base}/commands`);const ready=await idle();
  const invoked=await hub.call<Control['CommandOutcome']>(`${base}/commands/invoke`,{expectedSessionVersion:ready.version,controller,expectedConfigVersion:ready.config.configVersion,catalogueDigest:published.catalogueDigest,commandName:'status',arguments:{},busyPolicy:'reject'});
  const applied=await hub.wait(()=>hub.call<Control['CommandOutcome']>(`${base}/operations/${invoked.operationId}`),o=>o.status!=='queued');
  expect({commandName:applied.commandName,status:applied.status,errorCode:applied.errorCode}).toEqual({commandName:'status',status:'applied',errorCode:null});
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

test.skipIf(catalogueGaps.length>0||!launcher.available)(`a serve killed mid-run stays uncertain until the operator recovers it locally and a human resolves it in Hub, then resumes on the restarted daemon with history and the owned baseline kept and queued work never replayed, while a commit made with serve connected reaches Hub${needsSandbox}`,async()=>{
 const trial=await startMachineTrial({spareCheckout:true});const[target,other]=trial.targets as [TrialTarget,TrialTarget];const marker=supervisedMarker(target.machine,2);try{
 const hub=hubClient(trial);await hub.login();
 const calls=(ordinal:number)=>trial.provider.calls.filter(c=>c.machine===target.machine&&c.ordinal===ordinal).map(({reply,toolName})=>toolName?{reply,toolName}:{reply});
 const machine=()=>hub.call<Inventory>(`/hub/v2/machines/${target.machineId}`);
 const s=await controlledSession(trial,hub,target,'Serve crash recovery');
 const published=(await machine()).inventory!;const head=published.checkouts.find(c=>c.checkoutId===target.checkoutId)!.headSha;
 // Turn 1 leaves an agent-owned uncommitted file: the owned baseline the crash must neither lose nor reset.
 const patch=await s.send(1,'write an approved native patch');await s.approveOnce(patch.runId);await hub.wait(()=>s.run(patch.runId),r=>r.state==='succeeded'&&r.result?.checksKind==='RunChecks');
 const owned=checkoutState(target);expect(owned).toEqual({index:TRIAL_INDEX,status:'?? trial-edit-1.txt\n'});
 // Turn 2 runs a supervised sleep in its own process group; turn 3 waits behind it in the durable session queue.
 const crashed=await s.send(2,'crash supervised sleep work');await s.approveOnce(crashed.runId);await hub.wait(async()=>processesWith(marker),found=>found.length>0);
 const queued=await s.message(3,'read seed.txt',await s.read());expect(queued.status).toBe('queued');
 // The machine durably queued it: Hub's queue projection comes from the serve child's own session events.
 await hub.wait(()=>hub.call<Control['QueuePage']>(`${s.base}/queue`),q=>q.items.some(i=>i.operationId===queued.operationId&&i.state==='queued'));
 // Those events reach Hub while the machine is still settling the submission: its receipt follows only once its ledger durably finished
 // the command. A crash before that leaves the submission uncertain local work on the checkout, which (rightly) fences every later
 // re-host; this trial crashes a settled queue, so it waits for that receipt.
 await hub.wait(async()=>hubCommandReceipt(trial.hubDataDir,s.created.sessionId,queued.operationId)??null,receipt=>receipt?.status==='applied');
 const history=await hub.call<Control['HistoryPage']>(`${s.base}/history`);expect(history.messages.map(m=>m.role)).toEqual(['human','tool-summary','assistant','human']);
 const before=await s.run(crashed.runId);expect(before.state).toBe('running');
 // SIGKILL: serve drains nothing and stops nothing. Its supervised child outlives it in its own process group.
 const crashedPid=target.serve.pid;expect(await trial.crashServe(target)).toBe(137);expect(processCommand(crashedPid)).toBe('');expect(processesWith(marker)).toHaveLength(1);
 // While the machine is offline Hub keeps the last-known run: never succeeded, cancelled, failed or closed, its session never idle or closed, its controller never released.
 const lastKnown={state:'running',version:before.version};
 const unsettled=async(expected:{state:string;version:number})=>{const run=await s.run(crashed.runId),session=await s.read();expect({state:run.state,version:run.version}).toEqual(expected);expect({state:session.state,activeRunId:session.activeRunId}).toEqual({state:'busy',activeRunId:crashed.runId});expect(session.controller?.state).not.toBe('released');};
 await hub.wait(machine,v=>!v.connected);await unsettled(lastKnown);
 // A plain restart cannot take over: the crashed daemon's lock still fences this Hub, so serve comes up without its bridge.
 await trial.restartServe(target);expect(notices(target)).toEqual(['machine-busy']);await Bun.sleep(1000);expect((await machine()).connected).toBe(false);await unsettled(lastKnown);
 expect(await trial.stopServe(target)).toBe(0);
 // Operator step 1: the stale daemon lock goes only through the explicit command, on the crashed daemon's proven absence.
 const lock=await recover(trial,target,['--action','release-stale-daemon']);if(!lock.ok)throw new Error(lock.code);expect(lock.value).toMatchObject({kind:'daemon-lock',state:'released'});
 // The crash also left its owner socket behind; the runbook has the operator remove it once no serve runs for this installation.
 expect(processCommand(crashedPid)).toBe('');const socket=localControlPath(target.configDir);expect(lstatSync(socket).isSocket()).toBe(true);rmSync(socket);
 await trial.restartServe(target);await hub.wait(machine,v=>v.connected);expect(notices(target)).not.toContain('machine-busy');expect(notices(target)).not.toContain('local-control-busy');
 // The reconnected daemon cannot prove it owns the crashed run, so Hub now shows it unknown and recovery-required (spec section 7), never
 // running; nothing is released, nothing repeats and the queued turn is not admitted.
 const shownUnknown={state:'unknown',version:before.version+1};await hub.wait(()=>s.run(crashed.runId),r=>r.state!=='running');
 await Bun.sleep(1000);await unsettled(shownUnknown);expect((await s.events(crashed.runId)).events.filter(e=>e.kind==='state').at(-1)).toMatchObject({state:'unknown',reasonCode:'recovery-required'});
 expect(calls(2)).toEqual([{reply:'tool',toolName:'shell_exec'}]);expect(calls(3)).toEqual([]);
 // The restarted machine published its changed checkout as the next inventory version: dirty with the crashed session's own file, at the unchanged HEAD.
 const restarted=(await machine()).inventory!;expect(restarted.inventoryVersion).toBeGreaterThan(published.inventoryVersion);
 expect(restarted.checkouts.find(c=>c.checkoutId===target.checkoutId)).toMatchObject({headSha:head,clean:false,available:true,agentProfiles:[{readiness:'ready'}]});
 const inspected=await recover(trial,target,[]);if(!inspected.ok)throw new Error(inspected.code);expect(inspected.value).toMatchObject({kind:'inspection',sessions:[],uncertainRuns:[{runId:crashed.runId,daemonId:lock.value.daemonId}]});
 // Operator step 2 refuses while the crashed run's process group lives, and Hub has no local receipt a human could resolve with.
 expect(await recover(trial,target,['--action','confirm-run-absence','--run',crashed.runId,'--request-id','confirm-while-live'])).toEqual({ok:false,code:'owned-process-live'});
 expect(await hub.raw(`/hub/v2/machines/${target.machineId}/resolve-run`,{runId:crashed.runId,expectedRunVersion:shownUnknown.version,localReconciliationId:'none',decision:'lost',reason:'No local proof'})).toMatchObject({status:409,data:{error:{code:'recovery-required'}}});await unsettled(shownUnknown);
 // The operator stops the leftover group; absence is then proven by recorded identity against the run Hub already shows unknown.
 killGroup(marker);await hub.wait(async()=>processesWith(marker),found=>found.length===0);
 const confirmed=await recover(trial,target,['--action','confirm-run-absence','--run',crashed.runId,'--request-id','confirm-absent']);if(!confirmed.ok)throw new Error(confirmed.code);
 expect(confirmed.value).toMatchObject({kind:'run-absence-confirmed',runId:crashed.runId,sessionId:s.created.sessionId,expectedRunVersion:shownUnknown.version});const reconciliationId=confirmed.value.reconciliationId as string;
 const uncertain=await s.run(crashed.runId);expect(uncertain.state).toBe('unknown');expect((await s.events(crashed.runId)).events.filter(e=>e.kind==='state').at(-1)).toMatchObject({state:'unknown',reasonCode:'recovery-required'});
 // Nothing is released by the local confirmation alone.
 expect(await recover(trial,target,['--action','release-resolved-run','--run',crashed.runId,'--reconciliation',reconciliationId,'--request-id','release-before-human'])).toEqual({ok:false,code:'recovery-required'});
 // The human resolves the run through the existing ResolveRunRequest; only then does operator step 4 release exactly this run's local fences.
 expect(await hub.call<{runId:string;state:string;version:number;reconciliationId:string}>(`/hub/v2/machines/${target.machineId}/resolve-run`,{runId:crashed.runId,expectedRunVersion:uncertain.version,localReconciliationId:reconciliationId,decision:'lost',reason:'Locally confirmed absence of the crashed serve and its supervised process group'})).toEqual({runId:crashed.runId,state:'lost',version:uncertain.version+1,reconciliationId});
 // A renewal or resume the human sends before operator step 4 is refused at once with its truthful code: the restarted daemon cannot
 // re-host yet, rejects it before starting anything, and Hub settles it instead of leaving the session busy until a delivery deadline.
 const early=await s.read();expect({state:early.state,activeRunId:early.activeRunId}).toEqual({state:'recovery-required',activeRunId:null});
 expect(await hub.raw(`${s.base}/controller/renew`,{expectedSessionVersion:early.version,expectedControllerVersion:s.controller.expectedControllerVersion,controllerLeaseId:s.controller.controllerLeaseId,requestedLeaseSeconds:60,mode:'renew'})).toMatchObject({status:200});
 const earlyResume=await hub.wait(()=>hub.raw(`${s.base}/resume`,{expectedSessionVersion:early.version,controller:s.controller,expectedHistoryVersion:early.historyVersion,expectedWorkspaceBaseline:early.workspaceBaseline}),r=>r.status!==409||(r.data as {error:{code:string}}).error.code!=='session-busy',10000);
 expect(earlyResume).toMatchObject({status:200,data:{kind:'resume-session',status:'pending'}});const earlyOperation=(earlyResume.data as Control['SessionOperationReceipt']).operationId;
 expect(await hub.wait(()=>hub.raw(`${s.base}/operations/${earlyOperation}`),r=>r.status!==200,10000)).toMatchObject({status:409,data:{error:{code:'recovery-required'}}});
 // So is `/sessions resume` from a new session on the machine's other checkout, and that source session is not left busy either.
 const spareTarget={...target,checkoutId:target.spare!.checkoutId,cwd:target.spare!.cwd};
 const sessionsResume=async(source:Awaited<ReturnType<typeof controlledSession>>,at:Control['SessionRecord'])=>{const ready=await source.idle();const catalogue=await hub.call<Control['CommandCatalogue']>(`${source.base}/commands`);
  return hub.call<Control['SessionOperationReceipt']>(`${source.base}/commands/invoke`,{expectedSessionVersion:ready.version,expectedConfigVersion:ready.config.configVersion,controller:source.controller,catalogueDigest:catalogue.catalogueDigest,commandName:'sessions.resume',
   arguments:{sessionId:s.created.sessionId,expectedSessionVersion:at.version,controller:s.controller,expectedHistoryVersion:at.historyVersion,expectedWorkspaceBaseline:at.workspaceBaseline},busyPolicy:'reject'});};
 const tooEarlySource=await controlledSession(trial,hub,spareTarget,'Resume the crashed session too early');const tooEarly=await sessionsResume(tooEarlySource,early);
 expect({sessionId:tooEarly.sessionId,kind:tooEarly.kind,status:tooEarly.status}).toEqual({sessionId:s.created.sessionId,kind:'resume-session',status:'pending'});
 expect(await hub.wait(()=>hub.raw(`${tooEarlySource.base}/operations/${tooEarly.operationId}`),r=>r.status!==200,10000)).toMatchObject({status:409,data:{error:{code:'recovery-required'}}});
 const afterRefusal=await tooEarlySource.idle();const status=await hub.call<Control['CommandOutcome']>(`${tooEarlySource.base}/commands/invoke`,{expectedSessionVersion:afterRefusal.version,controller:tooEarlySource.controller,expectedConfigVersion:afterRefusal.config.configVersion,catalogueDigest:(await hub.call<Control['CommandCatalogue']>(`${tooEarlySource.base}/commands`)).catalogueDigest,commandName:'status',arguments:{},busyPolicy:'reject'});
 expect((await hub.wait(()=>hub.call<Control['CommandOutcome']>(`${tooEarlySource.base}/operations/${status.operationId}`),o=>o.status!=='queued')).status).toBe('applied');
 const refused=await s.read();expect({state:refused.state,version:refused.version,controller:refused.controller,activeRunId:refused.activeRunId}).toEqual({state:'recovery-required',version:early.version,controller:early.controller,activeRunId:null});
 expect(await recover(trial,target,['--action','release-resolved-run','--run',crashed.runId,'--reconciliation',reconciliationId,'--request-id','release-after-human'])).toEqual({ok:true,value:{kind:'released-resolved-run',runId:crashed.runId,sessionId:s.created.sessionId,reconciliationId,capacityReleased:true,checkoutLeaseReleased:true}});
 // The daemon hosts only the source session of the refused `/sessions resume`; nothing re-hosted the crashed one.
 const released=await recover(trial,target,[]);if(!released.ok)throw new Error(released.code);expect(released.value).toMatchObject({uncertainRuns:[]});
 expect((released.value.sessions as {session:{sessionId:string}}[]).map(hosted=>hosted.session.sessionId)).toEqual([tooEarlySource.created.sessionId]);
 // History, the owned baseline and the queued input survive the crash and its recovery; the queued turn never reached the provider and is
 // now suspended, exactly as the restarted native host keeps queued input: never authorization, only a human reauthorizes or removes it.
 expect((await hub.call<Control['HistoryPage']>(`${s.base}/history`)).messages).toEqual(history.messages);expect(checkoutState(target)).toEqual(owned);expect(readFileSync(path.join(target.cwd,'trial-edit-1.txt'),'utf8')).toBe('deterministic native edit 1\n');
 expect((await hub.call<Control['QueuePage']>(`${s.base}/queue`)).items.map(i=>({operationId:i.operationId,state:i.state}))).toEqual([{operationId:queued.operationId,state:'suspended'}]);
 await Bun.sleep(1000);expect([calls(1),calls(2),calls(3)]).toEqual([[{reply:'tool',toolName:'apply_patch'},{reply:'text'}],[{reply:'tool',toolName:'shell_exec'}],[]]);
 // Released is not resumed: the lost run no longer occupies the session, which is recovery-required, never busy, idle or closed; its
 // controller is not released, new work on the unverified baseline is refused, and nothing re-hosted the session on its own.
 const final=await s.read();expect({state:final.state,activeRunId:final.activeRunId,activeTurnId:final.activeTurnId}).toEqual({state:'recovery-required',activeRunId:null,activeTurnId:null});expect(final.controller?.state).not.toBe('released');
 expect(await hub.raw(`${s.base}/messages`,{expectedSessionVersion:final.version,expectedConfigVersion:final.config.configVersion,controller:s.controller,text:trialTurn(3,'read seed.txt too early'),interpretation:'literal-message',busyPolicy:'reject',association:{mode:'ad-hoc',profileConsentVersion:1}})).toMatchObject({status:409,data:{error:{code:'recovery-required'}}});
 // Control stays explicit: the human renews the same controller lease, and that renewal is what the restarted daemon re-hosts the crashed
 // session for, from its durable state, on its re-verified owned baseline and the crashed daemon's lease proven gone by recorded identity.
 const left=Date.parse(final.controller!.expiresAt)-Date.now();if(left<5000)throw new Error(`trial-controller-lease-nearly-expired: ${left} ms left`);
 const renewal=await hub.call<Control['ControllerReceipt']>(`${s.base}/controller/renew`,{expectedSessionVersion:final.version,expectedControllerVersion:s.controller.expectedControllerVersion,controllerLeaseId:s.controller.controllerLeaseId,requestedLeaseSeconds:60,mode:'renew'});
 expect({id:renewal.lease.controllerLeaseId,version:renewal.lease.version}).toEqual({id:s.controller.controllerLeaseId,version:s.controller.expectedControllerVersion});
 const renewed=await hub.wait(s.read,v=>v.controller?.expiresAt===renewal.lease.expiresAt&&v.sessionEventCursor>=final.sessionEventCursor+2);
 expect({state:renewed.state,activeRunId:renewed.activeRunId,workspaceBaseline:renewed.workspaceBaseline}).toEqual({state:'recovery-required',activeRunId:null,workspaceBaseline:final.workspaceBaseline});
 const rehosted=await recover(trial,target,['--session',s.created.sessionId]);if(!rehosted.ok)throw new Error(rehosted.code);
 expect(rehosted.value).toMatchObject({sessions:[{session:{sessionId:s.created.sessionId,state:'recovery-required',activeRunId:null},checkoutOwned:true}],uncertainRuns:[]});
 // An operator stop before the resume fences nothing the re-hosted session took: the next daemon hosts it again for the resume.
 expect(await trial.stopServe(target)).toBe(0);await trial.restartServe(target);await hub.wait(machine,v=>v.connected);
 const restartedAgain=await recover(trial,target,[]);if(!restartedAgain.ok)throw new Error(restartedAgain.code);expect(restartedAgain.value).toMatchObject({sessions:[],uncertainRuns:[]});
 // The human resumes it with `/sessions resume` from a new session on the machine's other checkout: the command reaches the same guarded
 // re-host on the restarted daemon, and only the machine's own re-verification of the owned baseline makes it idle. The lost run stays lost.
 const source=await controlledSession(trial,hub,spareTarget,'Resume the crashed session');
 const leaseLeft=Date.parse(renewal.lease.expiresAt)-Date.now();if(leaseLeft<5000)throw new Error(`trial-controller-lease-nearly-expired: ${leaseLeft} ms left`);
 const resume=await sessionsResume(source,renewed);
 expect({sessionId:resume.sessionId,kind:resume.kind,status:resume.status}).toEqual({sessionId:s.created.sessionId,kind:'resume-session',status:'pending'});
 const resumed=await hub.wait(s.read,v=>v.state==='idle');expect((await source.read()).state).toBe('idle');expect({activeRunId:resumed.activeRunId,workspaceBaseline:resumed.workspaceBaseline}).toEqual({activeRunId:null,workspaceBaseline:final.workspaceBaseline});
 expect((await s.run(crashed.runId)).state).toBe('lost');expect(checkoutState(target)).toEqual(owned);
 // A new turn runs on the resumed native conversation, past the suspended item; the queued turn still never reaches the provider.
 const queuedText=trialTurn(3,'read seed.txt'),next=await s.send(3,'read seed.txt after the resume');
 await hub.wait(()=>s.run(next.runId),r=>r.state==='succeeded');
 expect(calls(3)).toEqual([{reply:'tool',toolName:'read_file'},{reply:'text'}]);expect(trial.provider.calls.filter(c=>c.machine===target.machine&&c.ordinal===3).map(c=>c.text)).toEqual([trialTurn(3,'read seed.txt after the resume'),trialTurn(3,'read seed.txt after the resume')]);
 expect(trial.provider.calls.filter(c=>c.text===queuedText)).toEqual([]);
 expect((await hub.call<Control['QueuePage']>(`${s.base}/queue`)).items.map(i=>({operationId:i.operationId,state:i.state}))).toEqual([{operationId:queued.operationId,state:'suspended'}]);
 // History is intact: every message before the crash stays, in order, and the new turn only appends.
 const after=(await hub.call<Control['HistoryPage']>(`${s.base}/history`)).messages;expect(after.slice(0,history.messages.length)).toEqual(history.messages);
 expect(after.slice(history.messages.length).map(m=>m.role)).toEqual(['human','tool-summary','assistant']);expect(after.at(-3)?.text).toBe(trialTurn(3,'read seed.txt after the resume'));
 // The other machine was never touched by any of it.
 expect((await hub.call<Inventory>(`/hub/v2/machines/${other.machineId}`)).connected).toBe(true);expect(trial.provider.calls.filter(c=>c.machine===other.machine)).toEqual([]);expect(notices(other)).toEqual([]);
 // While serve stays connected, a developer commit on that machine's checkout reaches Hub as the next inventory version without any
 // reconnect, and a new session on the new HEAD runs a real turn.
 const otherMachine=()=>hub.call<Inventory>(`/hub/v2/machines/${other.machineId}`);const otherBefore=(await otherMachine()).inventory!,otherPid=other.serve.pid;
 writeFileSync(path.join(other.cwd,'developer.txt'),'a developer commit while serve runs\n');git(other,['add','developer.txt']);git(other,['commit','-qm','Developer commit while serve is connected']);const committed=git(other,['rev-parse','HEAD']);
 const fresh=await hub.wait(otherMachine,v=>v.connected&&v.inventory?.checkouts.some(c=>c.checkoutId===other.checkoutId&&c.headSha===committed&&c.clean)===true,30000);
 expect(fresh.inventory!.inventoryVersion).toBeGreaterThan(otherBefore.inventoryVersion);expect(other.serve.pid).toBe(otherPid);expect(notices(other)).toEqual([]);
 const work=await controlledSession(trial,hub,other,'New work on a commit made while serve is connected');
 const read=await work.send(1,'read seed.txt');await hub.wait(()=>work.run(read.runId),r=>r.state==='succeeded');
 expect(trial.provider.calls.filter(c=>c.machine===other.machine).map(({reply,toolName})=>toolName?{reply,toolName}:{reply})).toEqual([{reply:'tool',toolName:'read_file'},{reply:'text'}]);
 expect(notices(other)).toEqual([]);expect(trial.provider.unexpected).toEqual([]);
 }finally{killGroup(marker);await trial.stop();rmSync(trial.root,{recursive:true,force:true});}
},180000);

test.skipIf(catalogueGaps.length>0||!launcher.available)(`a Hub restart while both serve machines stay up keeps running and approval-paused work owned: no restart, no repeated tool or provider round, no takeover${needsSandbox}`,async()=>{
 const trial=await startMachineTrial();const[target,other]=trial.targets as [TrialTarget,TrialTarget];const marker=supervisedMarker(target.machine,1);try{
 const hub=hubClient(trial);await hub.login();
 const calls=(ordinal:number)=>trial.provider.calls.filter(c=>c.machine===target.machine&&c.ordinal===ordinal).map(({reply,toolName})=>toolName?{reply,toolName}:{reply});
 const pids=trial.targets.map(t=>t.serve.pid);const reconnected=()=>Promise.all(trial.targets.map(t=>hub.wait(()=>hub.call<Inventory>(`/hub/v2/machines/${t.machineId}`),v=>v.connected,30000)));
 const s=await controlledSession(trial,hub,target,'Hub restart');
 // A supervised sleep is running on the machine when Hub goes away.
 const sleeper=await s.send(1,'sleep supervised work across a Hub restart');await s.approveOnce(sleeper.runId);await hub.wait(async()=>processesWith(marker),found=>found.length>0);
 const running=await s.run(sleeper.runId);expect(running.state).toBe('running');
 await trial.restartHub(async()=>{
  // While Hub is down both serve processes and the owned child keep running: the machine neither stops nor restarts work.
  for(const pid of pids)expect(processCommand(pid)).toContain(`${SERVE_ENTRY} serve`);expect(processesWith(marker)).toHaveLength(1);await Bun.sleep(1000);});
 await hub.login();await reconnected();
 // Reconnect reconciles the same run: still running at its version, one supervised child, one provider round, the same serve processes.
 const reconciled=await s.run(sleeper.runId);expect({state:reconciled.state,version:reconciled.version}).toEqual({state:'running',version:running.version});expect(reconciled.lastLocalSeq).toBeGreaterThanOrEqual(running.lastLocalSeq);
 expect(processesWith(marker)).toHaveLength(1);expect(calls(1)).toEqual([{reply:'tool',toolName:'shell_exec'}]);expect(trial.targets.map(t=>t.serve.pid)).toEqual(pids);
 // No implicit takeover: the human controller is unchanged, and a cancel after the restart stops exactly the owned child.
 const current=await s.read();expect(current.controller?.controllerLeaseId).toBe(s.controller.controllerLeaseId);
 await hub.call(`${s.runs}/${sleeper.runId}/cancel`,{expectedRunVersion:reconciled.version,expectedSessionVersion:current.version,controller:s.controller,reason:'Stop after the Hub restart'});
 await hub.wait(()=>s.run(sleeper.runId),r=>r.state==='cancelled');await hub.wait(async()=>processesWith(marker),found=>found.length===0,6000);
 // An approval pending across a second restart applies once afterwards: no effect before Allow once, exactly one patch and one final round after.
 const patch=await s.send(2,'write an approved native patch');await hub.wait(()=>s.run(patch.runId),r=>r.state==='waiting-approval');
 await trial.restartHub(async()=>{await Bun.sleep(500);});await hub.login();await reconnected();
 expect((await s.run(patch.runId)).state).toBe('waiting-approval');expect(existsSync(path.join(target.cwd,'trial-edit-2.txt'))).toBe(false);expect(calls(2)).toEqual([{reply:'tool',toolName:'apply_patch'}]);
 await s.approveOnce(patch.runId);await hub.wait(()=>s.run(patch.runId),r=>r.state==='succeeded'&&r.result?.checksKind==='RunChecks');
 expect(readFileSync(path.join(target.cwd,'trial-edit-2.txt'),'utf8')).toBe('deterministic native edit 2\n');expect(calls(2)).toEqual([{reply:'tool',toolName:'apply_patch'},{reply:'text'}]);
 // History kept every turn in order across both restarts.
 expect((await hub.call<Control['HistoryPage']>(`${s.base}/history`)).messages.map(m=>[m.historyCursor,m.role])).toEqual([[1,'human'],[2,'tool-summary'],[3,'human'],[4,'tool-summary'],[5,'assistant']]);
 // Each serve reported only its lost connection, and the untouched machine stayed separately scoped.
 for(const t of trial.targets){const seen=notices(t);expect(seen.length).toBeGreaterThan(0);expect(new Set(seen)).toEqual(new Set(['machine-disconnected']));}
 expect(trial.provider.calls.filter(c=>c.machine===other.machine)).toEqual([]);expect(trial.provider.unexpected).toEqual([]);
 }finally{killGroup(marker);await trial.stop();rmSync(trial.root,{recursive:true,force:true});}
},180000);
