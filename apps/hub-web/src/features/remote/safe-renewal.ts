import type { Control } from '../../api/remote';
type Session=Control['SessionRecord'];
export interface RenewalEdge { from:number;to:number;fromCursor:number;toCursor:number;meaningful:string;leaseId:string;controllerVersion:number;receiptId:string }
function sorted(value:unknown):unknown{return Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,sorted(v)])):value;}
const same=(a:unknown,b:unknown)=>JSON.stringify(sorted(a))===JSON.stringify(sorted(b));
/** Cursor changes are proved separately by the exact two native renewal events. */
function snapshot(record:Session){const{version:_version,sessionEventCursor:_cursor,controller,...rest}=record;void _version;void _cursor;const lease=controller?{controllerLeaseId:controller.controllerLeaseId,sessionId:controller.sessionId,version:controller.version,actorId:controller.actorId,actorKind:controller.actorKind,state:controller.state}:null;return JSON.stringify(sorted({...rest,controller:lease}));}
export function renewalEdge(before:Session,receipt:Control['ControllerReceipt'],page:Control['SessionEventPage']):RenewalEdge|null {
 const old=before.controller;const next=receipt.lease;const oldExpiry=Date.parse(old?.expiresAt??'');const expiry=Date.parse(next.expiresAt);
 if(!old||old.state!=='held'||next.state!=='held'||receipt.sessionVersion!==before.version+1||next.controllerLeaseId!==old.controllerLeaseId||next.version!==old.version||next.actorId!==old.actorId||next.actorKind!==old.actorKind||next.sessionId!==before.sessionId||!Number.isFinite(expiry)||!Number.isFinite(oldExpiry)||expiry<oldExpiry||page.gap)return null;
 const changed=page.events[0];const applied=page.events[1];const fromCursor=before.sessionEventCursor;
 if(!changed||!applied||changed.sessionEventSeq!==fromCursor+1||applied.sessionEventSeq!==fromCursor+2||changed.kind!=='controller-changed'||applied.kind!=='session-state'||!same(changed.receipt,receipt))return null;
 if([changed,applied].some(e=>e.sessionId!==before.sessionId||e.projectId!==before.projectId||e.checkoutId!==before.checkoutId)||applied.session.version!==receipt.sessionVersion||!same(applied.session.controller,next)||snapshot(applied.session)!==snapshot(before))return null;
 return{from:before.version,to:receipt.sessionVersion,fromCursor,toCursor:applied.sessionEventSeq,meaningful:snapshot(before),leaseId:old.controllerLeaseId,controllerVersion:old.version,receiptId:receipt.receiptId};
}
export function advanceKnownRenewals(base:number,current:Session,edges:readonly RenewalEdge[]):number {
 if(base===current.version)return base;const meaningful=snapshot(current);let version=base;let cursor:number|undefined;
 for(let i=0;i<edges.length&&version<current.version;i++){const edge=edges.find(e=>e.from===version);if(!edge||edge.to!==version+1||edge.meaningful!==meaningful||current.controller?.controllerLeaseId!==edge.leaseId||current.controller.version!==edge.controllerVersion||cursor!==undefined&&edge.fromCursor!==cursor)return base;version=edge.to;cursor=edge.toCursor;}
 return version===current.version&&cursor===current.sessionEventCursor?version:base;
}
