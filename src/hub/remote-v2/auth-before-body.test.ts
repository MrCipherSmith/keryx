import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHubApplication } from '../server';

for (const route of ['/hub/v1/projects','/hub/v2/machines/pairings']) test(`protected ${route} authenticates before pulling an unauthenticated body`, async () => {
    const root=mkdtempSync(join(tmpdir(),'hub-auth-before-body-'));
    const app=createHubApplication({dataDir:root,operatorToken:'operator-'+'x'.repeat(64),agentToken:'agent-'+'y'.repeat(64),mutationQueue:{maxBodyReadMs:10}});
    let pulls=0;
    const stream=new ReadableStream<Uint8Array>({pull(){pulls++;}},{highWaterMark:0});
    try {
        const response=await app.fetch(new Request('http://127.0.0.1'+route,{method:'POST',headers:{'content-type':'application/json','idempotency-key':'unauthenticated-stream'},body:stream}));
        expect({status:response.status,body:await response.json()}).toMatchObject({status:401,body:{error:{code:'unauthorized'}}});
        expect(pulls).toBe(0);
    } finally {app.close();rmSync(root,{recursive:true,force:true});}
});
