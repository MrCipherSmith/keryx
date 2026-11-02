#!/usr/bin/env node
/* Documentation-only verifier; no network, application writes, credentials or runtime migration. */
const fs=require('fs'),path=require('path');
const root=process.cwd(), dir=path.join(root,'docs/requirements/hub-work-management');
const failures=[];const check=(condition,message)=>{if(!condition)failures.push(message)};
const markdownFiles=fs.readdirSync(dir).filter(name=>name.endsWith('.md'));
for(const name of markdownFiles){
 check(fs.existsSync(path.join(dir,name)),`missing ${name}`);
 if(!fs.existsSync(path.join(dir,name)))continue;
 const text=fs.readFileSync(path.join(dir,name),'utf8');
 check(/^# .+\nVersion: \d+\.\d+\.\d+\n/.test(text),`Version not under H1: ${name}`);
 for(const match of text.matchAll(/\]\(([^)]+)\)/g)){
  if(/^[a-z]+:\/\//i.test(match[1])||match[1].startsWith('#'))continue;
  check(fs.existsSync(path.resolve(dir,match[1].split('#')[0])),`broken link ${name}: ${match[1]}`);
 }
}
const readme=fs.readFileSync(path.join(dir,'README.md'),'utf8');
for(const f of fs.readdirSync(dir)){if(f==='schemas')continue;check(f==='README.md'||readme.includes(']('+f+')'),`README omits ${f}`)}
for(const f of fs.readdirSync(path.join(dir,'schemas')))check(readme.includes('](schemas/'+f+')'),`README omits schema/example ${f}`);
const prd=fs.readFileSync(path.join(dir,'prd.md'),'utf8');const req=[...prd.matchAll(/^### (R\d+) .+\n([\s\S]*?)(?=^### |^## |$(?![\s\S]))/gm)];
check(req.length===14,`expected14 PRD requirements, got${req.length}`);
for(const [,id,body] of req)check(/Verification: (?:judged|(?:exec|invariant) `[^`]+`|none — .+)/.test(body),`missing Verification ${id}`);
check(prd.includes('### Release criteria')&&prd.includes('### Outcome criteria'),'PRD success lists missing');
const spec=fs.readFileSync(path.join(dir,'specification.md'),'utf8');for(let i=1;i<=16;i++)check(new RegExp('AC'+i+':[^\\n]+Verification: judged').test(spec),`missing verification AC${i}`);
const roadmap=fs.readFileSync(path.join(root,'docs/requirements/roadmap.md'),'utf8');check(roadmap.includes('hub-work-management/README.md'),'roadmap missing');
let Ajv;
for(const candidate of ['ajv/dist/2020',path.join(root,'deploy/team-hub/runtime/node_modules/ajv/dist/2020.js')]){try{Ajv=require(candidate);break}catch{}}
if(!Ajv)throw new Error('AJV unavailable; use existing isolated runtime dependency, do not install into shared node_modules.');
Ajv=Ajv.default||Ajv;const ajv=new Ajv({strict:true,allErrors:true});const validators={};
for(const name of ['domain','command','event']){const schema=JSON.parse(fs.readFileSync(path.join(dir,'schemas',name+'.schema.json'),'utf8'));ajv.addSchema(schema);validators[name]=schema.$id;check(spec.includes('schemas/'+name+'.schema.json'),`spec does not link schema ${name}`)}
const examples=JSON.parse(fs.readFileSync(path.join(dir,'schemas/examples.json'),'utf8'));let valid=0,invalid=0;
for(const [group,shouldPass] of [['valid',true],['invalid',false]])for(const example of examples[group]){
 const v=ajv.getSchema(validators[example.schema]);const actual=v(example.value);check(actual===shouldPass,`example ${example.name}: expected${shouldPass} actual${actual}: ${JSON.stringify(v.errors)}`);shouldPass?valid++:invalid++;
}
const report={status:failures.length?'FAIL':'PASS',markdownFiles:markdownFiles.length,prdRequirements:req.length,acceptanceCriteria:16,schemas:3,validExamples:valid,invalidExamples:invalid,failures};console.log(JSON.stringify(report,null,2));process.exitCode=failures.length?1:0;
