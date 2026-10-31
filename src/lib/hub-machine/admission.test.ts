import{expect,test}from'bun:test';
import{createGrantApplication}from'./client';
import type{Control}from'../../remote-control/protocol';
test('host creation rechecks grant after the durable starting marker and starts zero hosts on expiry',async()=>{
 const{applyStartingCommand}=await import('./admission');let now=0,starts=0,marked=false;const wall=Date.now(),d='a'.repeat(64);const request:Control['AuthorizeCommand']={commandDigest:d,policyDigest:d,target:{scope:'session',sessionId:'s',expectedSessionVersion:0},controller:null};const grant:Control['AuthorizationGrant']={...request,grantId:'grant',commandId:'command',authorizedBy:'human',authorizedAt:new Date(wall).toISOString(),expiresAt:new Date(wall+5000).toISOString()};const application=createGrantApplication(grant,{...request,commandId:'command',authorizedBy:'human'},{startedAt:0,monotonic:()=>now,wall:()=>wall+now});const result=await applyStartingCommand(application,()=>{marked=true;now=5000;},()=>++starts);expect(marked).toBe(true);expect(result.ok).toBe(false);expect(starts).toBe(0);
});
