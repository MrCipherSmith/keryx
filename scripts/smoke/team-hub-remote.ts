/** Real network protocol/package probe. No native runtime or vendor execution is claimed. */
import { randomUUID } from 'node:crypto';
import { parseMachineFrame } from '../../src/remote-control/protocol';
const Socket = WebSocket as unknown as {new(url: string, options: Bun.WebSocketOptions): WebSocket};
export async function remotePackageSmoke(origin: string, cookie: string, agent: string, projectId: string) {
  const sockets: WebSocket[]=[];
  async function call(path:string,body?:unknown,token?:string,requestOrigin=origin) {
    return fetch(origin+path,{method:body===undefined?'GET':'POST',signal:AbortSignal.timeout(5000),headers:{Origin:requestOrigin,...(token?{Authorization:'Bearer '+token}:{Cookie:cookie}),...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':randomUUID()})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  }
  async function json<T>(path:string,body?:unknown):Promise<T>{const response=await call(path,body);if(!response.ok)throw new Error('Remote probe '+path+' status '+response.status);return response.json() as Promise<T>;}
  async function open(path:string,options:Bun.WebSocketOptions){const socket=new Socket(origin.replace('http','ws')+path,options);sockets.push(socket);await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('WebSocket upgrade timeout')),5000);socket.addEventListener('open',()=>{clearTimeout(timeout);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(timeout);reject(new Error('WebSocket upgrade denied'));},{once:true});});return socket;}
  function frame(socket:WebSocket){return new Promise<string>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Missing protocol response')),5000);socket.addEventListener('message',event=>{clearTimeout(timeout);resolve(String(event.data));},{once:true});});}
  const pairing={displayName:'Packaged network probe',projectIds:[projectId]};
  try{
    if((await call('/hub/v2/machines/pairings',pairing,agent)).status!==403)throw new Error('Agent bypassed human-only pairing');
    if((await call('/hub/v2/machines/pairings',pairing,undefined,'https://untrusted.invalid')).status!==403)throw new Error('Cross-origin pairing accepted');
    if((await call('/hub/v2/machines/pairings',{...pairing,extra:true})).status!==400)throw new Error('Packaged closed validator missing');
    const pair=await json<{code:string}>('/hub/v2/machines/pairings',pairing);
    const enrollment={code:pair.code,agentVersion:'package-smoke-v2',ledgerId:'package-smoke-ledger'};
    const machine=await json<{machineId:string;secret:string}>('/hub/v2/machines/enroll',enrollment);
    if((await call('/hub/v2/machines/enroll',enrollment)).status!==409)throw new Error('Pairing reuse accepted');
    const browser=await open('/hub/v2/events/socket?projectId='+projectId,{headers:{Cookie:cookie,Origin:origin}});
    const socket=await open('/hub/v2/machines/socket',{protocols:['keryx.hub.machine.v2'],headers:{Authorization:'Bearer '+machine.secret}});
    const welcome=frame(socket);socket.send(JSON.stringify({v:2,type:'hello',messageId:randomUUID(),epoch:0,payload:{machineId:machine.machineId,ledgerId:'package-smoke-ledger',daemonId:'package-smoke-daemon',agentVersion:'package-smoke-v2',capabilities:['keryx-native-v1'],lastHubSequence:0,runCursors:[],sessionCursors:[]}}));
    const admitted=parseMachineFrame(await welcome,'hub-to-machine');if(!admitted.ok||admitted.value.type!=='welcome')throw new Error('Packaged machine handshake invalid');
    const heartbeat=frame(socket);socket.send(JSON.stringify({v:2,type:'heartbeat',messageId:randomUUID(),epoch:admitted.value.epoch,payload:{daemonId:'package-smoke-daemon'}}));
    const ack=parseMachineFrame(await heartbeat,'hub-to-machine');if(!ack.ok||ack.value.type!=='heartbeat-ack')throw new Error('Packaged heartbeat invalid');
    const closed=new Promise<number>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Revoked socket stayed open')),5000);socket.addEventListener('close',event=>{clearTimeout(timeout);resolve(event.code);},{once:true});});
    const metadata=await json<{version:number}>('/hub/v2/machines/'+machine.machineId);
    await json('/hub/v2/machines/'+machine.machineId+'/revoke',{expectedVersion:metadata.version});if(await closed!==1008)throw new Error('Revoked socket close code mismatch');
    browser.close();
    console.log('PASS: packaged v2 closed validator, agent/Origin denial, one-use enrollment, browser and machine WS, typed hello/heartbeat, revocation');
  }finally{for(const socket of sockets)socket.close();}
}
