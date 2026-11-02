import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHubApplication } from './server';

const operator='operator-'+'x'.repeat(64), agent='agent-'+'y'.repeat(64);
const encoder=new TextEncoder();
function hub(mutationQueue?:Parameters<typeof createHubApplication>[0]['mutationQueue']){
    const dir=mkdtempSync(join(tmpdir(),'hub-request-admission-'));
    const app=createHubApplication({dataDir:dir,operatorToken:operator,agentToken:agent,...(mutationQueue?{mutationQueue}:{})});
    return {app,dispose(){app.close();rmSync(dir,{recursive:true,force:true});}};
}
const rest=(app:ReturnType<typeof hub>['app'],path:string,body:unknown,key=crypto.randomUUID())=>app.fetch(new Request('http://127.0.0.1/hub/v1'+path,{method:'POST',headers:{authorization:'Bearer '+operator,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)}));
/** A body that sends its first bytes, then stays open until ended. */
function trickle(first:string){
    let entered!:()=>void, end!:()=>void, sent=false;
    const started=new Promise<void>(resolve=>entered=resolve), ended=new Promise<void>(resolve=>end=resolve);
    const stream=new ReadableStream<Uint8Array>({async pull(controller){
        if(!sent){sent=true;controller.enqueue(encoder.encode(first));entered();return;}
        await ended;controller.close();
    }},{highWaterMark:0});
    return {stream,started,end};
}

/** Resolves once the Hub reads the body; fails at once when the request is refused unread. */
const admitted=(body:ReturnType<typeof trickle>,response:Promise<Response>)=>Promise.race([body.started,response.then(value=>{throw new Error('refused unread: '+value.status);})]);

test('slow unauthenticated bodies hold only their streamed bytes, so an operator mutation is still admitted under defaults', async () => {
    const {app,dispose}=hub();
    const slow=Array.from({length:5},()=>trickle('{"title":'));
    try {
        const held=slow.map((body,index)=>app.fetch(new Request(`http://127.0.0.1/hub/v2/projects/p${index}/sessions`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':'k'+index},body:body.stream})));
        await Promise.all(slow.map((body,index)=>admitted(body,held[index]!)));
        const created=await rest(app,'/projects',{name:'admitted'});
        expect(created.status).toBe(200);
        for(const body of slow)body.end();
        for(const response of await Promise.all(held))expect(response.status).not.toBe(503);
    } finally { dispose(); }
});

test('a declared body larger than the remaining budget is refused before it is read, and the budget is released afterwards', async () => {
    const {app,dispose}=hub({maxRequestBytes:32});
    const first=trickle('{"name":"first"');
    let rejectedPulls=0;
    try {
        const held=app.fetch(new Request('http://127.0.0.1/hub/v1/projects',{method:'POST',headers:{authorization:'Bearer '+operator,'content-type':'application/json','idempotency-key':'first'},body:first.stream}));
        await admitted(first,held);
        const rejectedBody=new ReadableStream<Uint8Array>({pull(){rejectedPulls++;}},{highWaterMark:0});
        const refused=await app.fetch(new Request('http://127.0.0.1/hub/v1/projects',{method:'POST',headers:{authorization:'Bearer '+operator,'content-type':'application/json','idempotency-key':'refused','content-length':'20'},body:rejectedBody}));
        expect(refused.status).toBe(503);expect(refused.headers.get('retry-after')).toBe('1');expect(rejectedPulls).toBe(0);
        first.end();expect((await held).status).toBe(400);
        expect((await rest(app,'/projects',{name:'second'})).status).toBe(200);
    } finally { dispose(); }
});

test('an MCP write is admitted once: its inner API request does not take a second request slot', async () => {
    const {app,dispose}=hub({maxRequests:1});
    try {
        const project=await (await rest(app,'/projects',{name:'MCP'})).json() as {id:string};
        const imported=await (await rest(app,`/projects/${project.id}/import`,{expectedVersion:1,sourceRevision:'fixture',documents:[{path:'specs/task.md',kind:'spec',content:'# task'}]})).json() as {documents:{id:string}[]};
        let flow=await (await rest(app,`/projects/${project.id}/flows`,{title:'MCP',specDocumentId:imported.documents[0]!.id,criteria:['Human accepts']})).json() as {id:string;version:number};
        flow=await (await rest(app,`/projects/${project.id}/flows/${flow.id}/freeze`,{expectedVersion:flow.version})).json() as {id:string;version:number};
        const call=await app.fetch(new Request('http://127.0.0.1/mcp',{method:'POST',headers:{authorization:'Bearer '+agent,'content-type':'application/json',accept:'application/json, text/event-stream'},
            body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'hub_start_flow',arguments:{projectId:project.id,flowId:flow.id,expectedVersion:flow.version,operationId:'start-one'}}})}));
        const result=(await call.json() as {result:{isError?:boolean;content:{text:string}[]}}).result;
        expect(result.isError).toBeUndefined();
        expect(JSON.parse(result.content[0]!.text).status).toBe('in-progress');
    } finally { dispose(); }
});
