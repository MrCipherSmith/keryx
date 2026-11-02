import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHubApplication, type HubServerConfig } from './server';
import type { HubApplication } from './contracts';
const operator='test-operator-'+ 'a'.repeat(64), agent='test-agent-'+ 'b'.repeat(64);
const resources:{app:HubApplication;dir:string}[]=[];
function hub(mutationQueue:HubServerConfig['mutationQueue']={}){const dir=mkdtempSync(join(tmpdir(),'hub-request-admission-'));const app=createHubApplication({dataDir:dir,operatorToken:operator,agentToken:agent,mutationQueue});resources.push({app,dir});return app;}
afterEach(()=>{for(const {app,dir} of resources.splice(0)){app.close();rmSync(dir,{recursive:true,force:true});}});
function createRequest(index:number){return new Request('http://hub.test/hub/v1/projects',{method:'POST',headers:{Authorization:'Bearer '+operator,'Content-Type':'application/json','Idempotency-Key':'project-'+index},body:JSON.stringify({name:'Concurrent '+index})});}
test('HTTP admits seven concurrent small project mutations under the default memory budget',async()=>{const app=hub();const responses=await Promise.all(Array.from({length:7},(_,index)=>app.fetch(createRequest(index))));expect(responses.map(row=>row.status)).toEqual(Array(7).fill(200));});
test('HTTP MCP nested legacy write reuses the one admitted root request slot',async()=>{const app=hub({maxRequests:1,maxRequestBytes:128*1024*1024});const project=await (await app.fetch(createRequest(0))).json() as {id:string};const response=await app.fetch(new Request('http://hub.test/mcp',{method:'POST',headers:{Authorization:'Bearer '+agent,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'hub_create_revision',arguments:{projectId:project.id,operationId:'mcp-revision',baseRevisionId:null,gitBaseSha:'a'.repeat(40),message:'Exact review bundle',purpose:'review-bundle',changes:[{path:'change.patch',contentBase64:'YQ=='}]}}})}));expect(response.status).toBe(200);const result=await response.json() as {result:{isError?:boolean}};expect(result.result.isError).not.toBe(true);});
test('HTTP four public login trickles expire with408 without starving an authenticated mutation',async()=>{
 const app=hub({maxBodyReadMs:15,maxRequestBytes:1024});const sources:ReadableStreamDefaultController<Uint8Array>[]=[];
 const pending=Array.from({length:4},()=>app.fetch(new Request('http://hub.test/hub/v1/session',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://hub.test'},body:new ReadableStream<Uint8Array>({start(controller){sources.push(controller);}},{highWaterMark:0})})));
 const valid=await app.fetch(createRequest(1));
 const finished=Promise.all(pending);const responses=await Promise.race([finished,Bun.sleep(100).then(()=>null)]);
 if(!responses)for(const source of sources)source.error(new Error('test cleanup'));
 await finished;expect(valid.status).toBe(200);expect(responses?.map(response=>response.status)).toEqual([408,408,408,408]);
});
