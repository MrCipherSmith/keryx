import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalDigest, catalogueDigest, type Control } from "../../remote-control/protocol";
import { buildNativeCoverageDescriptor, checkNativeCommandCoverage, currentNativeCoverageSubject, nativeCoverageContractDigest, nativeParityReceiptDigest, validateNativeCoverageDescriptor,
  type NativeCoverageInventory, type NativeNormalizedOutcome, type NativeParityReceipt } from "./coverage";
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const applied:NativeNormalizedOutcome={status:"applied",errorCode:null,confirmation:false,resultDigest:"c".repeat(64)};
function receipt(body:Omit<NativeParityReceipt,"receiptDigest">):NativeParityReceipt{return{...body,receiptDigest:nativeParityReceiptDigest(body)};}
async function fixture(){
 const cwd=await mkdtemp(path.join(tmpdir(),"native-coverage-"));roots.push(cwd);await mkdir(path.join(cwd,"src"));const source="export const actual = () => 1;\n";await writeFile(path.join(cwd,"src/handler.ts"),source);const digest=createHash("sha256").update(source).digest("hex");
 const entry:Control["CommandCatalogueEntry"]={commandName:"example",summary:"Actual fixture handler",handlerId:"native.example",inputSchema:{type:"object",properties:{},required:[],additionalProperties:false},resultSchema:{type:"string",maxLength:32768},mutationClass:"read",states:["idle","busy"],busyPolicy:"read-only",confirmation:"none",availability:"available",reason:"fixture"};
 const catalogue:Control["CommandCatalogue"]={catalogueVersion:1,catalogueDigest:catalogueDigest([entry]),capabilityDigest:"a".repeat(64),entries:[entry]};
 const inventory:NativeCoverageInventory={schema:1,registryDigest:canonicalDigest(["example"]),commands:[{commandName:"example",audited:true,expectedVariants:["example.default"],sources:[{path:"src/handler.ts",sha256:digest,anchor:"actual"}]}],variants:[{id:"example.default",commandName:"example",handlerName:"example",classification:"required",status:"implemented",reason:"actual native fixture",inputSchema:entry.inputSchema,resultSchema:entry.resultSchema,busyPolicy:entry.busyPolicy,confirmation:entry.confirmation,proofIds:["native-parity:example.default"]}]};
 const receipts:NativeParityReceipt[]=[receipt({schema:1,id:"native-parity:example.default",variantId:"example.default",commandName:"example",handlerName:"example",catalogueDigest:catalogue.catalogueDigest,sources:[{path:"src/handler.ts",sha256:digest,anchor:"actual"}],local:{line:"/example",outcome:applied},headless:{arguments:{},outcome:applied}})];return{cwd,catalogue,inventory,receipts,digest};
}
test("coverage accepts exact audited source-backed implemented variant with a matching local/headless receipt",async()=>{const f=await fixture();expect(await checkNativeCommandCoverage({...f,registryNames:["example"]})).toMatchObject({ready:true,blockers:[]});});
test("coverage refuses missing nested variants even when the top-level command is available",async()=>{const f=await fixture();f.inventory.commands[0]!.expectedVariants.push("example.mutate");expect(await checkNativeCommandCoverage({...f,registryNames:["example"]})).toMatchObject({ready:false,blockers:expect.arrayContaining([expect.objectContaining({code:"missing-variant",subject:"example.mutate"})])});});
test("an advertised nested native action without an audit row is an omitted action, not silently covered by its parent",async()=>{const f=await fixture();f.catalogue.entries.push({...f.catalogue.entries[0]!,commandName:"example.mutate",handlerId:"native.example.mutate"});f.catalogue.catalogueDigest=catalogueDigest(f.catalogue.entries);const result=await checkNativeCommandCoverage({...f,registryNames:["example"]});expect(result.blockers).toEqual(expect.arrayContaining([expect.objectContaining({code:"uncovered-catalogue-command",subject:"example.mutate"}),expect.objectContaining({code:"stale-receipt",subject:"example.default"})]));});
test("coverage refuses unregistered inventory, unaudited parsers, changed source and receipts for another catalogue",async()=>{const f=await fixture();f.inventory.commands[0]!.audited=false;await writeFile(path.join(f.cwd,"src/handler.ts"),"export const changed = true;\n");const result=await checkNativeCommandCoverage({...f,registryNames:["example","newly-added"]});expect(result.ready).toBe(false);expect(result.blockers.map(row=>row.code)).toEqual(expect.arrayContaining(["registry-drift","missing-command-audit","unaudited-command","source-drift","stale-receipt"]));});
test("a receipt bound to an older source hash is stale even when the audit pin was refreshed alone",async()=>{const f=await fixture();const changed="export const actual = () => 2;\n";await writeFile(path.join(f.cwd,"src/handler.ts"),changed);f.inventory.commands[0]!.sources[0]!.sha256=createHash("sha256").update(changed).digest("hex");const result=await checkNativeCommandCoverage({...f,registryNames:["example"]});expect(result.blockers.map(row=>row.code)).toEqual(["stale-receipt"]);});
test("a forged or edited receipt is refused; failing parity and a refusal on both paths are distinct gaps",async()=>{
 const f=await fixture();const forged={...f.receipts[0]!,headless:{arguments:{},outcome:{...applied,resultDigest:"d".repeat(64)}}};
 expect((await checkNativeCommandCoverage({...f,receipts:[forged],registryNames:["example"]})).blockers.map(row=>row.code)).toEqual(["tampered-receipt"]);
 const {receiptDigest:_digest,...body}=forged;
 expect((await checkNativeCommandCoverage({...f,receipts:[receipt(body)],registryNames:["example"]})).blockers.map(row=>row.code)).toEqual(["parity-failure"]);
 const refused:NativeNormalizedOutcome={status:"rejected",errorCode:"forbidden",confirmation:false,resultDigest:null};
 expect((await checkNativeCommandCoverage({...f,receipts:[receipt({...body,local:{line:"/example",outcome:refused},headless:{arguments:{},outcome:refused}})],registryNames:["example"]})).blockers.map(row=>row.code)).toEqual(["required-behaviour-refused"]);
 expect((await checkNativeCommandCoverage({...f,receipts:[receipt({...body,headless:{arguments:null,outcome:null}})],registryNames:["example"]})).blockers.map(row=>row.code)).toEqual(["parity-failure"]);
});
test("TUI-only classification cannot waive required domain operations and local boundaries need actual semantics",async()=>{const f=await fixture();f.inventory.variants[0]!.classification="presentation";f.inventory.variants[0]!.reason="TUI-only";expect((await checkNativeCommandCoverage({...f,registryNames:["example"]})).ready).toBe(false);});
test("coverage checks typed schemas and behavior proof; a test filename alone cannot prove parity",async()=>{const f=await fixture();f.receipts=[];f.inventory.variants[0]!.inputSchema={type:"object",properties:{ignored:{type:"string",maxLength:10}},required:[],additionalProperties:false};const result=await checkNativeCommandCoverage({...f,registryNames:["example"]});expect(result.blockers.map(row=>row.code)).toEqual(expect.arrayContaining(["schema-drift","missing-current-evidence"]));});
test("whole catalogue bytes are not confused with independently paginated wire frame bounds",async()=>{const f=await fixture();f.catalogue.entries[0]!.summary="x".repeat(200);for(let i=0;i<180;i++){f.catalogue.entries.push({...f.catalogue.entries[0]!,commandName:`extra.${i}`});}f.catalogue.catalogueDigest=catalogueDigest(f.catalogue.entries);expect(JSON.stringify(f.catalogue).length).toBeGreaterThan(65536);const result=await checkNativeCommandCoverage({...f,registryNames:["example"]});expect(result.blockers.some(row=>row.code==="catalogue-byte-quota")).toBe(false);});
test("scope boundaries cannot waive an action without the exact frozen normative source",async()=>{const f=await fixture();f.inventory.commands[0]!.commandName="review";f.inventory.commands[0]!.expectedVariants=["review.proposal.accept"];f.inventory.registryDigest=canonicalDigest(["review"]);f.inventory.variants[0]={...f.inventory.variants[0]!,id:"review.proposal.accept",commandName:"review",classification:"scope-boundary",status:"boundary",reason:"This changes human review proposal state outside the required inspection surface."};const result=await checkNativeCommandCoverage({...f,registryNames:["review"]});expect(result.blockers.map(row=>row.code)).toContain("invalid-scope-reference");});
test("credential administration boundaries cannot hide a required safe MCP status read",async()=>{const f=await fixture();f.inventory.commands[0]!.commandName="mcp";f.inventory.commands[0]!.expectedVariants=["mcp.status"];f.inventory.registryDigest=canonicalDigest(["mcp"]);f.inventory.variants[0]={...f.inventory.variants[0]!,id:"mcp.status",commandName:"mcp",classification:"local-security",status:"boundary",reason:"Credentials exist somewhere in this feature, so hide its entire read surface."};const result=await checkNativeCommandCoverage({...f,registryNames:["mcp"]});expect(result.blockers.map(row=>row.code)).toContain("invalid-boundary");});
test("a scope/security boundary cannot hide a remotely available mutating handler",async()=>{const f=await fixture();f.inventory.commands[0]!.commandName="mcp";f.inventory.commands[0]!.expectedVariants=["mcp.connect"];f.inventory.registryDigest=canonicalDigest(["mcp"]);f.catalogue.entries[0]!.mutationClass="workspace";f.catalogue.catalogueDigest=catalogueDigest(f.catalogue.entries);f.inventory.variants[0]={...f.inventory.variants[0]!,id:"mcp.connect",commandName:"mcp",classification:"local-security",status:"boundary",reason:"The shipped command persists a personal overlay and can start an untrusted MCP server."};const result=await checkNativeCommandCoverage({...f,registryNames:["mcp"]});expect(result.blockers.map(row=>row.code)).toContain("boundary-handler-advertised");});
test("descriptor derives readiness from the guard result and validates against the registry and command contract only",async()=>{
 const f=await fixture();const subject={registryNames:["example"],catalogue:f.catalogue};
 const ready=buildNativeCoverageDescriptor({...subject,contractCatalogue:f.catalogue,inventory:f.inventory,result:await checkNativeCommandCoverage({...f,registryNames:["example"]})});
 expect(ready).toMatchObject({releaseReady:true,earned:["example.default"],requiredGaps:[]});expect(validateNativeCoverageDescriptor(ready,subject)).toMatchObject({ok:true,releaseReady:true});
 const gap=buildNativeCoverageDescriptor({...subject,contractCatalogue:f.catalogue,inventory:f.inventory,result:await checkNativeCommandCoverage({...f,receipts:[],registryNames:["example"]})});
 expect(gap).toMatchObject({releaseReady:false,earned:[],requiredGaps:[{variantId:"example.default",code:"missing-current-evidence"}]});
 expect(validateNativeCoverageDescriptor(gap,subject)).toMatchObject({ok:true,releaseReady:false});
 // Availability changes with local setup and is not part of the contract; a schema change is.
 expect(validateNativeCoverageDescriptor(gap,{...subject,catalogue:{...f.catalogue,entries:[{...f.catalogue.entries[0]!,availability:"setup-required"}]}})).toMatchObject({ok:true});
 expect(validateNativeCoverageDescriptor(gap,{...subject,catalogue:{...f.catalogue,entries:[{...f.catalogue.entries[0]!,busyPolicy:"reject"}]}})).toEqual({ok:false,code:"catalogue-drift"});
 expect(validateNativeCoverageDescriptor(gap,{...subject,registryNames:["example","added"]})).toEqual({ok:false,code:"registry-drift"});
 expect(validateNativeCoverageDescriptor(undefined,subject)).toEqual({ok:false,code:"descriptor-missing"});
 expect(validateNativeCoverageDescriptor({...gap,extra:true},subject)).toEqual({ok:false,code:"descriptor-invalid"});
 expect(validateNativeCoverageDescriptor({...gap,releaseReady:true,requiredGaps:[]},subject)).toEqual({ok:false,code:"descriptor-tampered"});
 const {descriptorDigest:_old,...body}=gap;const inconsistent={...body,releaseReady:true};
 expect(validateNativeCoverageDescriptor({...inconsistent,descriptorDigest:canonicalDigest(inconsistent)},subject)).toEqual({ok:false,code:"descriptor-inconsistent"});
});
test("the shipped subject contract is independent of which local services happen to be attached",()=>{const subject=currentNativeCoverageSubject();expect(subject.registryNames.length).toBeGreaterThan(0);expect(nativeCoverageContractDigest(subject.catalogue)).toBe(nativeCoverageContractDigest({...subject.catalogue,entries:subject.catalogue.entries.map(entry=>({...entry,availability:"policy-denied",reason:"fixture"}))}));});
test("Telegram remote control is a capability boundary only with the frozen spec-3.1 vendor-adapter reference",async()=>{
 const f=await fixture();f.inventory.commands[0]!.commandName="remote-control";f.inventory.commands[0]!.expectedVariants=["remote-control.status"];f.inventory.registryDigest=canonicalDigest(["remote-control"]);
 const boundary={...f.inventory.variants[0]!,id:"remote-control.status",commandName:"remote-control",classification:"external-vendor" as const,status:"boundary" as const,reason:"Telegram inbound control needs an unimplemented delegated-principal adapter; specification 3.1 makes it an explicit capability boundary."};
 f.inventory.variants[0]={...boundary};expect((await checkNativeCommandCoverage({...f,registryNames:["remote-control"]})).blockers.map(row=>row.code)).toContain("invalid-scope-reference");
 const spec=path.join(f.cwd,"docs/requirements/hub-remote-sessions");await mkdir(spec,{recursive:true});
 await writeFile(path.join(spec,"specification.md"),await Bun.file(new URL("../../../docs/requirements/hub-remote-sessions/specification.md",import.meta.url).pathname).text());
 f.inventory.variants[0]={...boundary,scopeReference:{path:"docs/requirements/hub-remote-sessions/specification.md",sha256:"7827a1827565992e61b85d43e5e73763303b3aa9590973e6484b8c0edb1834e2",anchor:"unimplemented vendor adapters are explicit capability boundaries"}};
 expect(await checkNativeCommandCoverage({...f,registryNames:["remote-control"]})).toMatchObject({ready:true,blockers:[]});
});

