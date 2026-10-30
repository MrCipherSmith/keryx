import {createServer,createConnection,type Socket} from 'node:net';
import {chmodSync,existsSync,lstatSync,unlinkSync,linkSync} from 'node:fs';
import path from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {randomBytes} from 'node:crypto';
import {parseClosedJson,validateControl,type Control,type ProtocolResult} from '../../remote-control/protocol';
import {ensurePrivateDirectory} from './secure-state';
import {MachineError,machineFailure} from './errors';

/** Local owner RPC v1. This contract is never accepted on Hub/serve HTTP or machine WebSockets. */
export interface LocalRecoveryTarget {sessionId:string;nativeSessionId:string;controllerLeaseId:string;controllerVersion:number;expectedSessionVersion:number;expectedHistoryVersion:number;expectedWorkspaceBaseline:string}
interface OwnerRequestBase {v:1;requestId:string;hubId:string}
/** Crash-uncertain run recovery pins: step 1 names the run; step 2 also names the exact local confirmed-stopped receipt a human resolved in Hub. */
export interface LocalRunRecoveryTarget {runId:string}
export interface LocalResolvedRunTarget {runId:string;reconciliationId:string}
/** A session command a crashed daemon left unresolved in the ledger, named by its exact Hub command id. */
export interface LocalCrashedCommandTarget {commandId:string}
export type LocalOwnerRequest=OwnerRequestBase&({operation:'inspect';sessionId?:string}|{operation:'release-expired-idle';target:LocalRecoveryTarget}|{operation:'confirm-run-absence';target:LocalRunRecoveryTarget}|{operation:'release-resolved-run';target:LocalResolvedRunTarget}|{operation:'settle-crashed-command';target:LocalCrashedCommandTarget});
/**
 * What a settled crashed command is known to have done: `applied` when this ledger recorded its effect and Hub ingested that record,
 * `not-applied` when it never started or the host recorded refusing it, `unknown` when neither can be established.
 */
export type CrashedCommandOutcome='applied'|'not-applied'|'unknown';
export type LocalOwnerValue=
 |{kind:'inspection';hubId:string;machineId:string;ledgerId:string;daemonId:string;sessions:Array<{session:Control['SessionRecord'];nativeSessionId:string;checkoutOwned:boolean}>;unresolved:Array<{commandId:string;runId:string|null;checkoutId:string;phase:'received'|'unknown'}>;recoveryClaims:Array<{requestId:string;sessionId:string;state:'unknown'|'complete'}>;uncertainRuns:Array<{runId:string;daemonId:string}>;truncated:boolean}
 |{kind:'released-expired-idle';stopped:true;session:Control['SessionRecord'];controller:Control['ControllerReceipt']}
 |{kind:'run-absence-confirmed';runId:string;sessionId:string;reconciliationId:string;expectedRunVersion:number;receivedAt:string}
 |{kind:'released-resolved-run';runId:string;sessionId:string;reconciliationId:string;capacityReleased:boolean;checkoutLeaseReleased:boolean}
 /** `receipt`: the final machine receipt sent to Hub for the command. `resubmit`: whether the human has to send the command again. */
 |{kind:'settled-crashed-command';commandId:string;sessionId:string;command:string;outcome:CrashedCommandOutcome;receipt:{status:'applied'|'admitted'|'not-applied'|'rejected';errorCode:'recovery-required'|null};resubmit:'no'|'yes'|'if-absent'};
