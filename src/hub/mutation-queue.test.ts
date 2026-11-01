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
test('reserves request memory before consuming a streamed body and releases the reservation on completion', async () => {
    const queue=createMutationQueue({maxRequestBytes:32*1024*1024,maxRequests:2});
    let release!:()=>void, pulled=false;
    const first=queue.request(new Request('http://hub.test/hub/v1/projects',{method:'POST'}),async()=>new Promise<void>(resolve=>release=resolve));
    const body=new ReadableStream({pull(){pulled=true;}},{highWaterMark:0});
    await expect(queue.request(new Request('http://hub.test/hub/v1/projects',{method:'POST',body}),async()=>{})).rejects.toThrow('Request memory budget exhausted');
    // The queue never asks the rejected request for its bytes.
    expect(pulled).toBe(false);
    release();await first;
    await expect(queue.request(new Request('http://hub.test/hub/v1/projects',{method:'POST'}),async()=> 'accepted')).resolves.toBe('accepted');queue.close();
});
