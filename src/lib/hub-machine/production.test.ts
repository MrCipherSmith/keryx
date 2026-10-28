import { expect, test } from 'bun:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveProductionMachineProfile } from './production';
import type { NativeCommandContribution } from '../../session/commands/handlers';
test('production profile never supplies an executor for absent provider, unsupported profile or incomplete parity',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'machine-production-'));
 try{for(const profileId of ['native','remote-restricted','remote-read-only']){const result=await resolveProductionMachineProfile({projectId:'p',checkoutId:'c',cwd:dir,profileId},{configDir:dir,allowedCandidateIds:[]});expect(result.ok).toBe(false);if(!result.ok)expect(['provider-setup','local-policy','adapter-unsupported','containment-missing']).toContain(result.error.code);}}finally{rmSync(dir,{recursive:true,force:true});}
});
test('production routing exposes closed wire aliases for slash model IDs while retaining the consented candidate identity',async()=>{
 const{createLocalMachineRouting}=await import('./production');const{validateControl,canonicalDigest}=await import('../../remote-control/protocol');const provider='openrouter',model='anthropic/claude-sonnet-4.5',d='a'.repeat(64);const routing=createLocalMachineRouting(provider,model,d,d);expect(validateControl('RoutingAvailability',routing).ok).toBe(true);expect(routing.candidates[0]!.candidateId).toBe(canonicalDigest([provider,model]));expect(routing.candidates[0]!.modelId).not.toContain('/');
});
test('the readiness gate still refuses a catalogue listing any implementation gap, and the shipped machine catalogue lists none',async()=>{
 const{catalogueImplementationGaps,createMachineCommandCatalogue}=await import('./production');const d='a'.repeat(64);
 expect(catalogueImplementationGaps(createMachineCommandCatalogue(d))).toEqual([]);
 const unimplemented:NativeCommandContribution={entry:{commandName:'fixture.unimplemented',summary:'A required domain operation with no owner',handlerId:'native.fixture.unimplemented',inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},resultSchema:{type:'string',maxLength:32768},
  mutationClass:'read',states:['idle'],busyPolicy:'read-only',confirmation:'none',availability:'implementation-gap',reason:'owner-not-implemented'},execute:async()=>null};
 expect(catalogueImplementationGaps(createMachineCommandCatalogue(d,[unimplemented]))).toEqual(['fixture.unimplemented']);
});
