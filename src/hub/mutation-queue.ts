import { AsyncLocalStorage } from 'node:async_hooks';
import { fail, HubFailure } from './domain';
export const mutationQueueDefaults = { maxPending:32, maxWaitMs:10000, maxRequests:32, maxRequestBytes:128*1024*1024, maxBodyReadMs:30000 } as const;
export type MutationQueueLimits = { [K in keyof typeof mutationQueueDefaults]: number };
export type MutationQueueClock = { setTimeout(callback:()=>void, ms:number):unknown; clearTimeout(handle:unknown):void };
const systemClock:MutationQueueClock = { setTimeout:(callback,ms)=>setTimeout(callback,ms), clearTimeout:handle=>clearTimeout(handle as ReturnType<typeof setTimeout>) };
type Entry = { start:()=>Promise<void>; refuse:(error:HubFailure)=>void };
/** Bounded admission and removable waiting jobs; cancelled jobs retain neither callback nor request body. */
export function createMutationQueue(overrides: Partial<MutationQueueLimits> = {}, clock: MutationQueueClock = systemClock) {
    const limits={...mutationQueueDefaults,...overrides};
    for(const value of Object.values(limits)) if(!Number.isSafeInteger(value)||value<1) throw new TypeError('Invalid mutation queue limits');
    const requests=new AsyncLocalStorage<AbortSignal>(), pending:Entry[]=[], settlers=new Set<()=>void>();
    let running=false, closed=false, requestCount=0, requestBytes=0, limitedPending=0;
    const idle=()=>{if(!running&&!pending.length){for(const resolve of settlers)resolve();settlers.clear();}};
    const drain=()=>{
        if(running)return;
        const next=pending.shift();if(!next){idle();return;}
        running=true;
        void next.start().finally(()=>{running=false;drain();});
    };
    // Internal work (machine frames, disconnects, maintenance) has no HTTP client to retry a 503:
    // it waits in order without the waiter limit or deadline, and does not consume HTTP waiter capacity.
    const serialized = <T>(operation:()=>Promise<T>, options:{internal?:boolean}={}):Promise<T>=>{
        if(closed)return Promise.reject(new HubFailure(503,'hub-stopping','Hub is stopping'));
        const limited=!options.internal, signal=limited?requests.getStore():undefined;
        if(signal?.aborted)return Promise.reject(new HubFailure(499,'request-aborted','Request was aborted'));
        if(limited&&limitedPending>=limits.maxPending)return Promise.reject(new HubFailure(503,'hub-busy','Mutation queue is full'));
        return new Promise<T>((resolve,reject)=>{
            let work:typeof operation|undefined=operation, settled=false, queued=true;
            const dequeue=()=>{if(queued){queued=false;if(limited)limitedPending--;}};
            const remove=()=>{const index=pending.indexOf(entry);if(index>=0)pending.splice(index,1);dequeue();};
            const cleanup=()=>{if(timeout!==undefined)clock.clearTimeout(timeout);signal?.removeEventListener('abort',abort);};
            const entry:Entry={
                async start(){
                    dequeue();cleanup();
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
            const timeout=limited?clock.setTimeout(()=>entry.refuse(new HubFailure(503,'hub-busy','Mutation queue wait expired')),limits.maxWaitMs):undefined;
            signal?.addEventListener('abort',abort,{once:true});
            if(limited)limitedPending++;
            pending.push(entry);queueMicrotask(drain);
        });
    };
    const request = async<T>(request:Request,action:(admitted:Request)=>Promise<T>):Promise<T>=>{
        if(request.signal.aborted)fail(499,'request-aborted','Request was aborted');
        // An in-process call made while handling an admitted request (MCP's inner API fetch)
        // shares that request's admission instead of being counted a second time.
        if(!['POST','PUT','PATCH','DELETE'].includes(request.method)||requests.getStore())return requests.run(request.signal,()=>action(request));
        // Memory is accounted by the bytes actually buffered (a declared length is reserved up front),
        // so a lying/chunked sender cannot exceed the aggregate budget and a small body costs little.
        let held=0, counted=false, timer:unknown;
        const reserve=(bytes:number)=>{if(requestBytes+bytes>limits.maxRequestBytes)fail(503,'hub-busy','Request memory budget exhausted');requestBytes+=bytes;held+=bytes;};
        // The request slot is taken once the body is complete, so a slow sender holds only the bytes it sent.
        const count=()=>{if(requestCount>=limits.maxRequests)fail(503,'hub-busy','Request memory budget exhausted');requestCount++;counted=true;};
        try{
            if(!request.body){count();return await requests.run(request.signal,()=>action(request));}
            const declared=request.headers.get('content-length');
            if(declared&&/^\d+$/.test(declared)&&Number(declared)<=limits.maxRequestBytes)reserve(Number(declared));
            const source=request.body.getReader();
            let received=0, expired:HubFailure|undefined;
            // A body that is not fully received in time stops holding budget, authenticated or not.
            timer=clock.setTimeout(()=>{expired=new HubFailure(408,'request-timeout','Request body was not received in time');void source.cancel(expired).catch(()=>undefined);},limits.maxBodyReadMs);
            const body=new ReadableStream<Uint8Array>({
                async pull(controller){
                    try{
                        const next=await source.read();
                        if(expired)throw expired;
                        if(next.done){clock.clearTimeout(timer);requestBytes-=held-received;held=received;count();controller.close();return;}
                        received+=next.value.byteLength;if(received>held)reserve(received-held);
                        controller.enqueue(next.value);
                    }catch(error){clock.clearTimeout(timer);void source.cancel(error).catch(()=>undefined);throw error;}
                },
                cancel(reason){clock.clearTimeout(timer);return source.cancel(reason);},
            },{highWaterMark:0});
            const admitted=new Request(request.url,{method:request.method,headers:request.headers,body,signal:request.signal,duplex:'half'} as RequestInit);
            return await requests.run(request.signal,()=>action(admitted));
        }finally{clock.clearTimeout(timer);requestBytes-=held;if(counted)requestCount--;}
    };
    return {serialized,request,settle:()=>!running&&!pending.length?Promise.resolve():new Promise<void>(resolve=>settlers.add(resolve)),close(){closed=true;for(const entry of [...pending])entry.refuse(new HubFailure(503,'hub-stopping','Hub is stopping'));}};
}
