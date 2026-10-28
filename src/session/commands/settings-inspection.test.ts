import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeSettingsInspection, settingsInspectionCommands, type SettingsInspectionPort } from "./settings-inspection";
import type { SettingsSnapshot } from "../../tui/settings-model";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const config={configVersion:1,baselineCandidateId:"local-candidate",reasoningEffort:"high" as const,routing:{enabled:false,profileId:"local",candidateIds:["local-candidate"],fallbackCandidateId:"local-candidate"},policyDigest:"a".repeat(64),capabilityDigest:"b".repeat(64)};
test("settings share actual saved/live loader and row semantics in a credential-isolated child",async()=>{
 const cwd=await mkdtemp(path.join(tmpdir(),"native-settings-"));roots.push(cwd);const dir=path.join(cwd,"local-config");await mkdir(dir);
 const module=new URL("./settings-inspection.ts",import.meta.url).pathname;const loader=new URL("../../tui/settings-state.ts",import.meta.url).pathname;const saved=new URL("../../lib/shell-config.ts",import.meta.url).pathname;
 const script=`import{executeSettingsInspection}from${JSON.stringify(module)};import{loadSettingsSnapshot}from${JSON.stringify(loader)};import{saveShellConfig}from${JSON.stringify(saved)};const cwd=${JSON.stringify(cwd)},dir=${JSON.stringify(dir)};saveShellConfig({turnGuard:{enabled:true},routingClassifier:{enabled:true},reasoningEffort:"low",apiKeys:{FIXTURE_API_KEY:"fixture-secret-value"}},dir);const actual=await loadSettingsSnapshot(cwd,{permissionMode:"ask",plan:false,guard:false},dir);const result=await executeSettingsInspection({cwd,config:${JSON.stringify(config)}},{snapshot:async()=>actual},"settings",{});console.log(JSON.stringify({result,expected:{guard:actual.guard,savedReasoning:actual.reasoning.effort,source:actual.reasoning.source}}));`;
 const proc=Bun.spawn([process.execPath,"--no-env-file","--config=/dev/null","-e",script],{cwd,env:{PATH:process.env.PATH??"",XDG_DATA_HOME:dir},stdout:"pipe",stderr:"pipe"});const stdout=await new Response(proc.stdout).text();expect(await proc.exited).toBe(0);expect(stdout).not.toContain("fixture-secret-value");expect(stdout).not.toContain("apiKeys");const actual=JSON.parse(stdout);
 expect(actual.result).toMatchObject({ok:true,data:{effective:{configVersion:1,reasoningEffort:"high"},observed:{guard:false,reasoning:{effort:"low",source:"global"}}}});expect(actual.result.data.rows.some((row:{id:string})=>row.id==="guard")).toBe(true);
});
test("read inspection refuses unsupported mutation fields and absent local settings setup",async()=>{
 const context={cwd:"/fixture",config};expect(await executeSettingsInspection(context,undefined,"settings",{})).toMatchObject({ok:false,error:{code:"setup-required"}});
 expect(await executeSettingsInspection(context,undefined,"settings",{permissionMode:"auto"})).toMatchObject({ok:false,error:{code:"invalid-arguments"}});
 expect(settingsInspectionCommands().find(row=>row.entry.commandName==="settings")?.entry).toMatchObject({mutationClass:"read",busyPolicy:"read-only",confirmation:"none",availability:"setup-required"});
});
test("projectctx reads actual project configuration without a global settings or credentials loader",async()=>{
 const cwd=await mkdtemp(path.join(tmpdir(),"native-projectctx-"));roots.push(cwd);await mkdir(path.join(cwd,".metaproject"));await writeFile(path.join(cwd,".metaproject/tasks.config.json"),JSON.stringify({gdskills:{projectContext:{enforcement:"block",maxBytes:4096}}}));
 const result=await executeSettingsInspection({cwd,config},undefined,"projectctx",{});expect(result).toMatchObject({ok:true,data:{enforcement:"block",maxBytes:4096}});
});
test("search inspection uses the real controller selectable/configurable reads without transport or credential resolution",async()=>{
 const cwd=await mkdtemp(path.join(tmpdir(),"native-search-settings-"));roots.push(cwd);
 const {SearchProviderController,createSearchProviderRegistry}=await import("../../harness/search");let transported=false,credentialRead=false;
 const controller=new SearchProviderController(createSearchProviderRegistry({request:async()=>{transported=true;throw new Error("unexpected-network");}},()=>{credentialRead=true;throw new Error("unexpected-credential");}),cwd);
 const port={search:controller,snapshot:async()=>{throw new Error("not-needed");}};
 expect(await executeSettingsInspection({cwd,config},port,"search-provider",{})).toMatchObject({ok:true,data:{configurable:expect.arrayContaining(["duckduckgo","searxng","brave"]),selected:"duckduckgo"}});
 expect(await executeSettingsInspection({cwd,config},port,"search-connect",{})).toMatchObject({ok:true,data:{selectable:["duckduckgo"],selected:"duckduckgo"}});expect(transported).toBe(false);expect(credentialRead).toBe(false);
});
test("/mode reads the actual permission mode as a required session-settings read; only its mode changes stay local-security",async()=>{
 const {createCommandCatalogue}=await import("./catalogue");
 // The frozen rules bar permission/trust widening through chat commands, not reading the current mode; the bare command is a settings read.
 expect(createCommandCatalogue("a".repeat(64)).entries.find(row=>row.commandName==="mode")).toMatchObject({mutationClass:"read",busyPolicy:"read-only",confirmation:"none",availability:"available"});
 const port:SettingsInspectionPort={snapshot:async()=>({permissionMode:"ask",projectPermissionMode:"trust"}) as SettingsSnapshot};
 expect(await executeSettingsInspection({cwd:"/fixture",config},port,"mode",{})).toEqual({ok:true,data:{observed:{permissionMode:"ask",projectPermissionMode:"trust"},source:"actual-local-settings-snapshot"}});
 expect(await executeSettingsInspection({cwd:"/fixture",config},port,"mode",{mode:"auto"})).toMatchObject({ok:false,error:{code:"invalid-arguments"}});
});

