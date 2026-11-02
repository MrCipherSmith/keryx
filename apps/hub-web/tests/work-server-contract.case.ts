import { expect, test, vi } from 'vitest';
import { createWorkHttp } from '../../../src/hub/work/http';
import type { HubStore } from '../../../src/hub/store';
import { liveWorkAdapter } from '../src/features/managed-work/adapter';
import { demoWorkAdapter } from '../src/features/managed-work/demo';
import { recordOf } from '../src/features/managed-work/model';
import { resetClient } from '../src/api/client';

test('the Team Hub adapter accepts the production-served attention page with incident Evidence',async()=>{
    resetClient();
    const evidence={...recordOf((await demoWorkAdapter('p').snapshot()).records,'evidence','ev-agent')!,result:'fail' as const,report:'Post-acceptance contradiction'};
    // SQL selection and post-acceptance scenario semantics stay covered by the
    // root HTTP contract tests. Here the narrow repository port isolates the
    // production HTTP serializer -> browser validator boundary in its own runtime.
    const store={project:(id:string)=>id==='p'?{id}:undefined,work:{cursorSecret:()=>'s'.repeat(64),currentSequence:()=>1,attentionPage:()=>({records:[evidence],nextCursor:null,eventCursor:1})}} as unknown as HubStore;
    const http=createWorkHttp({store,enabled:true,authenticate:async()=>({actor:{id:'human:test',kind:'human',role:'operator'},cookie:false}),checkOrigin:()=>undefined,serialized:operation=>operation(),now:()=>Date.parse('2026-11-01T00:00:00Z')});
    const served:Response[]=[];
    vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{const request=new Request(new URL(String(input),'http://localhost'),init);const response=(await http.handle(request))??new Response(null,{status:404});served.push(response.clone());return response;});
    const page=await liveWorkAdapter('p').attention();
    expect(served).toHaveLength(1);expect(served[0]!.status).toBe(200);
    expect((await served[0]!.json()).records).toContainEqual(evidence);
    expect(page.records).toContainEqual(evidence);
});
