import { expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHubStore } from '../store';
import { createMutationQueue } from '../mutation-queue';
import { createRemoteControl, type RemoteSocketData } from './index';

for (const refusal of ['full', 'expired'] as const) test(`WebSocket mutation lane ${refusal} uses recoverable overload rather than authorization loss`, async () => {
    const root=mkdtempSync(join(tmpdir(),'hub-socket-overload-')), store=openHubStore(root);
    const queue=createMutationQueue({maxPending:1,maxWaitMs:20});
    const entered=Promise.withResolvers<void>(), release=Promise.withResolvers<void>();
    const active=queue.serialized(async()=>{entered.resolve();await release.promise;});await entered.promise;
    const filler=refusal==='full'?queue.serialized(async()=>undefined).catch(()=>undefined):Promise.resolve();
    const remote=createRemoteControl({store,serialized:queue.serialized,human:async()=>({actor:{id:'h',kind:'human',role:'operator'},sessionDigest:'session'}),authorityValid:()=>true,checkOrigin:()=>undefined,transportAllowed:()=>true});
    const closed=Promise.withResolvers<{code:number;reason:string}>(), frames:string[]=[];
    // Only the transport socket is a test double. The real mutation queue and
    // production frame handler reject before any machine state can be read.
    const socket={data:{kind:'machine',machineId:'m',credentialDigest:'d',projectScopeDigest:'p',epoch:1,daemonId:'daemon',lastHeartbeat:Date.now()},getBufferedAmount:()=>0,send:(frame:string)=>{frames.push(frame);return 1;},close:(code:number,reason:string)=>closed.resolve({code,reason})} as unknown as ServerWebSocket<RemoteSocketData>;
    try {
        remote.websocket.message!(socket,JSON.stringify({v:2,type:'heartbeat',messageId:'retryable-frame',epoch:1,payload:{daemonId:'daemon'}}));
        const outcome=await closed.promise;
        expect(outcome).toEqual({code:1013,reason:'Hub busy; retry connection'});
        expect(frames).toEqual([]);
    } finally {release.resolve();await active;await filler;queue.close();await queue.settle();remote.close();store.close();rmSync(root,{recursive:true,force:true});}
});