test("the /projectctx Last resolve and References tabs, /editguard detail and /jevprofile entries read the project files the TUI reads, with no settings port",async()=>{
 const cwd=await mkdtemp(path.join(tmpdir(),"native-drill-"));roots.push(cwd);await mkdir(path.join(cwd,".metaproject"),{recursive:true});
 await writeFile(path.join(cwd,".metaproject/tasks.config.json"),JSON.stringify({review:{jev:{edit_guard:true,edit_guard_threshold:0.8,edit_guard_max_calls:3}}}));
 const {loadEditGuardStatus}=await import("../../tui/jev-edit-guard-inspector");const {readJevProfileForShell}=await import("../../commands/review-jev-profile");
 expect(await executeSettingsInspection({cwd,config},undefined,"editguard.status",{})).toEqual({ok:true,data:JSON.parse(JSON.stringify(await loadEditGuardStatus(cwd)))});
 expect(await executeSettingsInspection({cwd,config},undefined,"jevprofile.entries",{})).toEqual({ok:true,data:{entries:JSON.parse(JSON.stringify(await readJevProfileForShell(cwd)))}});
 expect(await executeSettingsInspection({cwd,config},undefined,"projectctx.last",{})).toEqual({ok:true,data:{state:"absent"}});
 expect(await executeSettingsInspection({cwd,config},undefined,"projectctx.references",{})).toEqual({ok:true,data:{state:"absent"}});
 await mkdir(path.join(cwd,".metaproject/rules/project"),{recursive:true});await writeFile(path.join(cwd,".metaproject/rules/project/references.json"),"not json");
 expect(await executeSettingsInspection({cwd,config},undefined,"projectctx.references",{})).toMatchObject({ok:true,data:{state:"invalid"}});
 for(const name of ["projectctx.last","projectctx.references","editguard.status","jevprofile.entries"]){
  expect(settingsInspectionCommands().find(row=>row.entry.commandName===name)?.entry).toMatchObject({mutationClass:"read",busyPolicy:"read-only",availability:"available"});
  expect(await executeSettingsInspection({cwd,config},undefined,name,{threshold:1})).toMatchObject({ok:false,error:{code:"invalid-arguments"}});
 }
});
