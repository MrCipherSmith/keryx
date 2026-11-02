import type { GitDeliveryAdapter, GitDeliveryRequest, Principal } from './contracts';
import type { DeliveryJob } from './delivery-jobs';
import type { HubStore } from './store';
import { completeGitDelivery, fail, HubFailure, object, prepareGitDelivery, recordGitDeliveryResult, sha256, text } from './domain';

type Result = { body: unknown; status: number; headers?: Record<string,string> };
type Ports = {
    store: HubStore; dataDir: string;
    serialized<T>(operation: () => Promise<T>): Promise<T>;
    deliver: GitDeliveryAdapter; inspect: GitDeliveryAdapter;
};
type Authority = { actor: Principal; reauthorize(): Promise<Principal> };
type RecoveryInput = Authority & {projectId:string;jobId:string;body:unknown;key:string;digest:string};
type PreparedRecovery = {kind:'replay';body:unknown} | {kind:'job';job:DeliveryJob;reason:string;decision:NonNullable<DeliveryJob['reconciliation']>['decision'];expectedVersion:unknown};
/** One durable publication use case; HTTP supplies authority, not Git effects or job state. */
export function createDeliveryService({store,dataDir,serialized,deliver,inspect}: Ports) {
    const inFlight = new Set<string>(), settlers = new Set<() => void>();
    let reconciling = 0;
    const notifySettled = () => { if (!inFlight.size && !reconciling) { for (const resolve of settlers) resolve(); settlers.clear(); } };
    const operator = (actor: Principal, projectId: string) => {
        if (actor.kind !== 'human' || actor.role !== 'operator' || actor.readOnly) fail(403,'human-required','Current human operator required');
        if (!store.project(projectId) || actor.projectIds && !actor.projectIds.includes(projectId)) fail(404,'not-found','Project not found');
    };
    const requestFor = (job: DeliveryJob): GitDeliveryRequest => {
        const revision = store.load().revisions.find(revision => revision.projectId === job.projectId && revision.id === job.revisionId);
        if (!revision) fail(409,'delivery-revision-unavailable','Reserved immutable revision is unavailable');
        return {dataDir,projectId:job.projectId,operationId:job.id,revision,remoteUrl:job.remoteUrl,baseBranch:job.baseBranch};
    };
    const scopedJob = (actor: Principal, projectId: string, id: string): DeliveryJob => {
        operator(actor,projectId);
        const job = store.deliveries.get(id);
        if (!job || job.projectId !== projectId) fail(404,'not-found','Delivery job not found');
        return job;
    };
    const recordResult = (job: DeliveryJob, actor: Principal, request: GitDeliveryRequest) => {
        job.status = 'result';
        // Persist the exact adapter result even if later legacy persistence or
        // authority checks fail. Reconciliation can retry recording, never Git.
        store.workTransaction(() => store.deliveries.save(job));
        store.writeTransaction(state => recordGitDeliveryResult(state,actor,request,job.result!));
    };
    const finalize = (job: DeliveryJob, actor: Principal, request: GitDeliveryRequest): Result => store.writeTransaction(state => {
        const replay = state.replays[job.replayKey];
        if (replay) return {body:replay.body,status:replay.status};
        let body: unknown, status = 200;
        try { body = completeGitDelivery(state,actor,request,job.result!,job.expectedLineVersion); }
        catch (error) {
            if (!(error instanceof HubFailure)) throw error;
            status = error.status;
            body = {error:{code:error.code,message:error.message},operationId:job.id,externalResult:job.result};
        }
        job.status='completed';job.response=body;job.httpStatus=status;store.deliveries.save(job);
        state.replays[job.replayKey]={digest:job.requestDigest,body,status};
        return {body,status};
    });
    async function run(input: Authority & {projectId:string;body:unknown;key:string;digest:string}): Promise<Result> {
        const prepared = await serialized(async () => {
            const actor = await input.reauthorize(); operator(actor,input.projectId);
            const pathname = `/hub/v1/projects/${input.projectId}/deliveries`;
            const replayKey = sha256(JSON.stringify([actor.id,'POST',pathname,input.key]));
            return store.workTransaction(() => {
                const state = store.load(), replay = state.replays[replayKey];
                if (replay) {
                    if (replay.digest !== input.digest) fail(409,'idempotency-conflict','Idempotency key was already used for another payload');
                    return {response:{body:replay.body,status:replay.status}};
                }
                const id = 'delivery-' + replayKey.slice(0,32), existing = store.deliveries.get(id);
                if (existing) {
                    if (existing.actorId !== actor.id || existing.requestDigest !== input.digest) fail(409,'idempotency-conflict','Delivery operation payload changed');
                    if (existing.status === 'completed') return {response:{body:existing.response,status:existing.httpStatus ?? 200}};
                    if (inFlight.has(id)) return {response:{body:{operationId:id,status:'pending'},status:202,headers:{'Retry-After':'1'}}};
                    if (existing.status === 'pending' || existing.status === 'uncertain') {
                        if (existing.status !== 'uncertain') {existing.status='uncertain';store.deliveries.save(existing);}
                        return {response:{body:{operationId:id,error:{code:'delivery-uncertain',message:'Inspect the delivery job and reconcile its external outcome as a human operator'}},status:409}};
                    }
                    const request=requestFor(existing);inFlight.add(id);return {job:existing,request,actor};
                }
                const request = prepareGitDelivery(state,actor,input.projectId,input.body,dataDir,id);
                const job: DeliveryJob = {id,replayKey,actorId:actor.id,projectId:input.projectId,requestDigest:input.digest,expectedLineVersion:Number(object(input.body).expectedLineVersion),revisionId:request.revision.id,remoteUrl:request.remoteUrl,baseBranch:request.baseBranch,status:'pending'};
                store.deliveries.reserve(job);inFlight.add(id);
                return {job,request,actor};
            });
        });
        if ('response' in prepared && prepared.response) return prepared.response;
        if (!prepared.job || !prepared.request || !prepared.actor) fail(503,'delivery-unavailable','Delivery reservation unavailable');
        const {job,request,actor} = prepared;
        try {
            if (!job.result) {
                try {job.result=await deliver(request);}
                catch {
                    job.status='uncertain';
                    store.workTransaction(()=>store.deliveries.save(job));
                    return {status:409,body:{operationId:job.id,error:{code:'delivery-uncertain',message:'Publication outcome is unknown; inspect and reconcile the original delivery before starting another'}}};
                }
                recordResult(job,actor,request);
            }
            return await serialized(async () => {
                const current = await input.reauthorize();operator(current,job.projectId);
                if (current.id !== job.actorId) fail(403,'identity-changed','Current delivery authority changed');
                return finalize(job,current,request);
            });
        } finally {
            inFlight.delete(job.id);
            notifySettled();
        }
    }
    const recoveryKey = (input: RecoveryInput, action: 'reconcile' | 'archive', actor: Principal) => {
        if (actor.id !== input.actor.id) fail(403,'identity-changed','Recovery authority changed');
        return sha256(JSON.stringify([actor.id,'POST',`/hub/v1/projects/${input.projectId}/delivery-jobs/${input.jobId}/${action}`,input.key]));
    };
    const recoveryReplay = (key: string, digest: string) => {
        const replay=store.load().replays[key];
        if (replay && replay.digest !== digest) fail(409,'idempotency-conflict','Idempotency key was already used for another payload');
        return replay;
    };
    async function reconcile(input: RecoveryInput): Promise<unknown> {
        const prepared = await serialized<PreparedRecovery>(async () => {
            const actor = await input.reauthorize(), job=scopedJob(actor,input.projectId,input.jobId);
            const replay=recoveryReplay(recoveryKey(input,'reconcile',actor),input.digest);
            if (replay) return {kind:'replay' as const,body:replay.body};
            const body = object(input.body);
            if (Object.keys(body).some(key => !['expectedVersion','decision','reason'].includes(key))) fail(400,'invalid-arguments','Unknown reconciliation field');
            const reason = text(body.reason,'reason',2000), expectedVersion = body.expectedVersion;
            const decision = body.decision;
            if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion)<1 || (decision !== 'confirm-no-effect' && decision !== 'finalize-recorded-result' && decision !== 'inspect-publication')) fail(400,'invalid-arguments','Exact current job version and explicit reconciliation decision required');
            if (job.version !== expectedVersion) fail(409,'version-conflict','Delivery job changed; reload before reconciling');
            if (!['uncertain','result'].includes(job.status) || inFlight.has(job.id)) fail(409,'invalid-state','Only interrupted or recorded delivery outcomes can be reconciled');
            if (decision === 'confirm-no-effect' && job.result?.status === 'published') fail(409,'published-result-exists','A recorded publication cannot be declared absent');
            if (inFlight.size >= 2) fail(503,'hub-busy','Concurrent delivery reconciliation quota exceeded');
            inFlight.add(job.id);
            return {kind:'job' as const,job,reason,decision,expectedVersion};
        });
        if (prepared.kind === 'replay') return prepared.body;
        const {job,reason,decision,expectedVersion}=prepared;
        reconciling++;
        try {
            const request = requestFor(job);
            let result = job.result;
            if (decision === 'inspect-publication') {
                result = await inspect(request);
                if (result.status !== 'published') fail(409,'publication-unconfirmed','Read-only Git inspection could not verify the original managed publication');
            }
            if (decision === 'finalize-recorded-result' && !result) fail(409,'delivery-result-unavailable','No server-recorded result is available; inspect publication or explicitly confirm no effect');
            return await serialized(async () => {
                const actor = await input.reauthorize();scopedJob(actor,input.projectId,input.jobId);
                const key=recoveryKey(input,'reconcile',actor);
                return store.writeTransaction(state => {
                    const current = store.deliveries.get(job.id)!;
                    if (current.version !== expectedVersion) fail(409,'version-conflict','Delivery job changed during reconciliation');
                    if (decision === 'confirm-no-effect') {
                        current.status='completed';current.httpStatus=409;current.response={operationId:current.id,error:{code:'delivery-no-effect',message:'Human operator confirmed no external publication'}};
                    } else {
                        if (!result) fail(409,'delivery-result-unavailable','No server-verified result is available');
                        current.result=result;current.status='completed';current.httpStatus=200;
                        current.response=recordGitDeliveryResult(state,actor,request,result!);
                    }
                    current.reconciliation={actorId:actor.id,decision,reason,recordedAt:new Date().toISOString()};
                    store.deliveries.save(current,Number(expectedVersion));
                    state.replays[current.replayKey]={digest:current.requestDigest,body:current.response,status:current.httpStatus!};
                    state.replays[key]={digest:input.digest,body:current,status:200};
                    return current;
                });
            });
        } finally { inFlight.delete(job.id); reconciling--; notifySettled(); }
    }
    async function archive(input: RecoveryInput): Promise<unknown> {
        return serialized(async () => {
            const actor=await input.reauthorize();scopedJob(actor,input.projectId,input.jobId);
            const key=recoveryKey(input,'archive',actor), replay=recoveryReplay(key,input.digest);
            if (replay) return replay.body;
            const body=object(input.body), reason=text(body.reason,'reason',2000);
            if (Object.keys(body).some(key=>!['expectedVersion','reason'].includes(key)) || !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion)<1) fail(400,'invalid-arguments','Exact current job version and archive reason required');
            return store.writeTransaction(state=>{
                const archived=store.deliveries.archive(input.jobId,Number(body.expectedVersion),actor.id,reason);
                state.replays[key]={digest:input.digest,body:archived,status:200};
                return archived;
            });
        });
    }
    return {run,reconcile,archive,authorize:operator,read:scopedJob,list(actor:Principal,projectId:string){operator(actor,projectId);return store.deliveries.list(projectId);},settle:()=>!inFlight.size&&!reconciling?Promise.resolve():new Promise<void>(resolve=>settlers.add(resolve))};
}
