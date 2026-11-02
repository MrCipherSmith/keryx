import { expect, test } from 'bun:test';
import { createMutationQueue } from './mutation-queue';

test('refuses a bounded waiting queue and cancels timed out callbacks without ghost execution', async () => {
    const queue=createMutationQueue({maxPending:1,maxWaitMs:20});
    let release!:()=>void, ran=false;
    const gate=new Promise<void>(resolve=>release=resolve);
    const first=queue.serialized(async()=>gate);
    await Promise.resolve();
    const waiting=queue.serialized(async()=>{ran=true;});
    await expect(queue.serialized(async()=>{})).rejects.toThrow('Mutation queue is full');
    await expect(waiting).rejects.toThrow('Mutation queue wait expired');
    release();await first;await queue.settle();
    expect(ran).toBe(false);queue.close();
});
test('drops an aborted queued request before its mutation callback can run', async () => {
    const queue=createMutationQueue({maxPending:2,maxWaitMs:1000});
    let release!:()=>void, ran=false;
    const first=queue.serialized(async()=>new Promise<void>(resolve=>release=resolve));
    await Promise.resolve();
    const controller=new AbortController();
    const waiting=queue.request(new Request('http://hub.test/hub/work/v1/projects/p/commands',{method:'POST',signal:controller.signal}),()=>queue.serialized(async()=>{ran=true;}));
    controller.abort();
    await expect(waiting).rejects.toThrow('Request was aborted');
    release();await first;await queue.settle();expect(ran).toBe(false);queue.close();
});
test('tiny concurrent mutations retain their actual bytes instead of a full parser allowance', async () => {
    const queue=createMutationQueue({maxRequestBytes:32*1024*1024});
    let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
    const calls=Array.from({length:7},()=>{const request=new Request('http://hub.test/hub/v2/control',{method:'POST',body:'{}'});return queue.request(request,async(admitted=request)=>{await admitted.text();await gate;return 'accepted';});});
    const settled=Promise.allSettled(calls);await Bun.sleep(5);release();
    expect((await settled).every(result=>result.status==='fulfilled')).toBe(true);queue.close();
});

test('nested MCP mutations share one root request slot and charge only actual bodies', async()=>{
    const queue=createMutationQueue({maxRequests:1,maxRequestBytes:128*1024*1024});
    const outer=new Request('http://hub.test/mcp',{method:'POST',body:'{"tool":"write"}'});
    const result=await queue.request(outer,async(admitted=outer)=>{await admitted.text();const inner=new Request('http://hub.test/hub/v1/projects',{method:'POST',body:'{}'});return queue.request(inner,async(next=inner)=>next.text());});
    expect(result).toBe('{}');queue.close();
});

test('body read deadline rejects a trickling request and releases its request slot', async()=>{
    const queue=createMutationQueue({maxRequests:1,maxBodyReadMs:15});
    let source!:ReadableStreamDefaultController<Uint8Array>;
    const request=new Request('http://hub.test/hub/v1/session',{method:'POST',body:new ReadableStream<Uint8Array>({start(controller){source=controller;}},{highWaterMark:0})});
    const pending=queue.request(request,async(admitted=request)=>admitted.text()).then(()=> 'unexpected',error=>error.code);
    const result=await Promise.race([pending,Bun.sleep(100).then(()=> 'unfinished')]);
    if(result==='unfinished')source.error(new Error('test cleanup'));
    await pending;
    expect(result).toBe('request-timeout');
    await expect(queue.request(new Request('http://hub.test/mcp',{method:'POST'}),async()=> 'accepted')).resolves.toBe('accepted');queue.close();
});

test('actual aggregate chunks enforce the budget without trusting Content-Length and release on refusal',async()=>{
    const queue=createMutationQueue({maxRequestBytes:8});
    const request=new Request('http://hub.test/hub/v1/projects',{method:'POST',headers:{'Content-Length':'1'},body:new ReadableStream({start(controller){controller.enqueue(new Uint8Array(9));controller.close();}})});
    await expect(queue.request(request,async(admitted=request)=>admitted.text())).rejects.toMatchObject({code:'hub-busy'});
    const retry=new Request('http://hub.test/hub/v1/projects',{method:'POST',body:'12345678'});
    await expect(queue.request(retry,async(admitted=retry)=>admitted.text())).resolves.toBe('12345678');queue.close();
});

