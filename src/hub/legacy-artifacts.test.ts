import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHubStore } from './store';
import { createHubApplication } from './server';

test('revision bytes are content addressed once, replay stores a reference, and hot legacy transactions never hydrate files', async()=>{
    const dir=mkdtempSync(join(tmpdir(),'hub-legacy-artifacts-')), token='operator-'+'x'.repeat(64);
    const config={dataDir:dir,operatorToken:token,agentToken:'agent-'+'y'.repeat(64)};
    let app=createHubApplication(config);
    const request=(path:string,body?:unknown,key='key-'+Math.random())=>app.fetch(new Request('http://hub.test/hub/v1'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':key},...(body===undefined?{}:{body:JSON.stringify(body)})}));
    try{
        const project=await(await request('/projects',{name:'Artifacts'})).json();
        const path='/projects/'+project.id+'/revisions', contentBase64=Buffer.from('private-artifact-marker\n'.repeat(5000)).toString('base64');
        const body={baseRevisionId:null,gitBaseSha:'a'.repeat(40),message:'Revision',changes:[{path:'a.txt',contentBase64}]};
        const revision=await(await request(path,body,'revision-key')).json();
        expect((await request(path,body,'revision-key')).status).toBe(200);
        await request(path,body,'second-key');
        const db=new Database(join(dir,'hub.sqlite'));
        const stored=db.query<{body:string},[]>('SELECT body FROM hub_state WHERE id=1').get()!.body;
        expect(stored.includes(contentBase64)).toBe(false);
        expect(db.query('SELECT count(*) AS n FROM hub_revision_blobs').get()).toEqual({n:1});
        expect(db.query('SELECT version FROM remote_schema_version').get()).toEqual({version:4});
        db.close();
        const store=openHubStore(dir), state=store.load();
        for(const record of state.revisions) for(const file of record.files) Object.defineProperty(file,'contentBase64',{enumerable:true,configurable:true,get(){throw Error('Unexpected cold artifact hydration');}});
        store.save(state);
        store.writeTransaction(()=>{});store.close();
        app.close();app=createHubApplication(config);
        expect(await(await request(path+'/'+revision.id)).json()).toEqual(revision);
        expect(await(await request(path,body,'revision-key')).json()).toEqual(revision);
    }finally{app.close();rmSync(dir,{recursive:true,force:true});}
});

test('migrates inline bytes and replay references atomically, preserves a rollback copy, and the actual previous writer refuses v4', async()=>{
    const {copyFileSync,mkdirSync}=await import('node:fs');
    const {createHash}=await import('node:crypto');
    const {migrateRemote:previousWriter}=await import('./fixtures/writer-v3-migration.test-support');
    const root=mkdtempSync(join(tmpdir(),'hub-artifact-migration-')),dir=join(root,'live');mkdirSync(dir);
    const before=openHubStore(dir), state=before.load();before.close();
    state.projects.push({id:'p',name:'Old',version:1,lineRevisionId:'r',lineVersion:1,contextRevision:0});
    const bytes=Buffer.from('historical accepted artifact'), revision={id:'r',projectId:'p',baseRevisionId:null,gitBaseSha:'a'.repeat(40),message:'Old',createdBy:'human:operator',createdAt:'then',treeDigest:'tree',files:[{path:'old.txt',mode:'100644' as const,contentBase64:bytes.toString('base64'),contentDigest:createHash('sha256').update(bytes).digest('hex')}]};
    state.revisions.push(revision);state.replays.old={digest:'request',status:200,body:revision};
    const db=new Database(join(dir,'hub.sqlite'));
    db.query('UPDATE hub_state SET body=? WHERE id=1').run(JSON.stringify(state));
    db.exec("UPDATE remote_schema_version SET version=3; DELETE FROM hub_work_settings WHERE key='legacy-artifacts-v1'");
    expect(()=>previousWriter(db)).not.toThrow();db.close();
    const rollback=join(root,'rollback.sqlite');copyFileSync(join(dir,'hub.sqlite'),rollback);
    try{
        const migrated=openHubStore(dir);
        expect(migrated.load().revisions[0]).toEqual(revision);
        expect(migrated.load().replays.old!.body).toEqual(revision);
        migrated.close();
        const candidate=new Database(join(dir,'hub.sqlite'));
        expect(candidate.query('SELECT version FROM remote_schema_version').get()).toEqual({version:4});
        expect(()=>previousWriter(candidate)).toThrow('Unsupported remote schema version');candidate.close();
        const restored=new Database(rollback);expect(()=>previousWriter(restored)).not.toThrow();
        expect(JSON.parse(restored.query<{body:string},[]>('SELECT body FROM hub_state').get()!.body).revisions[0]).toEqual(revision);restored.close();
    }finally{rmSync(root,{recursive:true,force:true});}
});

test('failed artifact migration rolls back both inline data and the writer fence',()=>{
    const dir=mkdtempSync(join(tmpdir(),'hub-artifact-rollback-'));
    const original=openHubStore(dir),state=original.load();original.close();
    state.revisions.push({id:'bad',projectId:'p',baseRevisionId:null,gitBaseSha:'a'.repeat(40),message:'Old',createdBy:'h',createdAt:'then',treeDigest:'old',files:[{path:'a',mode:'100644',contentBase64:'YQ==',contentDigest:'wrong-digest'}]});
    const body=JSON.stringify(state),db=new Database(join(dir,'hub.sqlite'));
    db.query('UPDATE hub_state SET body=? WHERE id=1').run(body);db.exec("UPDATE remote_schema_version SET version=3;DELETE FROM hub_work_settings WHERE key='legacy-artifacts-v1'");db.close();
    try{
        expect(()=>openHubStore(dir)).toThrow('Revision content digest');
        const failed=new Database(join(dir,'hub.sqlite'));
        expect(failed.query<{body:string},[]>('SELECT body FROM hub_state').get()!.body).toBe(body);
        expect(failed.query('SELECT version FROM remote_schema_version').get()).toEqual({version:3});
        expect(failed.query('SELECT count(*) AS n FROM hub_revision_blobs').get()).toEqual({n:0});failed.close();
    }finally{rmSync(dir,{recursive:true,force:true});}
});

test('transient retention recovers stale context while every exact immutable document version remains archived', async()=>{
    const {createHash}=await import('node:crypto');
    const {hubRead}=await import('./domain');
    const dir=mkdtempSync(join(tmpdir(),'hub-legacy-retention-')), store=openHubStore(dir), state=store.load();
    const count=5005, document=(version:number)=>({id:'d',projectId:'p',path:'wiki.md',kind:'wiki' as const,version,content:'v'+version,contentDigest:createHash('sha256').update('v'+version).digest('hex'),sourceRevision:'source',approval:'accepted' as const});
    state.projects.push({id:'p',name:'P',version:1,lineRevisionId:null,lineVersion:0,contextRevision:count});state.documents.push(document(count));
    state.documentChanges=Array.from({length:count},(_,index)=>({projectId:'p',revision:index+1,document:document(index+1)}));
    state.events=Array.from({length:10005},(_,index)=>({projectId:'p',sequence:index+1,type:'context-changed',entityId:'d',actorId:'h',createdAt:'now'}));
    try{
        store.save(state);const retained=store.load();
        expect(retained.events).toHaveLength(10000);expect(retained.documentChanges).toHaveLength(5000);
        const context=hubRead(retained,['projects','p','context'],new URL('http://hub.test?after=1')) as {fullSnapshot:boolean;documents:unknown[]};
        expect(context.fullSnapshot).toBe(true);expect(context.documents).toEqual([document(count)]);
        expect(()=>hubRead(retained,['projects','p','events'],new URL('http://hub.test?after=2'))).toThrow('Event window expired');
        expect(store.work.documentVersion('p',{documentId:'d',version:1,contentDigest:document(1).contentDigest})).toEqual(document(1));
        const db=new Database(join(dir,'hub.sqlite'));db.exec('UPDATE hub_work_document_usage SET count=100000');db.close();
        expect(()=>store.work.archiveDocument(document(count+1))).toThrow('Immutable document archive quota');
        expect(store.work.documentVersion('p',{documentId:'d',version:1,contentDigest:document(1).contentDigest})).toEqual(document(1));
    }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('artifact quota rejects new bytes atomically without removing accepted historical revisions or receipts', async()=>{
    const {createHash}=await import('node:crypto');
    const dir=mkdtempSync(join(tmpdir(),'hub-blob-quota-')),store=openHubStore(dir),state=store.load();
    state.projects.push({id:'p',name:'P',version:1,lineRevisionId:'accepted',lineVersion:1,contextRevision:0});
    const revision=(id:string,text:string)=>({id,projectId:'p',baseRevisionId:null,gitBaseSha:'a'.repeat(40),message:id,createdBy:'h',createdAt:'then',treeDigest:'tree',files:[{path:'a',mode:'100644' as const,contentBase64:Buffer.from(text).toString('base64'),contentDigest:createHash('sha256').update(text).digest('hex')}]});
    state.revisions.push(revision('accepted','old'));state.replays.accepted={digest:'old-request',status:200,body:state.revisions[0]};
    try{
        store.save(state);const db=new Database(join(dir,'hub.sqlite'));db.exec('UPDATE hub_revision_blob_usage SET bytes=536870912');db.close();
        const changed=store.load();changed.revisions.push(revision('new','new bytes'));
        expect(()=>store.save(changed)).toThrow('immutable artifact quota');
        const after=store.load();expect(after.revisions).toHaveLength(1);expect(after.revisions[0]).toEqual(revision('accepted','old'));expect(after.replays.accepted!.body).toEqual(revision('accepted','old'));
    }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('valid noncanonical base64 spellings retain exact creation, read and replay representations through restart', async()=>{
    const dir=mkdtempSync(join(tmpdir(),'hub-base64-representation-')),token='operator-'+'x'.repeat(64),config={dataDir:dir,operatorToken:token,agentToken:'agent-'+'y'.repeat(64)};
    let app=createHubApplication(config);
    const request=(path:string,body?:unknown,key='key-'+Math.random())=>app.fetch(new Request('http://hub.test/hub/v1'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':key},...(body===undefined?{}:{body:JSON.stringify(body)})}));
    try{
        const project=await(await request('/projects',{name:'Aliases'})).json(),path='/projects/'+project.id+'/revisions';
        for(const [index,contentBase64] of ['YQ==','YR=='].entries()){
            const body={baseRevisionId:null,gitBaseSha:'a'.repeat(40),message:'Alias'+index,changes:[{path:'a',contentBase64}]},key='alias-'+index;
            const created=await(await request(path,body,key)).json();expect(created.files[0].contentBase64).toBe(contentBase64);
            expect(await(await request(path,body,key)).json()).toEqual(created);
            app.close();app=createHubApplication(config);
            expect(await(await request(path+'/'+created.id)).json()).toEqual(created);expect(await(await request(path,body,key)).json()).toEqual(created);
        }
        const db=new Database(join(dir,'hub.sqlite'));expect(db.query('SELECT count(*) AS n FROM hub_revision_blobs').get()).toEqual({n:2});db.close();
    }finally{app.close();rmSync(dir,{recursive:true,force:true});}
});

test('existing inline base64 aliases migrate without changing either immutable revision or recorded receipt',async()=>{
    const {createHash}=await import('node:crypto');
    const dir=mkdtempSync(join(tmpdir(),'hub-old-base64-aliases-')),before=openHubStore(dir),state=before.load();before.close();
    state.projects.push({id:'p',name:'P',version:1,lineRevisionId:null,lineVersion:0,contextRevision:0});
    const revisions=['YQ==','YR=='].map((contentBase64,index)=>({id:'r'+index,projectId:'p',baseRevisionId:null,gitBaseSha:'a'.repeat(40),message:'Old',createdBy:'h',createdAt:'then',treeDigest:'same-tree',files:[{path:'a',mode:'100644' as const,contentBase64,contentDigest:createHash('sha256').update('a').digest('hex')}]}));
    state.revisions.push(...revisions);state.replays.alias={digest:'request',status:200,body:revisions[1]};
    const db=new Database(join(dir,'hub.sqlite'));db.query('UPDATE hub_state SET body=? WHERE id=1').run(JSON.stringify(state));db.exec("UPDATE remote_schema_version SET version=3;DELETE FROM hub_work_settings WHERE key='legacy-artifacts-v1'");db.close();
    try{const migrated=openHubStore(dir);expect(migrated.load().revisions).toEqual(revisions);expect(migrated.load().replays.alias!.body).toEqual(revisions[1]);migrated.close();}finally{rmSync(dir,{recursive:true,force:true});}
});
