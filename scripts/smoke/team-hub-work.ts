/** Loopback-only disposable work-management trial. Credentials below are deliberately public test fixtures. */
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openHubStore} from '../../src/hub/store';
import {startHub} from '../../src/hub/server';
const dataDir=process.argv[2] && process.argv[2]!=='--fresh' ? process.argv[2] : mkdtempSync(join(tmpdir(),'keryx-work-demo-'));
const port=Number(process.argv[3] ?? '18792');
const marker=join(dataDir,'keryx-work-demo.json');
if(process.argv[2] && process.argv[2]!=='--fresh'){
  const value:unknown=JSON.parse(readFileSync(marker,'utf8'));
  if(!value || typeof value!=='object' || !('fixture' in value) || value.fixture!==true)throw new Error('Refusing a directory without the synthetic fixture marker');
}else writeFileSync(marker,JSON.stringify({fixture:true}),{mode:0o600});
const projectId='work-demo-project';
const store=openHubStore(dataDir);
const state=store.load();
if(!state.projects.some(p=>p.id===projectId)) state.projects.push({id:projectId,name:'Work management local trial',version:1,lineRevisionId:null,lineVersion:0,contextRevision:0});
store.save(state);store.close();
// Synthetic local-only fixture credentials; never use these values for a public Hub.
const server=startHub({dataDir,host:'127.0.0.1',port,operatorToken:'work-demo-human-operator-0000000000000000000000',reviewerToken:'work-demo-human-reviewer-0000000000000000000000',agentToken:'work-demo-contributor-agent-00000000000000000000',workManagement:{enabled:true,repositories:[{id:'demo-repository',projectId,objectFormat:'sha1'}]}});
console.log(JSON.stringify({url:'http://127.0.0.1:'+port,projectId,dataDir,fixture:true}));
process.on('SIGTERM',()=>void server.stop(true));
process.on('SIGINT',()=>void server.stop(true));
