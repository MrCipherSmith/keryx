import{expect,test}from'bun:test';
test('deterministic trial selects the actual operator turn despite trailing injected user anchors',async()=>{
 const{trialSelection}=await import('./trial.test-support');expect(trialSelection([{role:'user',content:'read seed.txt',provenance:'project'},{role:'user',content:'Anchors: synthetic bootstrap',injected:true}])).toEqual({ordinal:1,toolName:'read_file'});
 expect(trialSelection([{role:'user',content:'cancel supervised work',provenance:'project'},{role:'user',content:'synthetic nudge',provenance:'harness'}])).toEqual({ordinal:1,toolName:'shell_exec'});
});