test("a receipt whose headless form is a frozen queue operation binds that operation into its digest",async()=>{
 const f=await fixture();const {receiptDigest:_digest,...body}=f.receipts[0]!;
 const queue=receipt({...body,headless:{arguments:{queueItemId:"q1"},outcome:applied,operation:"remove-queue"}});
 expect(await checkNativeCommandCoverage({...f,receipts:[queue],registryNames:["example"]})).toMatchObject({ready:true,blockers:[]});
 // Relabelling the operation (or dropping it) without re-deriving the receipt is tampering.
 for(const forged of [{...queue,headless:{...queue.headless,operation:"edit-queue" as const}},{...queue,headless:{arguments:queue.headless.arguments,outcome:queue.headless.outcome}}])
  expect((await checkNativeCommandCoverage({...f,receipts:[forged],registryNames:["example"]})).blockers.map(row=>row.code)).toEqual(["tampered-receipt"]);
});

const SPEC={path:"docs/requirements/hub-remote-sessions/specification.md",sha256:"7827a1827565992e61b85d43e5e73763303b3aa9590973e6484b8c0edb1834e2"};
async function withFrozenSpec(cwd:string){const spec=path.join(cwd,"docs/requirements/hub-remote-sessions");await mkdir(spec,{recursive:true});
 await writeFile(path.join(spec,"specification.md"),await Bun.file(new URL("../../../docs/requirements/hub-remote-sessions/specification.md",import.meta.url).pathname).text());}