export type LocalOwnerResult=ProtocolResult<LocalOwnerValue>;
/** A local recovery may wait out a full owned-process stop (TERM, then KILL after five seconds) plus its bounded finalizers. */
const REQUEST_BYTES=16384,REPLY_BYTES=65536,DEADLINE_MS=15000;
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const obj=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:Record<string,unknown>,names:string[])=>Object.keys(value).sort().join(',')===[...names].sort().join(',');
const version=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=1;
const error=(code:string):{ok:false;error:{code:string;message:string}}=>({ok:false,error:{code,message:code}});
export function parseLocalOwnerRequest(value:unknown):ProtocolResult<LocalOwnerRequest>{
 if(!obj(value)||value.v!==1||!id(value.requestId)||!digest(value.hubId))return error('invalid-local-request');
 if(value.operation==='inspect'&&exact(value,['v','requestId','hubId','operation',...('sessionId'in value?['sessionId']:[])])&&(!('sessionId'in value)||id(value.sessionId)))return{ok:true,value:{v:1,requestId:value.requestId,hubId:value.hubId,operation:'inspect',...(id(value.sessionId)?{sessionId:value.sessionId}:{})}};
 const target=value.target;
 if(value.operation==='settle-crashed-command'){
  if(!exact(value,['v','requestId','hubId','operation','target'])||!obj(target)||!exact(target,['commandId'])||!id(target.commandId))return error('invalid-local-request');
  return{ok:true,value:{v:1,requestId:value.requestId,hubId:value.hubId,operation:'settle-crashed-command',target:{commandId:target.commandId}}};
 }
 if(value.operation==='confirm-run-absence'||value.operation==='release-resolved-run'){
  const pins=value.operation==='confirm-run-absence'?['runId']:['runId','reconciliationId'];
  if(!exact(value,['v','requestId','hubId','operation','target'])||!obj(target)||!exact(target,pins)||!id(target.runId)||(value.operation==='release-resolved-run'&&!id(target.reconciliationId)))return error('invalid-local-request');
  return value.operation==='confirm-run-absence'?{ok:true,value:{v:1,requestId:value.requestId,hubId:value.hubId,operation:'confirm-run-absence',target:{runId:target.runId}}}:{ok:true,value:{v:1,requestId:value.requestId,hubId:value.hubId,operation:'release-resolved-run',target:{runId:target.runId,reconciliationId:String(target.reconciliationId)}}};
 }
 if(value.operation!=='release-expired-idle'||!exact(value,['v','requestId','hubId','operation','target'])||!obj(target)||!exact(target,['sessionId','nativeSessionId','controllerLeaseId','controllerVersion','expectedSessionVersion','expectedHistoryVersion','expectedWorkspaceBaseline'])||!id(target.sessionId)||!id(target.nativeSessionId)||!id(target.controllerLeaseId)||!version(target.controllerVersion)||!version(target.expectedSessionVersion)||!version(target.expectedHistoryVersion)||!digest(target.expectedWorkspaceBaseline))return error('invalid-local-request');
 return{ok:true,value:{v:1,requestId:value.requestId,hubId:value.hubId,operation:'release-expired-idle',target:{sessionId:target.sessionId,nativeSessionId:target.nativeSessionId,controllerLeaseId:target.controllerLeaseId,controllerVersion:target.controllerVersion,expectedSessionVersion:target.expectedSessionVersion,expectedHistoryVersion:target.expectedHistoryVersion,expectedWorkspaceBaseline:target.expectedWorkspaceBaseline}}};
}
function validValue(value:unknown):value is LocalOwnerValue{
 if(!obj(value))return false;
 if(value.kind==='released-expired-idle')return exact(value,['kind','stopped','session','controller'])&&value.stopped===true&&validateControl('SessionRecord',value.session).ok&&validateControl('ControllerReceipt',value.controller).ok;
 if(value.kind==='run-absence-confirmed')return exact(value,['kind','runId','sessionId','reconciliationId','expectedRunVersion','receivedAt'])&&id(value.runId)&&id(value.sessionId)&&id(value.reconciliationId)&&typeof value.expectedRunVersion==='number'&&Number.isSafeInteger(value.expectedRunVersion)&&value.expectedRunVersion>=0&&typeof value.receivedAt==='string'&&Number.isFinite(Date.parse(value.receivedAt));
 if(value.kind==='released-resolved-run')return exact(value,['kind','runId','sessionId','reconciliationId','capacityReleased','checkoutLeaseReleased'])&&id(value.runId)&&id(value.sessionId)&&id(value.reconciliationId)&&typeof value.capacityReleased==='boolean'&&typeof value.checkoutLeaseReleased==='boolean';
 if(value.kind==='settled-crashed-command'){
  const receipt=value.receipt;
  return exact(value,['kind','commandId','sessionId','command','outcome','receipt','resubmit'])&&id(value.commandId)&&id(value.sessionId)&&typeof value.command==='string'&&/^[a-z][a-z-]{0,63}$/.test(value.command)&&['applied','not-applied','unknown'].includes(String(value.outcome))
   &&obj(receipt)&&exact(receipt,['status','errorCode'])&&['applied','admitted','not-applied','rejected'].includes(String(receipt.status))&&(receipt.errorCode===null||receipt.errorCode==='recovery-required')&&['no','yes','if-absent'].includes(String(value.resubmit));
 }
 return value.kind==='inspection'&&exact(value,['kind','hubId','machineId','ledgerId','daemonId','sessions','unresolved','recoveryClaims','uncertainRuns','truncated'])&&Array.isArray(value.uncertainRuns)&&value.uncertainRuns.length<=1000&&value.uncertainRuns.every(item=>obj(item)&&exact(item,['runId','daemonId'])&&id(item.runId)&&id(item.daemonId))&&digest(value.hubId)&&id(value.machineId)&&id(value.ledgerId)&&id(value.daemonId)&&typeof value.truncated==='boolean'&&Array.isArray(value.sessions)&&value.sessions.length<=100&&value.sessions.every(item=>obj(item)&&exact(item,['session','nativeSessionId','checkoutOwned'])&&validateControl('SessionRecord',item.session).ok&&id(item.nativeSessionId)&&typeof item.checkoutOwned==='boolean')&&Array.isArray(value.recoveryClaims)&&value.recoveryClaims.length<=1000&&value.recoveryClaims.every(item=>obj(item)&&exact(item,['requestId','sessionId','state'])&&id(item.requestId)&&id(item.sessionId)&&['unknown','complete'].includes(String(item.state)))&&Array.isArray(value.unresolved)&&value.unresolved.length<=1000&&value.unresolved.every(item=>obj(item)&&exact(item,['commandId','runId','checkoutId','phase'])&&id(item.commandId)&&(item.runId===null||id(item.runId))&&id(item.checkoutId)&&['received','unknown'].includes(String(item.phase)));
}
export function validLocalOwnerResult(value:unknown):value is LocalOwnerResult{
 if(!obj(value))return false;
 if(value.ok===true)return exact(value,['ok','value'])&&validValue(value.value);
 return value.ok===false&&exact(value,['ok','error'])&&obj(value.error)&&exact(value.error,['code','message'])&&typeof value.error.code==='string'&&/^[a-z][a-z0-9-]{0,99}$/.test(value.error.code)&&value.error.message===value.error.code;
}
export function localControlPath(configDir:string):string{return path.join(configDir,'owner-control.sock');}
function socketIdentity(file:string){const st=lstatSync(file);if(!st.isSocket()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077)!==0)throw new MachineError('unsafe-local-control');return{dev:st.dev,ino:st.ino};}
function same(file:string,identity:{dev:number;ino:number}):boolean{try{const current=socketIdentity(file);return current.dev===identity.dev&&current.ino===identity.ino;}catch{return false;}}
function checkedParent(configDir:string):string{if(!path.isAbsolute(configDir)||path.normalize(configDir)!==configDir)throw new MachineError('unsafe-config-path');ensurePrivateDirectory(configDir);const file=localControlPath(configDir);if(Buffer.byteLength(file)>103)throw new MachineError('local-control-path-too-long');return file;}
export async function startLocalOwnerControl(options:{configDir:string;handle:(request:LocalOwnerRequest)=>Promise<LocalOwnerResult>}):Promise<{stop():Promise<void>}>{
 const file=checkedParent(options.configDir);if(existsSync(file))throw new MachineError('local-control-busy');const sockets=new Set<Socket>();
 const server=createServer(socket=>{sockets.add(socket);socket.on('error',()=>socket.destroy());socket.once('close',()=>sockets.delete(socket));socket.setTimeout(DEADLINE_MS,()=>socket.destroy());let bytes=0,body='',settled=false;const decoder=new StringDecoder('utf8');
  const reply=(requestId:string,result:LocalOwnerResult)=>{let response=JSON.stringify({v:1,requestId,result:validLocalOwnerResult(result)?result:error('invalid-local-response')});if(Buffer.byteLength(response)>REPLY_BYTES)response=JSON.stringify({v:1,requestId,result:error('quota-exceeded')});socket.end(response+'\n');};
  socket.on('data',chunk=>{if(settled)return;bytes+=chunk.length;if(bytes>REQUEST_BYTES){settled=true;reply('invalid',error('quota-exceeded'));return;}body+=decoder.write(chunk);if(!body.includes('\n'))return;settled=true;socket.pause();const [line,...extra]=body.split('\n');const parsed=parseClosedJson(line??'',REQUEST_BYTES);if(extra.join('').trim()||!parsed.ok){reply('invalid',error('invalid-local-request'));return;}const request=parseLocalOwnerRequest(parsed.value);if(!request.ok){reply('invalid',request);return;}void Promise.resolve().then(()=>options.handle(request.value)).then(result=>reply(request.value.requestId,result),cause=>reply(request.value.requestId,error(machineFailure(cause,'local-control-failed').code)));});
 });
 // Bun remembers and automatically unlinks its original listen pathname. Publish the
 // socket through an atomic no-replace hard link, then remove that private staging name.
 // Closing the listener cannot unlink the published endpoint, even after substitution.
 const staging=path.join(options.configDir,'.o-'+randomBytes(8).toString('base64url'));
 try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(staging,()=>{server.off('error',reject);resolve();});});chmodSync(staging,0o600);linkSync(staging,file);unlinkSync(staging);}catch(cause){await new Promise<void>(resolve=>server.close(()=>resolve()));throw new MachineError('local-control-busy',{cause});}
 const identity=socketIdentity(file);let stopped=false;
 return{async stop(){if(stopped)return;stopped=true;for(const socket of sockets)socket.destroy();await new Promise<void>((resolve,reject)=>server.close(cause=>cause?reject(cause):resolve()));if(!same(file,identity))throw new MachineError('local-control-owner-mismatch');unlinkSync(file);}};
}
export async function requestLocalOwnerControl(configDir:string,input:unknown):Promise<LocalOwnerResult>{
 const checked=parseLocalOwnerRequest(input);if(!checked.ok)return checked;
 try{const file=checkedParent(configDir),identity=socketIdentity(file);return await new Promise<LocalOwnerResult>(resolve=>{let settled=false,body='',bytes=0;const decoder=new StringDecoder('utf8');const socket=createConnection(file);const finish=(result:LocalOwnerResult)=>{if(settled)return;settled=true;socket.destroy();resolve(result);};socket.setTimeout(DEADLINE_MS,()=>finish(error('local-control-timeout')));socket.once('error',()=>finish(error('local-control-unavailable')));socket.once('connect',()=>{if(!same(file,identity)){finish(error('local-control-owner-mismatch'));return;}socket.write(JSON.stringify(checked.value)+'\n');});socket.on('data',chunk=>{bytes+=chunk.length;if(bytes>REPLY_BYTES){finish(error('quota-exceeded'));return;}body+=decoder.write(chunk);if(!body.includes('\n'))return;const parsed=parseClosedJson(body.trim(),REPLY_BYTES);if(!parsed.ok||!obj(parsed.value)||!exact(parsed.value,['v','requestId','result'])||parsed.value.v!==1||parsed.value.requestId!==checked.value.requestId||!validLocalOwnerResult(parsed.value.result)){finish(error('invalid-local-response'));return;}finish(parsed.value.result);});socket.once('end',()=>{if(!settled)finish(error('local-control-unavailable'));});});}catch(cause){return error(machineFailure(cause,'local-control-unavailable').code);}
}
