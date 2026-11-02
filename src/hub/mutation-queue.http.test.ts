import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHubApplication } from './server';

test('HTTP admission bounds actual retained streamed bytes and releases its memory lease', async () => {
    const dir=mkdtempSync(join(tmpdir(),'hub-request-admission-')), token='operator-'+'x'.repeat(64);
    const app=createHubApplication({dataDir:dir,operatorToken:token,agentToken:'agent-'+'y'.repeat(64),mutationQueue:{maxRequestBytes:16,maxBodyReadMs:1000}});
    let finish=()=>{}, entered!:()=>void, firstPulls=0, rejectedPulls=0, rejectedCancelled=false;
    const started=new Promise<void>(resolve=>entered=resolve);
    const headers={authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':'first'};
    const firstBody=new ReadableStream<Uint8Array>({
        start(controller){finish=()=>{finish=()=>{};controller.close();};},
        pull(controller){
            if(firstPulls++===0)controller.enqueue(new TextEncoder().encode('{"name":"first"}'));
            // The parser asks for its next chunk only after retaining the first
            // sixteen bytes. EOF stays behind the test's explicit gate.
            else entered();
        },
    },{highWaterMark:0});
    const first=app.fetch(new Request('http://hub.test/hub/v1/projects',{method:'POST',headers,body:firstBody}));
    try {
        await started;
        const rejectedBody=new ReadableStream<Uint8Array>({pull(controller){rejectedPulls++;controller.enqueue(new Uint8Array([123]));},cancel(){rejectedCancelled=true;}},{highWaterMark:0});
        const refused=await app.fetch(new Request('http://hub.test/hub/v1/projects',{method:'POST',headers:{...headers,'idempotency-key':'overflow'},body:rejectedBody}));
        expect(refused.status).toBe(503);expect(refused.headers.get('retry-after')).toBe('1');
        expect(rejectedPulls).toBe(1);expect(rejectedCancelled).toBe(true);
        finish();expect((await first).status).toBe(200);
        const next=await app.fetch(new Request('http://hub.test/hub/v1/projects',{method:'POST',headers:{...headers,'idempotency-key':'second'},body:'{"name":"ok"}'}));
        expect(next.status).toBe(200);
    } finally { finish();await first;app.close();rmSync(dir,{recursive:true,force:true}); }
});
