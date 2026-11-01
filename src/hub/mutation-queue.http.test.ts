import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHubApplication } from './server';

test('HTTP admission refuses before buffering another streamed request and releases its memory lease', async () => {
    const dir=mkdtempSync(join(tmpdir(),'hub-request-admission-')), token='operator-'+'x'.repeat(64);
    const app=createHubApplication({dataDir:dir,operatorToken:token,agentToken:'agent-'+'y'.repeat(64),mutationQueue:{maxRequestBytes:32*1024*1024}});
    let finish!:()=>void, entered!:()=>void, rejectedPulls=0;
    const started=new Promise<void>(resolve=>entered=resolve);
    const headers={authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':'first'};
    const firstBody=new ReadableStream<Uint8Array>({start(controller){finish=()=>{controller.enqueue(new TextEncoder().encode('{"name":"first"}'));controller.close();};},pull(){entered();}},{highWaterMark:0});
    try {
        const first=app.fetch(new Request('http://hub.test/hub/v1/projects',{method:'POST',headers,body:firstBody}));
        await started;
        const rejectedBody=new ReadableStream<Uint8Array>({pull(){rejectedPulls++;}},{highWaterMark:0});
        const refused=await app.fetch(new Request('http://hub.test/hub/v1/projects',{method:'POST',headers,body:rejectedBody}));
        expect(refused.status).toBe(503);expect(refused.headers.get('retry-after')).toBe('1');expect(rejectedPulls).toBe(0);
        finish();expect((await first).status).toBe(200);
        const next=await app.fetch(new Request('http://hub.test/hub/v1/projects',{method:'POST',headers:{...headers,'idempotency-key':'second'},body:'{"name":"second"}'}));
        expect(next.status).toBe(200);
    } finally { app.close();rmSync(dir,{recursive:true,force:true}); }
});
