import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { wikiAsk } from "../../../src/wiki/ask";
import { computeAffected } from "../../../src/gdgraph/affected";
import { loadGraph } from "../../../src/gdgraph/query";
import {computeRepomap} from "../../../src/gdgraph/repomap";
import {loadGdgraphConfig} from "../../../src/gdgraph/config";
const root = process.cwd();
const temp = await mkdtemp(path.join(tmpdir(), "keryx-audit-utility-"));
const result:any = {commit:"d0a2a011df93c2459cb4329a7dc152fb0fe625a6", method:"Deterministic mechanism probes, not agent A/B or patch-success measurement"};
try {
 await mkdir(path.join(temp,".metaproject/wiki/architecture"),{recursive:true});
 await mkdir(path.join(temp,".metaproject/memory/lessons"),{recursive:true});
 await writeFile(path.join(temp,".metaproject/wiki/architecture/example.md"),`# Example architecture
Version: 1.0.0
Type: architecture
Status: accepted

## Summary
General project architecture.

## Details
The uniquequartzprotocol retries exactly three times.
`);
 for(const status of ["accepted","draft","deprecated","conflict","superseded"]){
  await writeFile(path.join(temp,`.metaproject/memory/lessons/${status}.md`),`# auditmarker ${status}
Version: 1.0.0
Type: lesson
Status: ${status}
Confidence: high

## Summary
auditmarker example guidance ${status}.
`);
 }
 await writeFile(path.join(temp,".metaproject/memory/lessons/future.md"),`# auditmarker future
Version: 1.0.0
Type: lesson
Status: accepted
Confidence: high
ValidFrom: 2099-01-01

## Summary
auditmarker future guidance.
`);
 result.bodyOnly = await wikiAsk({cwd:temp,question:"uniquequartzprotocol",k:10});
 result.lifecycle = await wikiAsk({cwd:temp,question:"auditmarker",k:10});
 const graph = await loadGraph(root);
 result.graph = {nodes:graph.nodes.length,edges:graph.edges.length,symbols:graph.symbols?.length??0,unresolved:graph.edges.filter(e=>e.kind==="unresolved").length};
 const target="src/lib/serve-credential.ts";
 const map=computeRepomap(graph,await loadGdgraphConfig(root),{budget:1500,seed:[target]});
 result.repomap={entries:map.entries.length,zeroScore:map.entries.filter(e=>e.score===0).length,positiveScore:map.entries.filter(e=>e.score>0).length,estimatedTokens:map.tokens,hasServer:map.entries.some(e=>e.path==="src/lib/serve-server.ts")};
 result.direct=computeAffected(graph,target,{depth:1});
 result.transitive=computeAffected(graph,target,{depth:2,ranked:true});
 result.unknown=computeAffected(graph,"src/nonexistent-audit-target.ts",{depth:2});
 result.wikiQueries=[];
 for(const question of ["OS sandbox Seatbelt bubblewrap network","permission modes ask trust auto","How does shared agent context relate to wiki graph memory?","How are remote HTTP requests authenticated and authorized?","quuxneverexistingzz how does it work?"]){
  const t=performance.now(); const r=await wikiAsk({cwd:root,question,k:3});
  result.wikiQueries.push({question,ms:Math.round(performance.now()-t),citations:r.citations,answer:r.answerMarkdown});
 }
 console.log(JSON.stringify(result,null,2));
} finally {await rm(temp,{recursive:true,force:true});}
