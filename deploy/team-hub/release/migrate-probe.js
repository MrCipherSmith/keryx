const headers={Authorization:"Bearer "+process.env.KERYX_HUB_OPERATOR_TOKEN};
const PROJECT_ID = process.argv[2];
const base = process.argv[3] ?? "http://127.0.0.1:8787";
const address = new URL(base);
if (address.protocol !== "http:" || address.hostname !== "127.0.0.1" || address.pathname !== "/" || address.username || address.password) throw new Error("Probe requires a loopback HTTP origin");
const old=await fetch(base+"/hub/v1/projects",{headers});if(!old.ok)process.exit(1);
if(process.env.KERYX_HUB_WORK_ENABLED==="true"){
 const p=encodeURIComponent(PROJECT_ID);
 const caps=await fetch(base+"/hub/work/v1/projects/"+p+"/capabilities",{headers});
 if(!caps.ok || !(await caps.json()).enabled)process.exit(2);
 const body={operationId:"legacy-adoption-rehearsal",command:"flow.create",expectedVersions:{},payload:{title:"Legacy adoption rehearsal",problem:"Verify metadata retention",expectedOutcome:"Safe release adoption",scope:"Disposable copy only",outOfScope:"Production",ownerId:null,specification:null,criteria:[{criterionId:"c1",text:"Retained",waivable:false}]}};
 const write=await fetch(base+"/hub/work/v1/projects/"+p+"/commands",{method:"POST",headers:{...headers,"Content-Type":"application/json","Idempotency-Key":body.operationId},body:JSON.stringify(body)});
 if(!write.ok)process.exit(3);
}
