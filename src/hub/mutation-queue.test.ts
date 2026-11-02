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
const encoder=new TextEncoder();
const post=(body?:BodyInit|null,headers?:HeadersInit)=>new Request('http://hub.test/hub/v1/projects',{method:'POST',...(headers?{headers}:{}),...(body===undefined?{}:{body})});
function streamed(){
    let controller!:ReadableStreamDefaultController<Uint8Array>;
    const stream=new ReadableStream<Uint8Array>({start(value){controller=value;}});
    return {stream,send:(text:string)=>controller.enqueue(encoder.encode(text)),end:()=>controller.close()};
}
function fakeClock(){
    let next=0; const timers=new Map<number,()=>void>();
    return {clock:{setTimeout:(callback:()=>void)=>{timers.set(++next,callback);return next;},clearTimeout:(handle:unknown)=>{timers.delete(handle as number);}},
        fire(){const due=[...timers.values()];timers.clear();for(const callback of due)callback();}};
}
test('admits small concurrent mutations by their streamed bytes, not a flat per-route allowance', async () => {
    const queue=createMutationQueue();
    let release!:()=>void; const gate=new Promise<void>(resolve=>release=resolve);
    const held=Array.from({length:6},()=>queue.request(post('{"name":"x"}'),async admitted=>{await admitted.text();await gate;return 'ok';}));
    release();
    expect(await Promise.all(held)).toEqual(Array(6).fill('ok'));queue.close();
});
test('refuses the request whose streamed or declared bytes exceed the remaining budget and releases them on completion', async () => {
    const queue=createMutationQueue({maxRequestBytes:10});
    let release!:()=>void, read!:()=>void; const gate=new Promise<void>(resolve=>release=resolve), buffered=new Promise<void>(resolve=>read=resolve);
    const first=queue.request(post('12345678'),async admitted=>{await admitted.text();read();await gate;});
    await buffered;
    await expect(queue.request(post('12345'),async admitted=>admitted.text())).rejects.toThrow('Request memory budget exhausted');
    let pulled=false;
    const declared=new ReadableStream<Uint8Array>({pull(){pulled=true;}},{highWaterMark:0});
    await expect(queue.request(post(declared,{'content-length':'5'}),async admitted=>admitted.text())).rejects.toThrow('Request memory budget exhausted');
    expect(pulled).toBe(false);
    release();await first;
    await expect(queue.request(post('1234567890'),async admitted=>admitted.text())).resolves.toBe('1234567890');queue.close();
});
test('an in-process request made while handling an admitted request is not admitted a second time', async () => {
    const queue=createMutationQueue({maxRequests:1,maxRequestBytes:16});
    const outer=queue.request(post('12345678'),async admitted=>{
        await admitted.text();
        return queue.request(post('123456789012'),async inner=>inner.text());
    });
    await expect(outer).resolves.toBe('123456789012');queue.close();
});
test('a request body that is not received within the read deadline fails and releases its bytes', async () => {
    const time=fakeClock(), queue=createMutationQueue({maxRequestBytes:8,maxBodyReadMs:30000},time.clock);
    const slow=streamed();
    const stalled=queue.request(post(slow.stream),async admitted=>admitted.text());
    slow.send('1234');
    time.fire();
    await expect(stalled).rejects.toMatchObject({status:408,code:'request-timeout'});
    await expect(queue.request(post('12345678'),async admitted=>admitted.text())).resolves.toBe('12345678');queue.close();
});
test('internal serialized work is exempt from the HTTP waiter limit and wait deadline and does not consume it', async () => {
    const time=fakeClock(), queue=createMutationQueue({maxPending:1,maxWaitMs:10},time.clock);
    let release!:()=>void; const order:string[]=[];
    const running=queue.serialized(async()=>new Promise<void>(resolve=>release=resolve));
    await Promise.resolve();
    const frames=[1,2,3].map(index=>queue.serialized(async()=>{order.push('frame'+index);},{internal:true}));
    const http=queue.serialized(async()=>{order.push('http');});
    await expect(queue.serialized(async()=>{})).rejects.toThrow('Mutation queue is full');
    time.fire();
    await expect(http).rejects.toThrow('Mutation queue wait expired');
    release();await running;await Promise.all(frames);
    expect(order).toEqual(['frame1','frame2','frame3']);queue.close();
});
