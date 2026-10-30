import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError, getJson, postJson, resetClient, setAuthLossHandler } from '../src/api/client';
import { useDraftStore } from '../src/state/drafts';

describe('HTTP boundary and private state', () => {
 beforeEach(()=>{resetClient();setAuthLossHandler(()=>undefined);vi.restoreAllMocks();});
 test('uses same-origin credentials and XHR header, with no credential persistence', async()=>{
  const mocked=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({ok:true}));
  expect(await getJson('/projects')).toEqual({ok:true});
  const [url,init]=mocked.mock.calls[0]!;expect(url).toBe('/hub/v1/projects');expect(init?.credentials).toBe('same-origin');expect(new Headers(init?.headers).get('X-Requested-With')).toBe('XMLHttpRequest');
 });
 test('unknown POST outcome preserves operation key, changed payload and success get new keys',async()=>{
  const keys:string[]=[];let failure=true;
  vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{keys.push(new Headers(init?.headers).get('Idempotency-Key')!);if(failure)throw new TypeError('offline');return Response.json({ok:true});});
  await expect(postJson('/projects',{name:'A'})).rejects.toMatchObject({code:'network-error'});
  failure=false;await postJson('/projects',{name:'A'});await postJson('/projects',{name:'A'});await postJson('/projects',{name:'B'});
  expect(keys[0]).toBe(keys[1]);expect(keys[2]).not.toBe(keys[1]);expect(keys[3]).not.toBe(keys[2]);
 });
 test('session reset rejects late successful private responses',async()=>{
  let finish!:(r:Response)=>void;vi.spyOn(globalThis,'fetch').mockImplementation(()=>new Promise(r=>{finish=r;}));
  const pending=getJson('/projects');resetClient();finish(Response.json({projects:['old secret']}));await expect(pending).rejects.toMatchObject({name:'AbortError'});
 });
 test('401 and revoked role trigger loss; ordinary 403 does not',async()=>{
  const lost=vi.fn();setAuthLossHandler(lost);
  for(const [status,code] of [[401,'unauthorized'],[403,'access-denied'],[403,'human-required']] as const){vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(Response.json({error:{code,message:'No'}},{status}));await expect(getJson('/projects')).rejects.toBeInstanceOf(ApiError);}
  expect(lost).toHaveBeenCalledTimes(2);
 });
 test('expired Access HTML is not parsed or rendered as content',async()=>{
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('<script>evil</script>',{status:401,headers:{'Content-Type':'text/html'}}));
  await expect(getJson('/projects')).rejects.toMatchObject({status:401});
 });
 test('HTML proxy failures preserve identity while HTML authentication failures clear it',async()=>{
  const lost=vi.fn();setAuthLossHandler(lost);const mocked=vi.spyOn(globalThis,'fetch');
  mocked.mockResolvedValueOnce(new Response('<html>proxy unavailable</html>',{status:502,headers:{'Content-Type':'text/html'}}));
  await expect(getJson('/projects')).rejects.toMatchObject({status:502,code:'invalid-response'});expect(lost).not.toHaveBeenCalled();
  mocked.mockResolvedValueOnce(new Response('<html>Access login</html>',{status:401,headers:{'Content-Type':'text/html'}}));
  await expect(getJson('/projects')).rejects.toMatchObject({status:401});expect(lost).toHaveBeenCalledTimes(1);
 });
 test('operation capacity fails closed and preserves prior uncertain retry identity',async()=>{
  const keys:string[]=[];const mocked=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{keys.push(new Headers(init?.headers).get('Idempotency-Key')!);throw new TypeError('offline');});
  for(let index=0;index<100;index++)await expect(postJson('/projects',{name:String(index)})).rejects.toMatchObject({code:'network-error'});
  await expect(postJson('/projects',{name:'over capacity'})).rejects.toMatchObject({code:'pending-operation-limit'});expect(mocked).toHaveBeenCalledTimes(100);
  await expect(postJson('/projects',{name:'0'})).rejects.toMatchObject({code:'network-error'});expect(keys.at(-1)).toBe(keys[0]);
 });
 test('private drafts clear centrally' ,()=>{useDraftStore.getState().put('p1',{text:'private',version:1});expect(useDraftStore.getState().drafts.p1).toBeDefined();useDraftStore.getState().clearAll();expect(useDraftStore.getState().drafts).toEqual({});});
});
