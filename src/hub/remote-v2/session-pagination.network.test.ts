import { afterEach, expect, test } from "bun:test";
import { fixture, admittedSession, type Fixture } from "./fixture.test-support";
import type { Control } from "../../remote-control/protocol";
let f:Fixture; afterEach(async()=>{if(f)await f.close();});
test("large native history and critical session events page within byte limits without losing cursors",async()=>{
  f=await fixture(); const s=await admittedSession(f);
  for(let i=1;i<=60;i++) {s.peer.send("session-event",{sessionId:s.session.sessionId,projectId:f.project.id,checkoutId:"checkout",sessionEventSeq:i+1,observedAt:new Date().toISOString(),kind:"message",message:{messageId:`history-${i}`,sessionId:s.session.sessionId,historyCursor:i,role:"assistant",text:"x".repeat(12000),createdAt:new Date().toISOString(),runId:null,turnId:null}}); await s.peer.next("session-event-ack");}
  for(const kind of ["history","events"] as const) {
    let cursor=0,count=0;
    for(let pageIndex=0;pageIndex<5;pageIndex++) {
      const response=await f.call(`${s.path}/${kind}?after=${cursor}`,{cookie:f.cookie}); const raw=await response.text(); expect(response.status).toBe(200); expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(512*1024);
      const page=JSON.parse(raw) as Control["HistoryPage"]&Control["SessionEventPage"]; const rows=kind==="history"?page.messages:page.events;
      expect(page.cursor).toBeGreaterThan(cursor); cursor=page.cursor; count+=rows.length;
      if(!page.hasMore)break;
    }
    expect(count).toBe(kind==="history"?60:61); expect(cursor).toBe(kind==="history"?60:61);
  }
});
