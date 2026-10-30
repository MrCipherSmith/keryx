import { expect, test } from 'bun:test';
import { MachineConnection, enrollMachine, verifyAuthorizationGrant } from './client';
import type { Control } from '../../remote-control/protocol';
const target = { scope: 'session', sessionId: 's', expectedSessionVersion: 0 } as Control['CommandTarget'];
const authorization = { commandDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), target, controller: null };
test('grant application checks exact binding, server deadline and monotonic request age', () => {
    const now = Date.now();
    const grant = { ...authorization, grantId: 'g', commandId: 'c', authorizedBy: 'human', authorizedAt: new Date(now).toISOString(), expiresAt: new Date(now + 5000).toISOString() };
    expect(verifyAuthorizationGrant(grant, { ...authorization, commandId: 'c', authorizedBy: 'human' }, now, 10)).toBe(true);
    expect(verifyAuthorizationGrant(grant, { ...authorization, commandId: 'different', authorizedBy: 'human' }, now, 10)).toBe(false);
    expect(verifyAuthorizationGrant(grant, { ...authorization, commandId: 'c', authorizedBy: 'human' }, now, 5000)).toBe(false);
});
test('real HTTP enrollment uses exact v2 path and one-use body without bearer inheritance', async () => {
    let seen: unknown;
    const server = Bun.serve({ port: 0, fetch: async (r) => { seen = { url: new URL(r.url).pathname, auth: r.headers.get('authorization'), body: await r.json() }; return Response.json({ machineId: 'machine-a', secret: 's'.repeat(43) }); } });
    try {
        expect(await enrollMachine(server.url.origin, { code: 'c'.repeat(22), agentVersion: 'test', ledgerId: 'ledger-a' })).toEqual({ machineId: 'machine-a', secret: 's'.repeat(43) });
        expect(seen).toEqual({ url: '/hub/v2/machines/enroll', auth: null, body: { code: 'c'.repeat(22), agentVersion: 'test', ledgerId: 'ledger-a' } });
    }
    finally {
        server.stop(true);
    }
});
test('real socket sends machine bearer/subprotocol, waits for welcome and fences stale epochs', async () => {
    let headers: Headers | undefined;
    const frames: unknown[] = [];
    let peer: {
        send: (s: string) => unknown;
    } | undefined;
    const server = Bun.serve({ port: 0, fetch(r, s) { headers = r.headers; if (s.upgrade(r))
            return; return new Response('', { status: 400 }); }, websocket: { open(ws) { peer = ws; }, message(ws, raw) { frames.push(JSON.parse(String(raw))); ws.send(JSON.stringify({ v: 2, type: 'welcome', messageId: 'welcome', epoch: 4, payload: { machineId: 'machine-a', heartbeatSeconds: 20, heartbeatTimeoutSeconds: 60, resumeMode: 'replay', hubSequence: 0 } })); } } });
    let received = 0;
    const client = new MachineConnection({ hubUrl: server.url.origin, machineId: 'machine-a', secret: 's'.repeat(43), ledgerId: 'ledger-a', daemonId: 'daemon-a', agentVersion: 'test', onFrame: () => { received++; } });
    try {
        await client.connect();
        expect(headers!.get('authorization')).toBe('Bearer ' + 's'.repeat(43));
        expect(headers!.get('sec-websocket-protocol')).toBe('keryx.hub.machine.v2');
        expect(headers!.get('origin')).toBeNull();
        expect(frames[0]).toMatchObject({ v: 2, type: 'hello', epoch: 0, payload: { ledgerId: 'ledger-a' } });
        peer!.send(JSON.stringify({ v: 2, type: 'heartbeat-ack', messageId: 'stale', epoch: 3, payload: { serverTime: new Date().toISOString() } }));
        await new Promise(r => setTimeout(r, 25));
        expect(received).toBe(0);
        expect(client.connected).toBe(false);
    }
    finally {
        client.close();
        server.stop(true);
    }
});
test('HTTP bytes are capped while streaming and transport failures return typed sanitized outcomes',async()=>{
 const {readBoundedResponse,enrollMachineResult}=await import('./client');let pulls=0,cancelled=false;
 const response=new Response(new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(8192));},cancel(){cancelled=true;}}));
 await expect(readBoundedResponse(response,16384)).rejects.toThrow('quota-exceeded');expect(pulls).toBeLessThanOrEqual(4);expect(cancelled).toBe(true);
 const outcome=await enrollMachineResult('https://user:secret@hub.example',{code:'c'.repeat(22),agentVersion:'test',ledgerId:'ledger'});expect(outcome.ok).toBe(false);if(!outcome.ok){expect(outcome.error.name).toBe('MachineError');expect(outcome.error.message).not.toContain('secret');}
});
test('fresh grants are consumed once at the exact application boundary',async()=>{
 const {createGrantApplication}=await import('./client');const now=Date.now();let clock=100;let calls=0;
 const grant={...authorization,grantId:'one',commandId:'c',authorizedBy:'human',authorizedAt:new Date(now).toISOString(),expiresAt:new Date(now+5000).toISOString()};
 const application=createGrantApplication(grant,{...authorization,commandId:'c',authorizedBy:'human'},{startedAt:100,monotonic:()=>clock,wall:()=>now});expect(await application.apply(()=>++calls)).toEqual({ok:true,value:1});expect((await application.apply(()=>++calls)).ok).toBe(false);expect(calls).toBe(1);
 const stale=createGrantApplication({...grant,grantId:'two'},{...authorization,commandId:'c',authorizedBy:'human'},{startedAt:100,monotonic:()=>clock,wall:()=>now});clock=5100;expect((await stale.apply(()=>++calls)).ok).toBe(false);expect(calls).toBe(1);
});
test('continuing authority requires fresh no-store owning-session proof and exact live target',async()=>{
 const {readSessionActionAuthority}=await import('./client');let proof=false;const d='a'.repeat(64);const record:Control['SessionRecord']={sessionId:'s',projectId:'p',machineId:'m',checkoutId:'c',agentProfileId:'native',version:3,historyVersion:1,state:'busy',title:'Authority test',config:{configVersion:1,baselineCandidateId:'candidate',reasoningEffort:'none',routing:{enabled:false,profileId:'local',candidateIds:['candidate'],fallbackCandidateId:'candidate'},policyDigest:d,capabilityDigest:d},controller:{controllerLeaseId:'lease',sessionId:'s',version:1,actorId:'human',actorKind:'human-operator',expiresAt:new Date(Date.now()+60000).toISOString(),state:'held'},activeRunId:'r',activeTurnId:'t',nextTurnOrdinal:2,historyCursor:0,sessionEventCursor:1,queueVersion:0,workspaceBaseline:d,forkedFromSessionId:null,capabilities:{literalText:true,attachments:false,attachmentReason:'typed-artifact-contract-required',commandCatalogue:true,modelRouting:true}};
 const server=Bun.serve({port:0,fetch(r){expect(r.headers.get('authorization')).toBe('Bearer isolated-test');expect(r.headers.get('origin')).toBeNull();return Response.json(record,{headers:{'Cache-Control':'no-store',...(proof?{'X-Keryx-Action-Authority':'checked-v2'}:{})}});}});try{const action={session:record,runId:'r',turnId:'t',kind:'model' as const};expect(await readSessionActionAuthority({hubUrl:server.url.origin,secret:'isolated-test',action})).toBe(false);proof=true;expect(await readSessionActionAuthority({hubUrl:server.url.origin,secret:'isolated-test',action})).toBe(true);expect(await readSessionActionAuthority({hubUrl:server.url.origin,secret:'isolated-test',action:{...action,turnId:'other'}})).toBe(false);}finally{server.stop(true);}
});
test('local managed admission verifies current canonical project Flow and ordered frozen criteria pins',async()=>{
 const{verifyScopedFlowAssociation}=await import('./client');const{criteriaDigest}=await import('../../remote-control/protocol');const association={mode:'flow' as const,flowId:'flow',expectedFlowVersion:7,specDigest:'a'.repeat(64),criteriaDigest:criteriaDigest(['one','two'])};const flow={id:'flow',projectId:'p',version:7,status:'in-progress',specContentDigest:'a'.repeat(64),criteria:['one','two']};expect(verifyScopedFlowAssociation(flow,'p',association)).toBe(true);for(const changed of [{...flow,projectId:'foreign'},{...flow,version:8},{...flow,status:'review'},{...flow,criteria:['two','one']},{...flow,specContentDigest:'b'.repeat(64)}])expect(verifyScopedFlowAssociation(changed,'p',association)).toBe(false);
});
test('closing a pending native handshake settles immediately instead of leaving a ten-second promise',async()=>{const server=Bun.serve({port:0,fetch(r,s){if(s.upgrade(r))return;return new Response('',{status:400});},websocket:{message(){}}});const connection=new MachineConnection({hubUrl:server.url.origin,machineId:'m',secret:'s'.repeat(43),ledgerId:'l',daemonId:'d',agentVersion:'test',onFrame:()=>{}});try{const pending=connection.connect();await Bun.sleep(10);const started=performance.now();connection.close();await expect(pending).rejects.toThrow('machine-disconnected');expect(performance.now()-started).toBeLessThan(500);}finally{connection.close();server.stop(true);}});
test('idle inspection client refuses unguarded, foreign actor and stale current controller proofs',async()=>{
 const {readSessionInspectionAuthority}=await import('./client');let proof=false;const d='a'.repeat(64);const record:Control['SessionRecord']={sessionId:'s',projectId:'p',machineId:'m',checkoutId:'c',agentProfileId:'native',version:3,historyVersion:1,state:'idle',title:'Inspection test',config:{configVersion:1,baselineCandidateId:'candidate',reasoningEffort:'none',routing:{enabled:false,profileId:'local',candidateIds:['candidate'],fallbackCandidateId:'candidate'},policyDigest:d,capabilityDigest:d},controller:{controllerLeaseId:'lease',sessionId:'s',version:1,actorId:'human',actorKind:'human-operator',expiresAt:new Date(Date.now()+60000).toISOString(),state:'held'},activeRunId:null,activeTurnId:null,nextTurnOrdinal:2,historyCursor:0,sessionEventCursor:1,queueVersion:0,workspaceBaseline:d,forkedFromSessionId:null,capabilities:{literalText:true,attachments:false,attachmentReason:'typed-artifact-contract-required',commandCatalogue:true,modelRouting:true}};
 const action={session:structuredClone(record),operationId:'op',actorId:'human',toolName:'github_read',signal:new AbortController().signal,command:{expectedSessionVersion:3,expectedConfigVersion:1,controller:{controllerLeaseId:'lease',expectedControllerVersion:1},catalogueDigest:d,commandName:'ci',arguments:{},busyPolicy:'reject' as const}};
 const server=Bun.serve({port:0,fetch(){return Response.json(record,{headers:{'Cache-Control':'no-store',...(proof?{'X-Keryx-Action-Authority':'checked-v2'}:{})}});}});try{expect(await readSessionInspectionAuthority({hubUrl:server.url.origin,secret:'isolated-test',action})).toBe(false);proof=true;expect(await readSessionInspectionAuthority({hubUrl:server.url.origin,secret:'isolated-test',action})).toBe(true);expect(await readSessionInspectionAuthority({hubUrl:server.url.origin,secret:'isolated-test',action:{...action,actorId:'other'}})).toBe(false);record.version++;expect(await readSessionInspectionAuthority({hubUrl:server.url.origin,secret:'isolated-test',action})).toBe(false);}finally{server.stop(true);}
});

