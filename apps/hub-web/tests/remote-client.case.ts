import { beforeEach, expect, test, vi } from 'vitest';
import { remoteGet, remoteMutate } from '../src/api/remote';
import { resetClient } from '../src/api/client';

beforeEach(()=>{resetClient();vi.restoreAllMocks();});
test('v2 requests share same-origin credentials and do not pass through v1',async()=>{
 const mocked=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({sessions:[]}));
 await remoteGet('/projects/p/sessions');
 expect(mocked.mock.calls[0]?.[0]).toBe('/hub/v2/projects/p/sessions');
 expect(mocked.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
});
test('PUT PATCH DELETE retain unknown mutation identity, isolated by method and API version',async()=>{
 const keys:string[]=[];let offline=true;
 const mocked=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{keys.push(new Headers(init?.headers).get('Idempotency-Key')!);if(offline)throw new TypeError('offline');return Response.json({status:'applied'});});
 await expect(remoteMutate('PATCH','/projects/p/sessions/s/queue/q',{text:'a'})).rejects.toMatchObject({code:'network-error'});
 offline=false;await remoteMutate('PATCH','/projects/p/sessions/s/queue/q',{text:'a'});
 await remoteMutate('DELETE','/projects/p/sessions/s/queue/q',{version:1});
 expect(keys[0]).toBeTruthy();expect(keys[1]).toBe(keys[0]);expect(keys[2]).not.toBe(keys[1]);
 expect(mocked.mock.calls[2]?.[1]?.body).toBe('{"version":1}');
});
test('v2 private replies cannot survive identity reset',async()=>{
 let finish!:(r:Response)=>void;vi.spyOn(globalThis,'fetch').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=remoteGet('/projects/p/sessions');resetClient();finish(Response.json({sessions:['old']}));
 await expect(pending).rejects.toMatchObject({name:'AbortError'});
});
test('development proxy routes v2 and upgrades sockets while preserving Origin',async()=>{
 const source=await import('../vite.config');
 const proxy=source.default.server?.proxy?.['/hub/v2'];
 expect(proxy).toMatchObject({ws:true,changeOrigin:false});
});
