/**
 * Real-browser journeys of output/hub-remote-sessions/final-browser-plan.md against the built Hub web assets and the
 * deterministic two-process serve fixture (src/lib/hub-machine/trial.test-support.ts: two separately spawned `keryx serve`
 * children, isolated Git checkouts and config roots, a loopback provider). Not a vitest case; run it explicitly with Bun:
 *
 *   bun --no-env-file apps/hub-web/tests/browser-journeys.e2e.mjs [--cells=en-375,ru-375,en-desktop,ru-desktop] [--out=<json>]
 *
 * Browser: the Playwright library that ships with the locally installed Playwright MCP (override with KERYX_PLAYWRIGHT_MODULE)
 * and its cached headless Chromium. Nothing is installed. Each cell gets a fresh fixture and a fresh non-persistent browser
 * context; the synthetic operator session is obtained privately through the existing login endpoint from the fixture's
 * owner-only credential file, and no token, cookie or Authorization header is ever printed or written.
 * A visible card is never taken as proof of execution: every journey checks Hub records and local effects (files, processes,
 * the serve child's hook log) alongside the page.
 */
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'../../..');
const options=new Map(process.argv.slice(2).map(arg=>{const at=arg.indexOf('=');return at<0?[arg,'']:[arg.slice(0,at),arg.slice(at+1)];}));
const output=path.resolve(root,options.get('--out')||'output/hub-remote-sessions/s4-browser-evidence.json');
const shots=path.resolve(root,options.get('--shots')||'output/hub-remote-sessions/s4-browser');
const cellIds=(options.get('--cells')||'en-375,ru-375,en-desktop,ru-desktop').split(',');
const viewports={375:{width:375,height:812},desktop:{width:1366,height:900}};
const playwrightModule=process.env.KERYX_PLAYWRIGHT_MODULE||'/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright';
const {chromium}=createRequire(import.meta.url)(playwrightModule);
const bun=process.versions.bun?process.execPath:'bun';
const gitEnv={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha256=value=>createHash('sha256').update(value).digest('hex');
const TRIAL_REPLY='Deterministic native trial completed. No vendor model was called.';
const turn=(ordinal,text)=>`keryx-trial-turn-${ordinal}: ${text}`;
const marker=(machine,ordinal)=>`keryx-trial-supervised-${machine}-${ordinal}`;
const processesWith=text=>spawnSync('ps',['-axo','pid=,command=']).stdout.toString().split('\n').filter(line=>line.includes(text));
const killGroups=text=>{for(const line of spawnSync('ps',['-axo','pgid=,command=']).stdout.toString().split('\n').filter(l=>l.includes(text))){try{process.kill(-Number(line.trim().split(/\s+/)[0]),'SIGKILL');}catch{/* gone */}}};
async function until(read,done,ms=20000,label='condition'){const deadline=Date.now()+ms;for(;;){const value=await read();if(done(value))return value;if(Date.now()>deadline)throw new Error(`timeout: ${label}: ${JSON.stringify(value).slice(0,300)}`);await sleep(150);}}

/** The candidate this run exercised: HEAD, the embedded web build and a digest of every changed or untracked source file. */
async function candidate(){
 const head=spawnSync('git',['-C',root,'rev-parse','HEAD'],{env:gitEnv}).stdout.toString().trim();
 const listed=spawnSync('git',['-C',root,'status','--porcelain=v1','-z','--untracked-files=all','--','src','apps/hub-web/src','apps/hub-web/tests','apps/hub-web/package.json','scripts','package.json','bun.lock'],{env:gitEnv}).stdout.toString().split('\0').filter(Boolean).map(entry=>entry.slice(3)).filter(file=>existsSync(path.join(root,file))).sort();
 const tree=sha256(listed.map(file=>`${file}\0${sha256(readFileSync(path.join(root,file)))}`).join('\n'));
 const generated=path.join(root,'src/hub/web-assets.generated.ts');const web=await import(generated);
 return {head,changedFiles:listed.length,workingTreeDigest:tree,webInputDigest:web.webInputDigest,webAssetsFileSha256:sha256(readFileSync(generated)),webAssetCount:Object.keys(web.webAssets).length};
}
async function startFixture(){
 const child=spawn(bun,['--no-env-file','--config=/dev/null',path.join(root,'src/lib/hub-machine/trial.test-support.ts')],{cwd:root,stdio:['ignore','pipe','pipe'],env:gitEnv});
 let buffer='';child.stderr.resume();
 const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('fixture-not-ready')),90000);child.stdout.on('data',chunk=>{buffer+=chunk.toString();for(const line of buffer.split('\n')){if(!line.startsWith('{'))continue;try{const value=JSON.parse(line);if(value.kind==='trial-ready'){clearTimeout(timer);resolve(value);}}catch{/* An incomplete line. */}}});child.on('exit',code=>{clearTimeout(timer);reject(new Error(`fixture-exited-${code}`));});});
 const exited=new Promise(resolve=>child.on('exit',resolve));
 return {...ready,async stop(){for(const t of ready.targets)killGroups(`keryx-trial-supervised-${t.machine}-`);child.kill('SIGTERM');const forced=setTimeout(()=>child.kill('SIGKILL'),30000);await exited;clearTimeout(forced);rmSync(ready.root,{recursive:true,force:true});}};
}
async function dictionaries(lang){const load=async name=>(await import(path.join(root,`apps/hub-web/src/i18n/${name}.${lang}.ts`))).default;return {L:await load('remote'),C:await load('common'),X:await load('context')};}

