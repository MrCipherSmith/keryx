import { AsyncLocalStorage } from 'node:async_hooks';
import { fail, HubFailure } from './domain';
export const mutationQueueDefaults = { maxPending:32, maxWaitMs:10000, maxRequests:32, maxRequestBytes:128*1024*1024 } as const;
export type MutationQueueLimits = { [K in keyof typeof mutationQueueDefaults]: number };
type Entry = { start:()=>Promise<void>; refuse:(error:HubFailure)=>void };
/** Bounded admission and removable waiting jobs; cancelled jobs retain neither callback nor request body. */
export function createMutationQueue(overrides: Partial<MutationQueueLimits> = {}) {
    const limits={...mutationQueueDefaults,...overrides};
    for(const value of Object.values(limits)) if(!Number.isSafeInteger(value)||value<1) throw new TypeError('Invalid mutation queue limits');
    const requests=new AsyncLocalStorage<AbortSignal>(), pending:Entry[]=[], settlers=new Set<()=>void>();
    let running=false, closed=false, requestCount=0, requestBytes=0;
    const idle=()=>{if(!running&&!pending.length){for(const resolve of settlers)resolve();settlers.clear();}};
    const drain=()=>{
        if(running)return;
        const next=pending.shift();if(!next){idle();return;}
        running=true;
        void next.start().finally(()=>{running=false;drain();});
    };
    const serialized = <T>(operation:()=>Promise<T>):Promise<T>=>{
        if(closed)return Promise.reject(new HubFailure(503,'hub-stopping','Hub is stopping'));
        const signal=requests.getStore();
        if(signal?.aborted)return Promise.reject(new HubFailure(499,'request-aborted','Request was aborted'));
        if(pending.length>=limits.maxPending)return Promise.reject(new HubFailure(503,'hub-busy','Mutation queue is full'));
        return new Promise<T>((resolve,reject)=>{
            let work:typeof operation|undefined=operation, settled=false;
            const remove=()=>{const index=pending.indexOf(entry);if(index>=0)pending.splice(index,1);};
            const cleanup=()=>{clearTimeout(timeout);signal?.removeEventListener('abort',abort);};
            const entry:Entry={
                async start(){
                    cleanup();
                    if(settled)return;
                    if(signal?.aborted){entry.refuse(new HubFailure(499,'request-aborted','Request was aborted'));return;}
                    const execute=work;work=undefined;
                    if(!execute)return;
                    settled=true;
                    try{resolve(await execute());}catch(error){reject(error);}
                },
                refuse(error){if(settled)return;settled=true;work=undefined;remove();cleanup();reject(error);idle();},
            };
            const abort=()=>entry.refuse(new HubFailure(499,'request-aborted','Request was aborted'));
            const timeout=setTimeout(()=>entry.refuse(new HubFailure(503,'hub-busy','Mutation queue wait expired')),limits.maxWaitMs);
            signal?.addEventListener('abort',abort,{once:true});
            pending.push(entry);queueMicrotask(drain);
        });
    };
    const request = async<T>(request:Request,action:()=>Promise<T>):Promise<T>=>{
        if(request.signal.aborted)fail(499,'request-aborted','Request was aborted');
        if(!['POST','PUT','PATCH','DELETE'].includes(request.method))return requests.run(request.signal,action);
        // Reserve each route's entire parser allowance. Content-Length is not trusted,
        // so a lying/chunked sender cannot exceed the aggregate memory budget.
        const bytes=new URL(request.url).pathname.startsWith('/hub/work/v1/')?64*1024:32*1024*1024;
        if(requestCount>=limits.maxRequests||requestBytes+bytes>limits.maxRequestBytes)fail(503,'hub-busy','Request memory budget exhausted');
        requestCount++;requestBytes+=bytes;
        try{return await requests.run(request.signal,action);}finally{requestCount--;requestBytes-=bytes;}
    };
    return {serialized,request,settle:()=>!running&&!pending.length?Promise.resolve():new Promise<void>(resolve=>settlers.add(resolve)),close(){closed=true;for(const entry of [...pending])entry.refuse(new HubFailure(503,'hub-stopping','Hub is stopping'));}};
}
