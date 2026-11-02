import { AsyncLocalStorage } from 'node:async_hooks';
import { fail, HubFailure } from './domain';
export const mutationQueueDefaults = { maxPending:32, maxWaitMs:10000, maxRequests:32, maxRequestBytes:128*1024*1024, maxBodyReadMs:30000 } as const;
export type MutationQueueLimits = { [K in keyof typeof mutationQueueDefaults]: number };
type Entry = { start:()=>Promise<void>; refuse:(error:HubFailure)=>void };
/** Bounded admission and removable waiting jobs; cancelled jobs retain neither callback nor request body. */
export function createMutationQueue(overrides: Partial<MutationQueueLimits> = {}) {
    const limits={...mutationQueueDefaults,...overrides};
    for(const value of Object.values(limits)) if(!Number.isSafeInteger(value)||value<1) throw new TypeError('Invalid mutation queue limits');
    const requests=new AsyncLocalStorage<{signal:AbortSignal;admitted:boolean}>(), pending:Entry[]=[], settlers=new Set<()=>void>();
    let running=false, closed=false, requestCount=0, publicRequestCount=0, requestBytes=0;
    const idle=()=>{if(!running&&!pending.length){for(const resolve of settlers)resolve();settlers.clear();}};
    const drain=()=>{
        if(running)return;
        const next=pending.shift();if(!next){idle();return;}
        running=true;
        void next.start().finally(()=>{running=false;drain();});
    };
    const serialized = <T>(operation:()=>Promise<T>):Promise<T>=>{
        if(closed)return Promise.reject(new HubFailure(503,'hub-stopping','Hub is stopping'));
        const signal=requests.getStore()?.signal;
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
    const request = async<T>(original:Request,action:(admittedRequest:Request)=>Promise<T>, admission: 'public' | 'protected' = 'protected'):Promise<T>=>{
        const parent=requests.getStore();
        if(original.signal.aborted||parent?.signal.aborted){void original.body?.cancel().catch(()=>undefined);fail(499,'request-aborted','Request was aborted');}
        const mutating=['POST','PUT','PATCH','DELETE'].includes(original.method);
        if(!mutating)return requests.run({signal:parent?.signal??original.signal,admitted:parent?.admitted??false},()=>action(original));
        if(closed)fail(503,'hub-stopping','Hub is stopping');
        // MCP's internal apiFetch shares the authenticated root request slot. Each
        // physical body is still metered, including the inner serialized copy.
        const ownsSlot=!parent?.admitted;
        if(ownsSlot && (requestCount>=limits.maxRequests || (admission==='public' && publicRequestCount>=Math.max(1,Math.floor(limits.maxRequests/2))))) {
            void original.body?.cancel().catch(()=>undefined);
            fail(503,'hub-busy','Request slots exhausted');
        }
        if(ownsSlot){requestCount++;if(admission==='public')publicRequestCount++;}
        const abortController=new AbortController();
        const signal=AbortSignal.any([original.signal,abortController.signal,...(parent?[parent.signal]:[])]);
        let bytes=0, reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
        let timer:ReturnType<typeof setTimeout>|undefined, finished=false, failure:HubFailure|undefined;
        let target:ReadableStreamDefaultController<Uint8Array>|undefined;
        const clearDeadline=()=>{if(timer!==undefined){clearTimeout(timer);timer=undefined;}};
        const cancelSource=()=>{try{void (reader?reader.cancel():original.body?.cancel())?.catch(()=>undefined);return true;}catch{return false;}};
        const refuse=(error:HubFailure)=>{
            if(finished)return;
            failure=error;finished=true;clearDeadline();
            target?.error(error);abortController.abort(error);cancelSource();
        };
        const abort=()=>refuse(new HubFailure(499,'request-aborted','Request was aborted'));
        original.signal.addEventListener('abort',abort,{once:true});
        parent?.signal.addEventListener('abort',abort,{once:true});
        let result:T, cleanupError:{error:unknown}|undefined;
        try{
            const body=original.body?new ReadableStream<Uint8Array>({
                start(controller){target=controller;},
                async pull(controller){
                    if(finished)return;
                    if(!reader){reader=original.body!.getReader();timer=setTimeout(()=>refuse(new HubFailure(408,'request-timeout','Request body read timed out')),limits.maxBodyReadMs);}
                    try{
                        const part=await reader.read();
                        if(finished)return;
                        if(part.done){finished=true;clearDeadline();controller.close();return;}
                        if(requestBytes+part.value.byteLength>limits.maxRequestBytes){refuse(new HubFailure(503,'hub-busy','Request memory budget exhausted'));return;}
                        bytes+=part.value.byteLength;requestBytes+=part.value.byteLength;
                        controller.enqueue(part.value);
                    }catch(error){
                        if(!finished){finished=true;clearDeadline();controller.error(error);}
                    }
                },
                cancel(){finished=true;clearDeadline();cancelSource();},
            },{highWaterMark:0}):null;
            const admitted=body?new Request(original,{body,signal}):original;
            result=await requests.run({signal,admitted:true},()=>action(admitted));
            // A parser may translate stream errors to invalid-json. Admission
            // failures retain their real status even through such adapters.
            if(failure)throw failure;
        }catch(error){
            if(failure)throw failure;
            throw error;
        }finally{
            clearDeadline();original.signal.removeEventListener('abort',abort);parent?.signal.removeEventListener('abort',abort);
            finished=true;
            const cancellationRequested=cancelSource();
            try{
                try{reader?.releaseLock();}catch(error){
                    // Bun 1.3.14 native HTTP readers can throw TypeError here,
                    // even after EOF. Cancellation already owns source cleanup;
                    // optional lock release must not replace a valid response.
                    if(!cancellationRequested||!(error instanceof TypeError))cleanupError={error};
                }
            }finally{
                reader=undefined;
                requestBytes-=bytes;if(ownsSlot){requestCount--;if(admission==='public')publicRequestCount--;}
            }
        }
        if(cleanupError)throw cleanupError.error;
        return result;
    };
    return {serialized,request,settle:()=>!running&&!pending.length?Promise.resolve():new Promise<void>(resolve=>settlers.add(resolve)),close(){closed=true;for(const entry of [...pending])entry.refuse(new HubFailure(503,'hub-stopping','Hub is stopping'));}};
}
