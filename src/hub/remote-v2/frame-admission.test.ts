import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { openHubStore } from '../store';
import { createRemoteControl, type RemoteSocketData } from '.';

test('machine frames and disconnect persistence run as internal serialized work, outside the HTTP waiter limit', async () => {
    const dir=mkdtempSync(join(tmpdir(),'hub-frame-admission-')), store=openHubStore(dir);
    const calls:unknown[]=[];
    const remote=createRemoteControl({store,human:async()=>{throw new Error('unused');},authorityValid:()=>false,checkOrigin(){},transportAllowed:()=>true,
        serialized:async<T>(_action:()=>Promise<T>,options?:{internal?:boolean})=>{calls.push(options);return undefined as T;}});
    const socket={data:{kind:'machine',machineId:'m1',credentialDigest:'c',projectScopeDigest:'s',epoch:1,daemonId:'d',lastHeartbeat:0},readyState:1,close(){},getBufferedAmount:()=>0,send:()=>0} as unknown as ServerWebSocket<RemoteSocketData>;
    try {
        remote.websocket.message!(socket,JSON.stringify({v:2,type:'heartbeat',messageId:'m',epoch:1,payload:{daemonId:'d'}}));
        remote.websocket.close!(socket,1000,'');
        expect(calls).toEqual([{internal:true},{internal:true}]);
    } finally { remote.close();store.close();rmSync(dir,{recursive:true,force:true}); }
});
