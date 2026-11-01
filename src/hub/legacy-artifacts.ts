import type { Database } from 'bun:sqlite';
import type { CodeRevision, RevisionFile } from './contracts';
import type { HubState } from './store';
import { fail, sha256 } from './domain';
import { LEGACY_ARTIFACT_WRITER_VERSION } from './remote-v2/storage';
import { legacyStorageLimits } from './legacy-limits';
export { legacyStorageLimits } from './legacy-limits';
/** Binary payloads are immutable, content addressed and never swept by transient retention. */
export function legacyArtifacts(db:Database){
    db.exec(`CREATE TABLE IF NOT EXISTS hub_revision_blobs(digest TEXT PRIMARY KEY,content_base64 TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS hub_revision_blob_usage(id INTEGER PRIMARY KEY CHECK(id=1),bytes INTEGER NOT NULL,count INTEGER NOT NULL);
    INSERT OR IGNORE INTO hub_revision_blob_usage SELECT 1,coalesce(sum(length(content_base64)),0),count(*) FROM hub_revision_blobs;
    CREATE TRIGGER IF NOT EXISTS hub_revision_blob_insert AFTER INSERT ON hub_revision_blobs BEGIN UPDATE hub_revision_blob_usage SET bytes=bytes+length(new.content_base64),count=count+1 WHERE id=1; END;`);
    const blob=db.query<{content_base64:string},[string]>('SELECT content_base64 FROM hub_revision_blobs WHERE digest=?');
    const metadataRevision=(revision:CodeRevision)=>Array.isArray(revision.files)?{...revision,files:revision.files.map(file=>{
        const encoded=Object.getOwnPropertyDescriptor(file,'contentBase64')?.value as unknown;
        const blobDigest=typeof encoded==='string'?sha256(encoded):(file as RevisionFile & {blobDigest?:string}).blobDigest??file.contentDigest;
        return {path:file.path,mode:file.mode,contentDigest:file.contentDigest,blobDigest};
    })}:revision;
    const hydrateRevision=(revision:CodeRevision):CodeRevision=>{
        for(const file of revision.files??[])if(typeof Object.getOwnPropertyDescriptor(file,'contentBase64')?.value!=='string'){
            const encodedDigest=(file as RevisionFile & {blobDigest?:string}).blobDigest;
            if(encodedDigest)Object.defineProperty(file,'blobDigest',{enumerable:false});
            Object.defineProperty(file,'contentBase64',{enumerable:true,configurable:true,get(){
                const result=blob.get(encodedDigest??file.contentDigest);
                if(!result)fail(409,'artifact-unavailable','Immutable revision file bytes are unavailable; restore the complete backup');
                if(sha256(Buffer.from(result.content_base64,'base64'))!==file.contentDigest||encodedDigest&&sha256(result.content_base64)!==encodedDigest)fail(409,'artifact-integrity','Immutable revision file bytes changed');
                return result.content_base64;
            }});
        }
        return revision;
    };
    const hydrate=(state:HubState):HubState=>{
        const revisions=new Map(state.revisions.map(revision=>[revision.id,hydrateRevision(revision)]));
        for(const replay of Object.values(state.replays))if(replay.revisionId){
            Object.defineProperty(replay,'body',{enumerable:false,configurable:true,get(){
                const revision=revisions.get(replay.revisionId!);
                if(!revision)fail(409,'artifact-unavailable','Replayed immutable revision is unavailable');
                return revision;
            }});
        }
        return state;
    };
    const snapshot=(state:HubState)=>{
        const ids=new Set(state.revisions.map(revision=>revision.id));
        const replays=Object.fromEntries(Object.entries(state.replays).map(([key,replay])=>{
            const value=replay.revisionId?undefined:replay.body;
            const id=replay.revisionId??(value&&typeof value==='object'&&'id' in value&&typeof value.id==='string'&&ids.has(value.id)?value.id:undefined);
            return[key,id?{digest:replay.digest,status:replay.status,revisionId:id}:{digest:replay.digest,status:replay.status,body:value}];
        }));
        const {legacyConversions:unused,...durable}=state;void unused;
        return {...durable,revisions:state.revisions.map(metadataRevision),replays};
    };
    const serialize=(state:HubState)=>JSON.stringify(snapshot(state));
    const persist=(state:HubState,allowExisting=false,previous?:HubState)=>{
        const before=db.query<{bytes:number;count:number},[]>('SELECT bytes,count FROM hub_revision_blob_usage WHERE id=1').get()!;
        const put=db.query('INSERT OR IGNORE INTO hub_revision_blobs(digest,content_base64) VALUES(?,?)');
        for(const revision of state.revisions)for(const file of revision.files??[]){
            const value=Object.getOwnPropertyDescriptor(file,'contentBase64')?.value as unknown;
            if(typeof value!=='string')continue;
            if(sha256(Buffer.from(value,'base64'))!==file.contentDigest)fail(409,'artifact-integrity','Revision content digest does not match its file bytes');
            put.run(sha256(value),value);
        }
        if(!allowExisting){
            const usage=db.query<{bytes:number;count:number},[]>('SELECT bytes,count FROM hub_revision_blob_usage WHERE id=1').get()!;
            if(usage.bytes>legacyStorageLimits.maxBlobBytes&&usage.bytes>before.bytes||usage.count>legacyStorageLimits.maxBlobs&&usage.count>before.count)fail(413,'quota-exceeded','Legacy immutable artifact quota exceeded; explicitly archive the project before adding more artifacts');
        }
        // Prune only transient invalidation/delta windows. Accepted artifacts and receipts remain durable.
        state.events=state.events.slice(-legacyStorageLimits.retainedEvents);
        state.documentChanges=state.documentChanges.slice(-legacyStorageLimits.retainedDocumentChanges);
        const body=serialize(state);
        if(!allowExisting){
            const bytes=Buffer.byteLength(body),previousBytes=previous?Buffer.byteLength(serialize(previous)):0;
            const replayCount=Object.keys(state.replays).length,previousReplays=previous?Object.keys(previous.replays).length:0;
            const collections=['projects','documents','proposals','flows','evidence','revisions','deliveries'] as const;
            if(bytes>legacyStorageLimits.maxMetadataBytes&&bytes>previousBytes||replayCount>legacyStorageLimits.maxReplayRecords&&replayCount>previousReplays||collections.some(key=>state[key].length>legacyStorageLimits.maxCollectionRecords&&state[key].length>(previous?.[key].length??0)))fail(413,'quota-exceeded','Legacy durable history quota exceeded; explicit archival is required');
        }
        if(state.revisions.length)db.query('UPDATE remote_schema_version SET version=? WHERE version<?').run(LEGACY_ARTIFACT_WRITER_VERSION,LEGACY_ARTIFACT_WRITER_VERSION);
        return body;
    };
    return{hydrate,hydrateRevision,metadataRevision,serialize,persist};
}