function audited(f:Awaited<ReturnType<typeof fixture>>,commandName:string,id:string,row:Partial<NativeCoverageInventory["variants"][number]>){
 f.inventory.commands[0]!.commandName=commandName;f.inventory.commands[0]!.expectedVariants=[id];f.inventory.registryDigest=canonicalDigest([commandName]);
 f.inventory.variants[0]={...f.inventory.variants[0]!,id,commandName,status:"boundary",...row};
}
test("Jev analysis execution is a security-local setup boundary only for the audited Jev variants and only with the frozen spec-3.1 reference",async()=>{
 const reason="This variant runs Jev analysis, which needs explicit local Jev setup and consent that the native subject does not have.";
 const anchor={...SPEC,anchor:"Security-local setup and unimplemented vendor adapters are explicit capability boundaries"};
 const f=await fixture();audited(f,"risk","risk.working-diff",{classification:"local-security",reason});
 expect((await checkNativeCommandCoverage({...f,registryNames:["risk"]})).blockers.map(row=>row.code)).toContain("invalid-scope-reference");
 await withFrozenSpec(f.cwd);f.inventory.variants[0]!.scopeReference=anchor;
 expect(await checkNativeCommandCoverage({...f,registryNames:["risk"]})).toMatchObject({ready:true,blockers:[]});
 // The same wording cannot waive a deterministic native operation that merely shares a command family with a Jev one.
 const other=await fixture();await withFrozenSpec(other.cwd);audited(other,"ac","ac.check",{classification:"local-security",reason,scopeReference:anchor});
 expect((await checkNativeCommandCoverage({...other,registryNames:["ac"]})).blockers.map(row=>row.code)).toContain("invalid-boundary");
});
test("a queue variant with no frozen queue operation is a scope boundary only with the spec reference; queue edit/remove stay required",async()=>{
 const reason="Forcing a queued item to the front has no frozen queue operation: specification 3.1 names queue edit and remove only.";
 const anchor={...SPEC,anchor:"message queue edit/remove"};
 for(const id of ["queue.force","queue.force-N","queue.edit"]){
  const f=await fixture();audited(f,"queue",id,{classification:"scope-boundary",reason});
  expect((await checkNativeCommandCoverage({...f,registryNames:["queue"]})).blockers.map(row=>row.code)).toContain("invalid-scope-reference");
  await withFrozenSpec(f.cwd);f.inventory.variants[0]!.scopeReference=anchor;
  expect(await checkNativeCommandCoverage({...f,registryNames:["queue"]})).toMatchObject({ready:true,blockers:[]});
 }
 for(const id of ["queue.edit-N","queue.remove","queue.list"]){
  const f=await fixture();await withFrozenSpec(f.cwd);audited(f,"queue",id,{classification:"scope-boundary",reason,scopeReference:anchor});
  expect((await checkNativeCommandCoverage({...f,registryNames:["queue"]})).blockers.map(row=>row.code)).toContain("invalid-boundary");
 }
});