test('selection distinguishes temporary HTTP failure from revoked authority and unknown proof',async()=>{
 const {readSessionSelectionAuthority}=await import('./client');let status=503;const d='a'.repeat(64);const record:Control['SessionRecord']={sessionId:'s',projectId:'p',machineId:'m',checkoutId:'c',agentProfileId:'native',version:3,historyVersion:1,state:'idle',title:'Selection test',config:{configVersion:1,baselineCandidateId:'candidate',reasoningEffort:'none',routing:{enabled:true,profileId:'local',candidateIds:['candidate'],fallbackCandidateId:'candidate'},policyDigest:d,capabilityDigest:d},controller:{controllerLeaseId:'lease',sessionId:'s',version:1,actorId:'human',actorKind:'human-operator',expiresAt:new Date(Date.now()+60000).toISOString(),state:'held'},activeRunId:null,activeTurnId:null,nextTurnOrdinal:2,historyCursor:0,sessionEventCursor:1,queueVersion:0,workspaceBaseline:d,forkedFromSessionId:null,capabilities:{literalText:true,attachments:false,attachmentReason:'typed-artifact-contract-required',commandCatalogue:true,modelRouting:true}};
 const request:Control['StartTurnRequest']={sessionId:'s',expectedSessionVersion:3,expectedConfigVersion:1,expectedHistoryVersion:1,expectedWorkspaceBaseline:d,controller:{controllerLeaseId:'lease',expectedControllerVersion:1},association:{mode:'ad-hoc',profileConsentVersion:1},messageId:'message',text:'Literal input'};
 const action={session:record,operationId:'op',actorId:'human',payloadDigest:d,request,runId:'run',turnId:'turn',phase:'admission' as const,signal:new AbortController().signal};
 const server=Bun.serve({port:0,fetch(){return status===200?Response.json(record):new Response('',{status});}});try{
 const check=()=>readSessionSelectionAuthority({hubUrl:server.url.origin,secret:'isolated',action});
 expect(await check()).toEqual({status:'temporarily-unavailable'});status=403;expect(await check()).toEqual({status:'revoked-or-forbidden'});status=200;expect(await check()).toEqual({status:'unknown'});
 }finally{server.stop(true);}
});
test('a grant the actual Hub issues across a clock tick spans exactly the protocol limit and the machine applies it',async()=>{
 const{fixture,publishCapabilities,success,D,HEAD}=await import('../../hub/remote-v2/fixture.test-support');const{createGrantApplication}=await import('./client');const{LIMITS}=await import('../../remote-control/protocol');
 const f=await fixture();const realNow=Date.now;try{
 const machine=await f.enroll();const peer=await f.connect(machine);await publishCapabilities(f,peer);
 await success(await f.call(`/hub/v2/projects/${f.project.id}/sessions`,{method:'POST',cookie:f.cookie,body:{machineId:machine.machineId,checkoutId:'checkout',agentProfileId:'native',expectedInventoryVersion:1,expectedHeadSha:HEAD,capabilityDigest:D,policyDigest:D,title:'Grant clock'}}));
 const envelope=(await peer.next('session-command')).payload as {commandId:string;commandDigest:string;authorizedBy:string;target:Control['CommandTarget']};const request:Control['AuthorizeCommand']={commandDigest:envelope.commandDigest,policyDigest:D,target:envelope.target,controller:null};
 // Every wall-clock read advances one millisecond while the Hub issues the grant: a tick, preemption or GC pause between two reads.
 let tick=realNow();Date.now=()=>tick++;let response:Response;try{response=await f.call(`/hub/v2/machines/${machine.machineId}/commands/${envelope.commandId}/authorize`,{method:'POST',token:machine.secret,origin:null,body:request});}finally{Date.now=realNow;}
 const grant=await success<Control['AuthorizationGrant']>(response);expect(Date.parse(grant.expiresAt)-Date.parse(grant.authorizedAt)).toBe(LIMITS.grantMs);
 const application=createGrantApplication(grant,{...request,commandId:envelope.commandId,authorizedBy:envelope.authorizedBy},{startedAt:performance.now(),monotonic:()=>performance.now(),wall:()=>Date.parse(grant.authorizedAt)});
 expect(await application.apply(()=>'applied')).toEqual({ok:true,value:'applied'});
 }finally{Date.now=realNow;await f.close();}
});
test('a Hub request the network refuses or resets is a typed transport failure, never the generic state failure, and an abort keeps its own class',async()=>{
 const{machineNoticeCode}=await import('./errors');
 const connection=(hubUrl:string)=>new MachineConnection({hubUrl,machineId:'m',secret:'s'.repeat(43),ledgerId:'l',daemonId:'d',agentVersion:'test',onFrame:()=>{}});
 /** A Hub that holds every request open and says when one arrived. */
 const holding=()=>{let arrived!:()=>void;const received=new Promise<void>(resolve=>{arrived=resolve;});const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>{arrived();return new Promise<Response>(()=>{});}});return{server,received,origin:`http://127.0.0.1:${server.port}`};};
 // Refused: the Hub is gone before the request.
 const gone=holding();await gone.server.stop(true);
 const refused:unknown=await connection(gone.origin).request('/hub/v2/machines/m').catch((cause:unknown)=>cause);
 expect(refused).toMatchObject({name:'MachineError',code:'machine-request-failed'});expect(machineNoticeCode(refused,false)).toBe('machine-request-failed');
 // Reset: the Hub stops while the request is in flight, as when a Hub restart lands on a result upload.
 const stopping=holding();const inflight=connection(stopping.origin).request('/hub/v2/machines/m',{}).catch((cause:unknown)=>cause);await stopping.received;await stopping.server.stop(true);
 const reset:unknown=await inflight;expect(reset).toMatchObject({name:'MachineError',code:'machine-request-failed'});expect(machineNoticeCode(reset,false)).toBe('machine-request-failed');
 // Abort: this connection closing aborts its own requests; that stays an abort, classified by the bridge's stop state.
 const held=holding();try{const own=connection(held.origin);const pending=own.request('/hub/v2/machines/m').catch((cause:unknown)=>cause);await held.received;own.close();
  const aborted:unknown=await pending;expect(aborted).toMatchObject({name:'AbortError'});expect(machineNoticeCode(aborted,false)).toBe('machine-request-aborted');expect(machineNoticeCode(aborted,true)).toBe('machine-stopping');
 }finally{await held.server.stop(true);}
});
