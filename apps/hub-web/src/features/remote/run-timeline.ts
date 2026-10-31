import type { FrameOf } from '../../../../../src/remote-control/protocol';
export type RunEvent=FrameOf<'run-event'>['payload'];
export type RunEventPage={events:RunEvent[];cursor:number;gap:null|{fromSeq:number;toSeq:number}};
export interface Timeline { events:RunEvent[];cursor:number;gap:boolean;overflow:boolean;conflict:boolean }
export const TIMELINE_BYTES=256*1024;
export const emptyTimeline=():Timeline=>({events:[],cursor:0,gap:false,overflow:false,conflict:false});
const size=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
/** A bounded display projection. Authoritative approval/result cards also come from RunRecord. */
export function appendRunPage(previous:Timeline,page:RunEventPage):Timeline {
 const events=[...previous.events];let conflict=previous.conflict;let gap=previous.gap||!!page.gap;
 for(const event of page.events){const old=events.find(e=>e.localSeq===event.localSeq);if(old){if(JSON.stringify(old)!==JSON.stringify(event))conflict=true;continue;}if(event.localSeq<=previous.cursor)continue;events.push(event);}
 events.sort((a,b)=>a.localSeq-b.localSeq);let overflow=previous.overflow;
 while(size(events)>TIMELINE_BYTES){const log=events.findIndex(e=>e.kind==='log'||e.kind==='log-gap');if(log>=0){events.splice(log,1);gap=true;continue;}
 // Coalesce superseded state transitions; never discard a pending approval silently.
 const state=events.findIndex((e,i)=>e.kind==='state'&&events.slice(i+1).some(later=>later.kind==='state'));if(state>=0){events.splice(state,1);gap=true;continue;}overflow=true;break;}
 if(overflow){while(size(events)>TIMELINE_BYTES&&events.length)events.shift();gap=true;}
 return{events,cursor:conflict?previous.cursor:Math.max(previous.cursor,page.cursor),gap,overflow,conflict};
}