test("the conform wizard steps start or render the Jev conformance run, so they are the same spec-3.1 setup boundary, only with the frozen reference",async()=>{
 const reason="Choosing a conform reference or target starts the Jev conformance run, and a clause detail renders that run; it needs explicit local Jev setup and consent.";
 const anchor={...SPEC,anchor:"Security-local setup and unimplemented vendor adapters are explicit capability boundaries"};
 for(const id of ["conform.reference-select","conform.target-diff","conform.target-pr","conform.target-report","conform.clause-detail"]){
  const f=await fixture();audited(f,"conform",id,{classification:"local-security",reason});
  expect((await checkNativeCommandCoverage({...f,registryNames:["conform"]})).blockers.map(row=>row.code)).toContain("invalid-scope-reference");
  await withFrozenSpec(f.cwd);f.inventory.variants[0]!.scopeReference=anchor;
  expect(await checkNativeCommandCoverage({...f,registryNames:["conform"]})).toMatchObject({ready:true,blockers:[]});
 }
 // The conform setup read stays a required native inspection.
 const read=await fixture();await withFrozenSpec(read.cwd);audited(read,"conform","conform.setup",{classification:"local-security",reason,scopeReference:anchor});
 expect((await checkNativeCommandCoverage({...read,registryNames:["conform"]})).blockers.map(row=>row.code)).toContain("invalid-boundary");
});
test("owner decision stage 4: exactly these four variants are boundaries, each only in its decided class and with the frozen spec reference",async()=>{
 const reason="Owner decision 2026-10-29 (ownerDecisionStage4): this variant is an explicit boundary of the native session foundation.";
 const decided=[["triggers","triggers.run","scope-boundary","Unknown ownership, ambiguous external edits, quota-limited provenance checks or a restarted uncertain executor require reconciliation/refusal"],
  ["triggers","triggers.confirm-run","scope-boundary","Unknown ownership, ambiguous external edits, quota-limited provenance checks or a restarted uncertain executor require reconciliation/refusal"],
  ["guard","guard.measured-details","presentation","Pure terminal display functions are client concerns."],
  ["ci","ci.detail","external-vendor","unimplemented vendor adapters are explicit capability boundaries"]] as const;
 for(const [commandName,id,classification,text] of decided){
  const f=await fixture();audited(f,commandName,id,{classification,reason});
  expect((await checkNativeCommandCoverage({...f,registryNames:[commandName]})).blockers.map(row=>row.code)).toContain("invalid-scope-reference");
  await withFrozenSpec(f.cwd);f.inventory.variants[0]!.scopeReference={...SPEC,anchor:text};
  expect(await checkNativeCommandCoverage({...f,registryNames:[commandName]})).toMatchObject({ready:true,blockers:[]});
  // Any other class for the same variant is not what the owner decided.
  for(const other of ["scope-boundary","presentation","external-vendor","local-security"] as const){ if(other===classification)continue;
   const g=await fixture();await withFrozenSpec(g.cwd);audited(g,commandName,id,{classification:other,reason,scopeReference:{...SPEC,anchor:text}});
   expect((await checkNativeCommandCoverage({...g,registryNames:[commandName]})).blockers.map(row=>row.code)).toContain("invalid-boundary");
  }
 }
 // Their reads stay required native operations.
 for(const [commandName,id,classification,text] of [["triggers","triggers.detail","scope-boundary",decided[0][3]],["guard","guard.inspection","presentation",decided[2][3]],["ci","ci.list","external-vendor",decided[3][3]]] as const){
  const f=await fixture();await withFrozenSpec(f.cwd);audited(f,commandName,id,{classification,reason,scopeReference:{...SPEC,anchor:text}});
  expect((await checkNativeCommandCoverage({...f,registryNames:[commandName]})).blockers.map(row=>row.code)).toContain("invalid-boundary");
 }
});