class JourneyFailure extends Error{}
async function runCell(browser,id){
 const [lang,size]=id.split('-');const viewport=viewports[size];const {L,C,X}=await dictionaries(lang);
 const cell={cell:id,lang,viewport,startedAt:new Date().toISOString(),fixture:null,journeys:[]};
 const fx=await startFixture();cell.fixture={origin:'loopback',projectId:fx.projectId,machines:fx.targets.map(t=>({machine:t.machine,machineId:t.machineId,checkoutId:t.checkoutId,servePid:t.servePid})),mode:fx.mode};
 const [m1,m2]=fx.targets;const contexts=[];
 const login=async()=>{const context=await browser.newContext({viewport});contexts.push(context);const token=readFileSync(fx.credentialsFile,'utf8');const response=await context.request.post(fx.origin+'/hub/v1/session',{data:{token},headers:{Origin:fx.origin,'Idempotency-Key':randomUUID()}});if(!response.ok())throw new Error(`login-${response.status()}`);return context;};
 const api=context=>async route=>{const response=await context.request.get(fx.origin+route);if(!response.ok())throw new Error(`api-${response.status()}-${route}`);return response.json();};
 const journeys=new Map();
 const begin=(n,title)=>{const j={journey:n,title,status:'pending',assertions:[],receipts:{},screenshots:[],notRun:[]};journeys.set(n,j);cell.journeys.push(j);return j;};
 const check=(j,name,ok,detail)=>{j.assertions.push({name,ok:!!ok,...(detail===undefined?{}:{detail})});if(!ok)throw new JourneyFailure(name);};
 /** A failed layout assertion fails its journey but does not stop the journey's later behavioural steps. */
 const soft=(j,name,ok,detail)=>{j.assertions.push({name,ok:!!ok,...(detail===undefined?{}:{detail})});if(!ok)j.softFailures=[...(j.softFailures??[]),name];};
 const shot=async(j,page,name)=>{mkdirSync(shots,{recursive:true});const file=path.join(shots,`${id}-j${j.journey}-${name}.png`);await page.screenshot({path:file,fullPage:false});j.screenshots.push(path.relative(root,file));};
 const attempt=async(j,body)=>{try{await body();j.status=j.softFailures?.length?'failed':j.notRun.length?'pending':'passed';if(j.softFailures?.length)j.error=j.softFailures.join('; ');}catch(error){j.status='failed';j.hard=true;j.error=String(error instanceof Error?error.message:error).slice(0,1200);}};
 const blocked=(n,title,reason)=>{const j=begin(n,title);j.notRun.push(reason);return j;};
 const panel=(page,title)=>page.locator('section').filter({has:page.getByRole('heading',{name:title,exact:true})});
 const navButton=(page,name)=>page.getByRole('navigation',{name:C.appName}).getByRole('button',{name,exact:true});
 const fit=page=>page.evaluate(()=>{const width=window.innerWidth;const scrollable=el=>{for(let n=el.parentElement;n;n=n.parentElement){const s=window.getComputedStyle(n);if(['auto','scroll'].includes(s.overflowX))return true;}return false;};const outside=[...document.querySelectorAll('button,label,h1,h2,p,dt,dd,select,input,textarea,a,summary')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.right>width+1&&!scrollable(el);}).map(el=>(el.textContent||el.tagName).trim().slice(0,40));const clipped=[...document.querySelectorAll('button')].filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>(el.textContent||'').trim().slice(0,40));return {documentWidth:document.documentElement.scrollWidth,viewport:width,outside:outside.slice(0,5),clipped:clipped.slice(0,5)};});
 const fits=(j,label,value)=>soft(j,`${label}: no horizontal overflow and every label inside the viewport`,value.documentWidth<=value.viewport&&value.outside.length===0&&value.clipped.length===0,value);
 const hookCount=tool=>{const log=path.join(m1.cwd,'.metaproject','trial-hook-events.jsonl');return existsSync(log)?readFileSync(log,'utf8').split('\n').filter(line=>line.includes(`"keryxToolName":"${tool}"`)).length:0;};
 try{
  const context=await login();const page=await context.newPage();const read=api(context);const errors=[];page.on('pageerror',e=>errors.push(String(e).slice(0,200)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text().slice(0,200));});
  // Refused Hub requests by path and error code only: response bodies of refusals carry no credential.
  const refusals=[];const mutations=[];cell.mutations=mutations;page.on('response',async response=>{if(response.request().method()!=='GET')mutations.push({path:new URL(response.url()).pathname.replace(/[0-9a-f-]{36}|[0-9a-f]{64}/g,':id'),method:response.request().method(),status:response.status(),at:new Date().toISOString()});if(response.status()<400)return;let code='';try{code=(await response.json())?.error?.code??'';}catch{/* Not JSON. */}refusals.push({path:new URL(response.url()).pathname.replace(/[0-9a-f-]{36}|[0-9a-f]{64}/g,':id'),method:response.request().method(),status:response.status(),code});});cell.refusals=refusals;
  // Every cell starts from the default (RU) locale and switches explicitly, so both toggles are exercised.
  await page.goto(fx.origin+'/');await page.getByLabel((await dictionaries('ru')).C.project,{exact:true}).waitFor();
  const languages=page.getByRole('group',{name:(await dictionaries('ru')).C.language}).first();
  await languages.getByRole('button',{name:lang.toUpperCase(),exact:true}).click();await until(()=>page.evaluate(()=>document.documentElement.lang),v=>v===lang,5000,'html lang');await page.getByLabel(C.project,{exact:true}).waitFor();
  let ordinal=0;let sessionId='';let sessionPath='';const runs={};
  const sessionRecord=()=>read(sessionPath);
  const latestRun=async(after=new Set())=>until(async()=>(await read(`/hub/v2/projects/${fx.projectId}/runs`)).runs.filter(r=>r.sessionId===sessionId&&!after.has(r.runId)),list=>list.length>0,20000,'run admitted').then(list=>list.at(-1));
  const runState=(runId,done,ms=30000)=>until(()=>read(`/hub/v2/projects/${fx.projectId}/runs/${runId}`),done,ms,`run ${runId}`);
  // In-app navigation only: a full reload makes this tab an observer again (its explicit controller claim is not persisted).
  const openSession=async()=>{await navButton(page,L.sessions).click();await panel(page,`Browser ${id}`).getByRole('button',{name:L.details,exact:true}).click();await panel(page,L.controller).waitFor();};
  const openRun=async runId=>{await navButton(page,L.runs).click();const card=panel(page,runId);await card.getByRole('button',{name:L.details,exact:true}).click();await panel(page,L.actual).waitFor();};
  /** The session version this tab displays (Versions panel), to wait until the page caught up with Hub. */
  const shownVersion=()=>page.evaluate(label=>{const dt=[...document.querySelectorAll('dt')].find(d=>d.textContent?.trim()===label);return dt?Number(dt.nextElementSibling?.textContent):NaN;},L.sessionVersion);
  const settled=async()=>until(async()=>[await shownVersion(),(await sessionRecord()).version],([a,b])=>a===b,15000,'page caught up with the session version');
  /** After the human's own completed work moved the versions, a draft is rebased the way the page offers it. */
  const rebases=[];const rebase=async(where)=>{await settled();const button=page.getByRole('button',{name:L.rebase,exact:true});const n=await button.count();for(let i=0;i<n;i++){if(await button.nth(i).isVisible()){await button.nth(i).click();rebases.push(where);}}};cell.rebases=rebases;
  /** Fills the composer as a human would: literal text, explicit ad-hoc work with consent, the chosen busy policy. */
  const compose=async(text,policy='reject',rebaseFirst=true)=>{if(rebaseFirst)await rebase('composer');const composer=panel(page,L.message);await composer.getByLabel(L.message,{exact:true}).fill(text);await composer.getByLabel(L.workMode,{exact:true}).selectOption('ad-hoc');await composer.getByLabel(L.adHocConsent).check();await composer.getByLabel(L.busyPolicy,{exact:true}).selectOption(policy);return composer;};
  const send=async(text,policy='reject',expected='admitted')=>{const before=new Set((await read(`/hub/v2/projects/${fx.projectId}/runs`)).runs.map(r=>r.runId));const composer=await compose(text,policy);await composer.getByRole('button',{name:L.send,exact:true}).click();try{await composer.getByText(L.receiptStatuses[expected],{exact:true}).waitFor({timeout:20000});}catch{throw new JourneyFailure(`no ${expected} receipt: ${(await composer.locator('[role=alert]').allTextContents()).join(' | ').slice(0,300)} ${JSON.stringify(refusals.slice(-3))}`);}return before;};

  // Journey 1: exact selection, readiness, fit, keyboard, observer.
  const j1=begin(1,'Select exact project/machine/checkout/profile; ready vs offline/setup-required/unsupported; labels fit; keyboard access; observer cannot mutate or silently claim control');
  await attempt(j1,async()=>{
   await page.getByLabel(C.project,{exact:true}).selectOption(fx.projectId);await navButton(page,L.machines).click();
   for(const [index,t] of [m1,m2].entries()){const card=panel(page,`Deterministic serve machine ${index+1}`);await card.waitFor();check(j1,`${t.machine} shown online`,await card.getByText(L.online,{exact:true}).isVisible());check(j1,`${t.machine} profile shown ready from the published inventory`,await card.getByText(`remote-restricted · ${L.ready} · none`,{exact:true}).isVisible());}
   const listed=await read(`/hub/v2/machines?projectId=${fx.projectId}`);check(j1,'Hub inventory agrees: both machines connected and ready',listed.machines.length===2&&listed.machines.every(m=>m.connected&&m.inventory.checkouts.every(c=>c.agentProfiles.every(p=>p.readiness==='ready'))),listed.machines.map(m=>({machineId:m.machineId,connected:m.connected})));
   fits(j1,'machines',await fit(page));await shot(j1,page,'machines');
   // Keyboard: Tab reaches the Sessions navigation item and Enter opens it.
   let reached=false;for(let i=0;i<60&&!reached;i++){await page.keyboard.press('Tab');reached=await page.evaluate(name=>document.activeElement?.tagName==='BUTTON'&&document.activeElement.textContent?.trim()===name,L.sessions);}
   check(j1,'Tab reaches the Sessions navigation item',reached);await page.keyboard.press('Enter');await until(()=>page.evaluate(()=>window.location.search),v=>v.includes('view=sessions'),5000,'keyboard navigation');check(j1,'Enter on the focused navigation item opens Sessions',true);
   await page.getByRole('button',{name:L.newSession,exact:true}).click();const form=panel(page,L.newSession);const create=form.getByRole('button',{name:L.createSession,exact:true});
   check(j1,'Create is disabled before every explicit choice',await create.isDisabled());
   const machineSelect=form.getByLabel(L.machine,{exact:true});check(j1,'no machine preselected (explicit choice required)',await machineSelect.inputValue()==='');
   await machineSelect.selectOption(m1.machineId);await form.getByLabel(L.checkout,{exact:true}).selectOption(m1.checkoutId);check(j1,'Create still disabled without profile and title',await create.isDisabled());
   await form.getByLabel(L.profile,{exact:true}).selectOption('remote-restricted');await form.getByLabel(L.title,{exact:true}).fill(`Browser ${id}`);
   check(j1,'Git HEAD and digests shown for the exact checkout',await form.getByText(L.head,{exact:true}).isVisible());fits(j1,'create form',await fit(page));await shot(j1,page,'create-form');
   check(j1,'Create enabled only after machine, checkout, profile and title',await create.isEnabled());await create.click();
   await until(()=>page.evaluate(()=>new URLSearchParams(window.location.search).get('session')),v=>!!v,20000,'session created');sessionId=await page.evaluate(()=>new URLSearchParams(window.location.search).get('session'));sessionPath=`/hub/v2/projects/${fx.projectId}/sessions/${sessionId}`;j1.receipts.sessionId=sessionId;
   const record=await until(sessionRecord,v=>v.state==='idle',20000,'session idle');check(j1,'session hosted by the exact machine/checkout/profile',record.machineId===m1.machineId&&record.checkoutId===m1.checkoutId&&record.agentProfileId==='remote-restricted');
   const controller=panel(page,L.controller);await controller.waitFor();check(j1,'a fresh tab is an observer until it claims',await controller.getByText(L.observer,{exact:true}).isVisible());check(j1,'observer cannot send',await panel(page,L.message).getByRole('button',{name:L.send,exact:true}).isDisabled());check(j1,'no controller was claimed implicitly',(await sessionRecord()).controller===null);
   j1.notRun.push('setup-required/unsupported profile display: the deterministic fixture publishes only ready profiles');
  });

  // Journey 2: ad-hoc turn, ordered history, tool progress, two real renewals with an unsent draft, a later read.
  const j2=begin(2,'Explicit ad-hoc session, real provider turn, ordered history and tool progress, two own-controller renewals keep an unsent draft, a later real read');
  await attempt(j2,async()=>{
   if(!sessionId)throw new JourneyFailure('no session from journey 1');
   const controller=panel(page,L.controller);await controller.getByRole('button',{name:L.claim,exact:true}).click();await controller.getByRole('button',{name:L.release,exact:true}).waitFor({timeout:20000});
   const held=await until(sessionRecord,v=>v.controller?.state==='held',20000,'controller held');check(j2,'controller claimed explicitly by the human operator',held.controller.actorKind==='human-operator');j2.receipts.controllerLeaseId=held.controller.controllerLeaseId;
   const before=await send(turn(++ordinal,'read seed.txt'));const run=await latestRun(before);runs.read1=run.runId;j2.receipts.readRunId=run.runId;
   const done=await runState(run.runId,v=>v.state==='succeeded');check(j2,'the read turn succeeded on the machine (Hub run record)',done.state==='succeeded');
   const history=panel(page,L.history);await history.getByText(TRIAL_REPLY).first().waitFor({timeout:20000});check(j2,'history shows the operator turn then the assistant reply in order',(await history.locator('li pre').allTextContents()).join('\n').indexOf(turn(1,'read seed.txt'))<(await history.locator('li pre').allTextContents()).join('\n').indexOf(TRIAL_REPLY));
   await openRun(run.runId);check(j2,'run page shows the actual succeeded state',await panel(page,L.actual).getByText(L.states.succeeded,{exact:true}).isVisible());check(j2,'run output shows the real read_file tool progress',await panel(page,L.output).getByText(/read_file/).first().isVisible());check(j2,'the serve child hook saw exactly one read_file call',hookCount('read_file')===1,hookCount('read_file'));
   fits(j2,'run page',await fit(page));await shot(j2,page,'read-run');
   await openSession();const draft=turn(++ordinal,'read seed.txt');await compose(draft);
   const first=(await sessionRecord()).controller.expiresAt;const renewals=new Set([first]);
   await until(async()=>{renewals.add((await sessionRecord()).controller?.expiresAt);return renewals.size;},n=>n>=3,55000,'two controller renewals');j2.receipts.renewedExpiries=[...renewals];await settled();await sleep(500);
   const composer=panel(page,L.message);check(j2,'after two real renewals the unsent draft is intact',await composer.getByLabel(L.message,{exact:true}).inputValue()===draft);check(j2,'no manual version rebasing was needed',!(await composer.getByText(L.stale).isVisible()));check(j2,'send stays enabled',await composer.getByRole('button',{name:L.send,exact:true}).isEnabled());
   const beforeLater=new Set((await read(`/hub/v2/projects/${fx.projectId}/runs`)).runs.map(r=>r.runId));await composer.getByRole('button',{name:L.send,exact:true}).click();try{await composer.getByText(L.receiptStatuses.admitted,{exact:true}).waitFor({timeout:20000});}catch{throw new JourneyFailure(`later read not admitted: ${(await composer.locator('[role=alert]').allTextContents()).join(' | ').slice(0,300)} ${JSON.stringify(refusals.slice(-3))}`);}
   const later=await latestRun(beforeLater);j2.receipts.laterReadRunId=later.runId;check(j2,'the later real read succeeded',(await runState(later.runId,v=>v.state==='succeeded')).state==='succeeded');check(j2,'two read_file calls in total, none repeated',hookCount('read_file')===2,hookCount('read_file'));
   await shot(j2,page,'after-renewals');
  });

  // Journey 3: typed help, settings inspection and a read command; malformed input reports validation; no Flow involved.
  const j3=begin(3,'Typed help, settings inspection and a real allowed read through one command surface; malformed command reports validation; inspection stays Flow-free');
  await attempt(j3,async()=>{
   if(!j2.receipts.controllerLeaseId)throw new JourneyFailure('no controller from journey 2');
   await openSession();await until(sessionRecord,v=>v.state==='idle',20000,'idle');const commands=panel(page,L.commands);const operations=[];
   for(const name of ['settings','status']){await commands.getByLabel(L.command,{exact:true}).selectOption(name);await rebase('commands');await commands.getByLabel(L.arguments,{exact:true}).fill('{}');await commands.getByRole('button',{name:L.invoke,exact:true}).click();await commands.getByText(L.receiptStatuses.applied,{exact:true}).waitFor({timeout:20000});
    const receipt=JSON.parse(await commands.locator('details pre').last().textContent());operations.push({commandName:receipt.commandName,operationId:receipt.operationId,status:receipt.status});check(j3,`${name} applied by the machine through the shared handler`,receipt.commandName===name&&receipt.status==='applied'&&receipt.errorCode===null,{status:receipt.status});}
   j3.receipts.operations=operations;
   const before=await sessionRecord();const toolCalls=['read_file','apply_patch','shell_exec'].map(hookCount);
   await commands.getByLabel(L.command,{exact:true}).selectOption('status');await commands.getByLabel(L.arguments,{exact:true}).fill('{"unterminated":');await commands.getByRole('button',{name:L.invoke,exact:true}).click();
   check(j3,'malformed JSON arguments are refused locally with a validation notice',await commands.getByText(L.required,{exact:true}).isVisible());
   await commands.getByLabel(L.arguments,{exact:true}).fill('{"bogus":true}');await commands.getByRole('button',{name:L.invoke,exact:true}).click();await until(async()=>commands.locator('[role=alert]').count(),n=>n>0,20000,'schema refusal');
   const after=await sessionRecord();check(j3,'schema-invalid arguments reach no provider turn or tool',after.historyVersion===before.historyVersion&&['read_file','apply_patch','shell_exec'].map(hookCount).join()===toolCalls.join(),{history:[before.historyVersion,after.historyVersion]});
   const flows=await read(`/hub/v1/projects/${fx.projectId}/flows`);check(j3,'no Flow exists or was needed for inspection',Array.isArray(flows.flows)&&flows.flows.length===0);fits(j3,'commands',await fit(page));await shot(j3,page,'commands');
  });

  // Journey 4: an approved patch applies once; a denied one has no effect.
  const j4=begin(4,'Workspace patch: no effect before exact Allow once, recorded/delivered/applied distinction, one allowance one mutation, a denied action has no effect');
  await attempt(j4,async()=>{
   await openSession();await until(sessionRecord,v=>v.state==='idle',20000,'idle');
   const before=await send(turn(++ordinal,'write an approved native patch'));const run=await latestRun(before);runs.patch=run.runId;j4.receipts.approvedRunId=run.runId;const file=path.join(m1.cwd,`trial-edit-${ordinal}.txt`);
   await runState(run.runId,v=>v.state==='waiting-approval');await openRun(run.runId);const card=panel(page,L.approval);await card.waitFor({timeout:20000});
   const summary=await card.locator('p').first().textContent();check(j4,'the approval shows the original target and action',summary.includes(`trial-edit-${ordinal}.txt`),summary.slice(0,200));check(j4,'waiting for the human decision',await card.getByText(L.receiptStatuses.waiting,{exact:true}).isVisible());check(j4,'no workspace effect before Allow once',!existsSync(file));
   await shot(j4,page,'approval-waiting');await card.getByRole('button',{name:L.allowOnce,exact:true}).click();
   await card.getByText(L.receiptStatuses.applied,{exact:true}).waitFor({timeout:30000});const ended=await runState(run.runId,v=>v.state==='succeeded'&&v.result!==undefined);j4.receipts.approvalId=ended.approvals[0]?.approvalId;j4.receipts.revisionId=ended.result.revisionId;
   check(j4,'applied (not merely recorded) per the executor outcome',ended.approvals[0]?.status==='applied',ended.approvals.map(a=>a.status));check(j4,'exactly one mutation from one allowance',readFileSync(file,'utf8')===`deterministic native edit ${ordinal}\n`&&hookCount('apply_patch')===1);await shot(j4,page,'approval-applied');
   await openSession();await until(sessionRecord,v=>v.state==='idle',20000,'idle');const beforeDeny=await send(turn(++ordinal,'write a denied native patch'));const denied=await latestRun(beforeDeny);j4.receipts.deniedRunId=denied.runId;const deniedFile=path.join(m1.cwd,`trial-edit-${ordinal}.txt`);
   await runState(denied.runId,v=>v.state==='waiting-approval');await openRun(denied.runId);const denyCard=panel(page,L.approval);await denyCard.getByRole('button',{name:L.deny,exact:true}).click();
   const deniedEnd=await runState(denied.runId,v=>['succeeded','failed','cancelled'].includes(v.state));check(j4,'a denied action has no effect',!existsSync(deniedFile),{state:deniedEnd.state,approval:deniedEnd.approvals.map(a=>[a.status,a.decision])});check(j4,'the denial is a recorded human decision',deniedEnd.approvals[0]?.decision==='deny');
   j4.notRun.push('expired/stale approval cannot resume work: needs the 120 s approval deadline; covered by bridge.approvals network tests, not this browser run');
  });

  // Journeys 5, 6 and 7 share one supervised sleep: queue, observer reconnect, cancellation.
  const j5=begin(5,'Queue while busy: queued receipt, edit/remove the exact queued identity, only the final admitted input reaches the provider');
  const j6=begin(6,'Reconnect an observer while work runs: history and identity kept, no duplicated tool work, no implicit takeover; a second machine stays separately scoped');
  const j7=begin(7,'Cancel a real owned supervised task: requested/confirmed distinguished; close when idle seals then closes after measured cessation');
  let sleeper='';let sleepOrdinal=0;
  await attempt(j6,async()=>{
   await openSession();await until(sessionRecord,v=>v.state==='idle',20000,'idle');sleepOrdinal=++ordinal;const before=await send(turn(sleepOrdinal,'cancel supervised sleep work'));const run=await latestRun(before);sleeper=run.runId;j7.receipts.runId=sleeper;
   await runState(sleeper,v=>v.state==='waiting-approval');await openRun(sleeper);await panel(page,L.approval).getByRole('button',{name:L.allowOnce,exact:true}).click();await until(async()=>processesWith(marker(m1.machine,sleepOrdinal)).length,n=>n===1,30000,'supervised child');
   const second=await login();const observer=await second.newPage();await observer.goto(`${fx.origin}/?project=${fx.projectId}&view=sessions&session=${sessionId}`);await observer.getByRole('group',{name:(await dictionaries('ru')).C.language}).first().getByRole('button',{name:lang.toUpperCase(),exact:true}).click();const watching=panel(observer,L.controller);await watching.waitFor();
   check(j6,'the reconnecting tab is an observer',await watching.getByText(L.observer,{exact:true}).isVisible());check(j6,'it cannot claim the held controller silently',await watching.getByRole('button',{name:L.claim,exact:true}).isDisabled());check(j6,'it cannot send',await panel(observer,L.message).getByRole('button',{name:L.send,exact:true}).isDisabled());
   await observer.reload();await panel(observer,L.history).getByText(turn(sleepOrdinal,'cancel supervised sleep work')).first().waitFor({timeout:20000});check(j6,'history survives the reload with the running turn',true);
   const record=await sessionRecord();check(j6,'the same native session identity and controller after the reconnect',record.sessionId===sessionId&&record.controller?.controllerLeaseId===j2.receipts.controllerLeaseId&&record.activeRunId===sleeper);
   check(j6,'no duplicated tool work: one supervised child, one shell_exec hook',processesWith(marker(m1.machine,sleepOrdinal)).length===1&&hookCount('shell_exec')===1);
   await observer.goto(`${fx.origin}/?project=${fx.projectId}&view=machines`);await panel(observer,'Deterministic serve machine 2').getByText(L.online,{exact:true}).waitFor({timeout:15000});check(j6,'the second machine stays online and separately scoped',true);
   const all=(await read(`/hub/v2/projects/${fx.projectId}/runs`)).runs;check(j6,'no run ever reached the second machine',all.every(r=>r.machineId===m1.machineId));fits(j6,'observer',await fit(observer));await shot(j6,observer,'observer');await second.close();
  });
  await attempt(j5,async()=>{
   if(!sleeper)throw new JourneyFailure('no running turn from journey 6');
   await openSession();const queuedOrdinal=++ordinal;await send(turn(queuedOrdinal,'write an approved native patch'),'enqueue','queued');
   const queue=panel(page,L.queue);const item=queue.locator('article').first();await item.waitFor({timeout:20000});const first=await read(`${sessionPath}/queue`);check(j5,'a durable queued identity exists',first.items.length===1&&first.items[0].state==='queued');j5.receipts.queuedOperationId=first.items[0].operationId;j5.receipts.queueItemId=first.items[0].queueItemId;
   await item.getByLabel(L.edit,{exact:true}).fill(turn(queuedOrdinal,'read seed.txt'));await item.getByRole('button',{name:L.save,exact:true}).click();await until(()=>read(`${sessionPath}/queue`),q=>q.items[0]?.text===turn(queuedOrdinal,'read seed.txt'),20000,'queue edit');check(j5,'the edit applied to the exact queued identity',true);
   await send(turn(queuedOrdinal+1,'write a removed native patch'),'enqueue','queued');const two=await until(()=>read(`${sessionPath}/queue`),q=>q.items.length===2,20000,'second queued');const removed=two.items.find(i=>i.text.includes('removed'));j5.receipts.removedOperationId=removed.operationId;
   const removeCard=panel(page,L.queue).locator('article').filter({hasText:removed.operationId});await removeCard.getByRole('button',{name:L.remove,exact:true}).click();await until(()=>read(`${sessionPath}/queue`),q=>!q.items.some(i=>i.operationId===removed.operationId&&i.state==='queued'),20000,'queue remove');check(j5,'the removed identity is no longer queued',true);
   await shot(j5,page,'queue');j5.notRun.push('queued model/config change and routing fallback provenance: not exercised in this run');
  });
  await attempt(j7,async()=>{
   if(!sleeper)throw new JourneyFailure('no running turn from journey 6');
   await openRun(sleeper);const cancel=panel(page,L.cancel);await cancel.getByLabel(L.cancelReason,{exact:true}).fill('Stop the supervised browser sleep');await cancel.getByRole('button',{name:L.cancel,exact:true}).click();
   await cancel.getByText(L.receiptStatuses.requested,{exact:true}).first().waitFor({timeout:20000});check(j7,'cancel shows requested, not stopped',true);const ended=await runState(sleeper,v=>v.state==='cancelled',30000);
   await panel(page,L.actual).getByText(L.states.cancelled,{exact:true}).waitFor({timeout:20000});check(j7,'confirmed only after the executor measured cessation',ended.state==='cancelled'&&processesWith(marker(m1.machine,sleepOrdinal)).length===0);await shot(j7,page,'cancelled');
  });
  // The queued, edited message is admitted after the cancel; the deterministic provider picks the tool from the text it received.
  await attempt(j5,async()=>{
   if(j5.hard)throw new JourneyFailure(j5.error);
   const admitted=await until(async()=>(await read(`/hub/v2/projects/${fx.projectId}/runs`)).runs.filter(r=>r.sessionId===sessionId&&r.runId!==sleeper&&![runs.read1,j2.receipts.laterReadRunId,runs.patch,j4.receipts.deniedRunId].includes(r.runId)),l=>l.length>0,30000,'queued admission');const queuedRun=admitted.at(-1);j5.receipts.admittedRunId=queuedRun.runId;
   const done=await runState(queuedRun.runId,v=>v.state==='succeeded',30000);const events=await read(`/hub/v2/projects/${fx.projectId}/runs/${queuedRun.runId}/events`);
   check(j5,'only the edited input reached the provider: it ran read_file, never the original patch',events.events.some(e=>e.kind==='log'&&e.text.includes('read_file'))&&!events.events.some(e=>e.kind==='approval-request')&&done.state==='succeeded');
   const history=await read(`${sessionPath}/history`);check(j5,'the removed message never entered history',!history.messages.some(m=>m.text.includes('removed native patch')));
  });
  await attempt(j7,async()=>{
   if(j7.hard)throw new JourneyFailure(j7.error);
   await openSession();await until(sessionRecord,v=>v.state==='idle',30000,'idle');const surface=panel(page,L.versions);await surface.getByRole('button',{name:L.close,exact:true}).click();
   const closed=await until(sessionRecord,v=>v.state==='closed',30000,'closed');check(j7,'close when idle closed the session after measured cessation',closed.state==='closed'&&closed.activeRunId===null);j7.receipts.closedSessionVersion=closed.version;
   j7.notRun.push('uncertain stop stays recovery-required: covered by the serve-path crash trial (trial.process.test.ts), not by this browser run');
  });

  blocked(8,'Protected local expired-idle recovery on the running process and explicit human re-claim/resume','not exercised in this early run: needs a 60 s controller expiry plus the local owner CLI on the fixture machine; the serve-path crash trial covers the uncertain branch');
  blocked(9,'Associate an exact eligible frozen in-progress Flow; switch Flows; stale/completed association refuses','not exercised: the deterministic fixture project has no frozen in-progress Flow, and creating one needs the human spec freeze lifecycle');

  // Journey 10: the result is a review-only bundle; deep links survive refresh and Back/Forward.
  const j10=begin(10,'Code Revision stays review-only: Git Select/Delivery blocked; no acceptance by automation; refresh and Back/Forward keep loaded data');
  await attempt(j10,async()=>{
   if(!runs.patch)throw new JourneyFailure('no approved patch from journey 4');
   await openRun(runs.patch);await panel(page,L.actual).getByRole('button',{name:L.result,exact:true}).click();await until(()=>page.evaluate(()=>window.location.search),v=>v.includes('view=code')&&v.includes('revision='),10000,'revision deep link');
   await page.getByText(X.reviewBundleHint,{exact:true}).waitFor({timeout:20000});check(j10,'the revision is labelled a review bundle with selection and delivery blocked',true);check(j10,'no Select-for-integration control exists for it',await page.getByRole('button',{name:X.selectForIntegration}).count()===0);
   const preview=await page.locator('pre').filter({hasText:'deterministic native edit'}).first().textContent();check(j10,'the review file content is the machine-written change',preview.includes('deterministic native edit'));
   const revision=await read(`/hub/v1/projects/${fx.projectId}/revisions/${j4.receipts.revisionId}`);check(j10,'Hub stores it as a review-bundle revision',revision.purpose==='review-bundle');j10.receipts.revisionId=revision.id;
   const url=page.url();await page.reload();await page.getByText(X.reviewBundleHint,{exact:true}).waitFor({timeout:20000});check(j10,'refresh keeps the deep-linked revision',page.url()===url);
   await page.goBack();await panel(page,L.actual).waitFor({timeout:20000});check(j10,'Back returns to the run',page.url().includes(`run=${runs.patch}`));await page.goForward();await page.getByText(X.reviewBundleHint,{exact:true}).waitFor({timeout:20000});check(j10,'Forward returns to the revision',page.url()===url);
   const project=await read(`/hub/v1/projects/${fx.projectId}`);check(j10,'nothing selected the bundle for integration',project.lineRevisionId!==revision.id);fits(j10,'revision',await fit(page));await shot(j10,page,'review-bundle');
   j10.notRun.push('machine checks shown as self-reported Flow Evidence: ad-hoc runs carry RunChecks only, Flow Evidence needs journey 9','inline failure without cross-project leakage: single-project fixture');
  });
  // Journey 3, final part: typed help in a fresh session on the second machine (a refused help result wedges its session, so it runs last).
  await attempt(j3,async()=>{
   if(j3.hard)throw new JourneyFailure(j3.error);
   await navButton(page,L.sessions).click();await page.getByRole('button',{name:L.newSession,exact:true}).click();const form=panel(page,L.newSession);await form.getByLabel(L.machine,{exact:true}).selectOption(m2.machineId);await form.getByLabel(L.checkout,{exact:true}).selectOption(m2.checkoutId);await form.getByLabel(L.profile,{exact:true}).selectOption('remote-restricted');await form.getByLabel(L.title,{exact:true}).fill(`Help ${id}`);await form.getByRole('button',{name:L.createSession,exact:true}).click();
   await until(()=>page.evaluate(()=>new URLSearchParams(window.location.search).get('session')),v=>!!v&&v!==sessionId,20000,'help session');const helpSession=await page.evaluate(()=>new URLSearchParams(window.location.search).get('session'));j3.receipts.helpSessionId=helpSession;const helpPath=`/hub/v2/projects/${fx.projectId}/sessions/${helpSession}`;
   await until(()=>read(helpPath),v=>v.state==='idle',20000,'help session idle');const controller=panel(page,L.controller);await controller.getByRole('button',{name:L.claim,exact:true}).click();await controller.getByRole('button',{name:L.release,exact:true}).waitFor({timeout:20000});
   const commands=panel(page,L.commands);await commands.getByLabel(L.command,{exact:true}).selectOption('help');await commands.getByLabel(L.arguments,{exact:true}).fill('{}');await commands.getByRole('button',{name:L.invoke,exact:true}).click();
   const outcome=await until(async()=>{const text=await commands.locator('details pre').last().textContent().catch(()=>'');try{const receipt=JSON.parse(text);return receipt.operationId?await read(`${helpPath}/operations/${receipt.operationId}`):null;}catch{return null;}},v=>v!==null&&v.status!=='queued'&&v.status!=='pending',20000,'help outcome').catch(error=>({status:'unsettled',error:String(error.message).slice(0,200)}));
   j3.receipts.help={status:outcome.status,errorCode:outcome.errorCode??null};check(j3,'help applied by the machine through the shared handler',outcome.status==='applied',j3.receipts.help);
  });
  // Journey 1, final part: an offline machine is distinguished from a ready one and cannot be chosen.
  await attempt(j1,async()=>{
   if(j1.hard)throw new JourneyFailure(j1.error);
   process.kill(m2.servePid,'SIGTERM');await until(async()=>(await read(`/hub/v2/machines/${m2.machineId}`)).connected,v=>v===false,30000,'second machine offline');
   await page.goto(`${fx.origin}/?project=${fx.projectId}&view=machines`);await panel(page,'Deterministic serve machine 2').getByText(L.offline,{exact:true}).waitFor({timeout:15000});check(j1,'an offline machine is shown offline',true);
   await navButton(page,L.sessions).click();await page.getByRole('button',{name:L.newSession,exact:true}).click();const option=panel(page,L.newSession).getByLabel(L.machine,{exact:true}).locator(`option[value="${m2.machineId}"]`);check(j1,'an offline machine cannot be chosen',await option.isDisabled());await shot(j1,page,'offline');
  });
  cell.consoleErrors=errors;
 }finally{
  for(const context of contexts)await context.close();
  await fx.stop();cell.endedAt=new Date().toISOString();cell.teardown='browser contexts closed (non-persistent, no storage state written); serve children and Hub stopped; fixture root removed';
 }
 return cell;
}

const meta={startedAt:new Date().toISOString(),candidate:await candidate(),browser:null,cells:[]};
const browser=await chromium.launch({headless:true});meta.browser={engine:'chromium',version:browser.version(),playwrightModule,headless:true};
try{for(const id of cellIds){const cell=await runCell(browser,id);meta.cells.push(cell);console.log(JSON.stringify({cell:id,journeys:cell.journeys.map(j=>[j.journey,j.status,j.error??''])}));}}
finally{await browser.close();}
meta.endedAt=new Date().toISOString();meta.candidateAtEnd=await candidate();
mkdirSync(path.dirname(output),{recursive:true});const previous=existsSync(output)?JSON.parse(readFileSync(output,'utf8')):null;
writeFileSync(output,JSON.stringify({...(previous??{}),run:meta},null,1)+'\n');
console.log(JSON.stringify({wrote:path.relative(root,output),cells:meta.cells.length}));
