import {expect,test} from 'bun:test';
import {loadHubConfig} from '../server';
import {operatorToken,agentToken} from './fixture.test-support';
const env={KERYX_HUB_OPERATOR_TOKEN:operatorToken,KERYX_HUB_AGENT_TOKEN:agentToken};
test('operator byte and active-work budgets are explicit validated configuration',()=>{
 expect(loadHubConfig({...env,KERYX_HUB_REMOTE_PENDING_BYTES:'4096',KERYX_HUB_REMOTE_STAGING_BYTES:'8192',KERYX_HUB_REMOTE_ACTIVE_RUNS:'7'}).remoteBudgets).toEqual({pendingBytes:4096,stagingBytes:8192,activeRuns:7});
 for(const value of ['0','-1','NaN','3.5','9007199254740992'])expect(()=>loadHubConfig({...env,KERYX_HUB_REMOTE_PENDING_BYTES:value})).toThrow();
});