test('body deadline stops after EOF so a slow Git action can finish normally',async()=>{
    const queue=createMutationQueue({maxBodyReadMs:10});const request=new Request('http://hub.test/hub/v1/projects/p/deliveries',{method:'POST',body:'{}'});
    await expect(queue.request(request,async(admitted=request)=>{await admitted.text();await Bun.sleep(30);return 'published';})).resolves.toBe('published');queue.close();
});

test('header-only refusal never pulls a body and cancels its source on cleanup',async()=>{
    const queue=createMutationQueue();let pulls=0,cancelled=false;
    const request=new Request('http://hub.test/hub/v1/projects',{method:'POST',body:new ReadableStream({pull(){pulls++;},cancel(){cancelled=true;}},{highWaterMark:0})});
    await queue.request(request,async()=> 'unauthorized');await Promise.resolve();expect(pulls).toBe(0);expect(cancelled).toBe(true);queue.close();
});

test('parsed bytes stay charged through the action and cancelled readers release capacity',async()=>{
    const queue=createMutationQueue({maxRequestBytes:8});let release!:()=>void,ready!:()=>void;const started=new Promise<void>(resolve=>ready=resolve);const gate=new Promise<void>(resolve=>release=resolve);
    const firstRequest=new Request('http://hub.test/hub/v1/projects',{method:'POST',body:'123456'});
    const first=queue.request(firstRequest,async(admitted=firstRequest)=>{await admitted.text();ready();await gate;});await started;
    const secondRequest=new Request('http://hub.test/hub/v1/projects',{method:'POST',body:'123'});
    await expect(queue.request(secondRequest,async(admitted=secondRequest)=>admitted.text())).rejects.toMatchObject({code:'hub-busy'});release();await first;
    const controller=new AbortController();let sourceCancelled=false;const thirdRequest=new Request('http://hub.test/mcp',{method:'POST',signal:controller.signal,body:new ReadableStream({pull(source){source.enqueue(new Uint8Array(8));},cancel(){sourceCancelled=true;}},{highWaterMark:0})});
    const third=queue.request(thirdRequest,async(admitted=thirdRequest)=>{const reader=admitted.body!.getReader();await reader.read();controller.abort();await reader.read();});
    await expect(third).rejects.toMatchObject({code:'request-aborted'});expect(sourceCancelled).toBe(true);
    const lastRequest=new Request('http://hub.test/hub/v1/projects',{method:'POST',body:'12345678'});await expect(queue.request(lastRequest,async(admitted=lastRequest)=>admitted.text())).resolves.toBe('12345678');queue.close();
});

test('read-only GET never consumes a mutation request slot',async()=>{
    const queue=createMutationQueue({maxRequests:1});let release!:()=>void;const first=queue.request(new Request('http://hub.test/mcp',{method:'POST'}),async()=>new Promise<void>(resolve=>release=resolve));
    await expect(queue.request(new Request('http://hub.test/healthz'),async()=> 'healthy')).resolves.toBe('healthy');release();await first;queue.close();
});

test('admission timeout retains its408 status when a parser throws a translated JSON error',async()=>{
    const queue=createMutationQueue({maxBodyReadMs:10});const request=new Request('http://hub.test/mcp',{method:'POST',body:new ReadableStream<Uint8Array>({pull(){}},{highWaterMark:0})});
    await expect(queue.request(request,async(admitted=request)=>{try{return await admitted.text();}catch{throw new Error('Invalid JSON');}})).rejects.toMatchObject({status:408,code:'request-timeout'});queue.close();
});

test('an aborted MCP root cannot admit a fresh internal mutation action',async()=>{
    const queue=createMutationQueue();const controller=new AbortController();let ran=false;
    const outer=new Request('http://hub.test/mcp',{method:'POST',signal:controller.signal});
    await expect(queue.request(outer,async()=>{controller.abort();return queue.request(new Request('http://hub.test/hub/v1/projects',{method:'POST'}),async()=>{ran=true;});})).rejects.toMatchObject({code:'request-aborted'});
    expect(ran).toBe(false);queue.close();
});
