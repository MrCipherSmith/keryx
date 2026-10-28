import { afterEach, expect, test } from "bun:test";
import { fixture, success, type Fixture } from "./fixture.test-support";
let f: Fixture;
afterEach(async () => { if (f) await f.close(); });
const NativeWebSocket = WebSocket as unknown as { new (url: string, options: Bun.WebSocketOptions): WebSocket };

test("committed context revisions invalidate scoped browser and connected machine using actual sockets", async () => {
  f = await fixture(); const machine = await f.enroll(); const peer = await f.connect(machine);
  const browser = new NativeWebSocket(`${f.origin.replace("http", "ws")}/hub/v2/events/socket?projectId=${f.project.id}`, { headers: { Cookie: f.cookie, Origin: f.origin } });
  try {
    await new Promise<void>((resolve, reject) => { browser.addEventListener("open", () => resolve(), { once: true }); browser.addEventListener("error", () => reject(new Error("browser upgrade failed")), { once: true }); });
    const browserFrame = new Promise<Record<string, unknown>>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("No browser invalidation")), 1500); browser.addEventListener("message", (event) => { const frame = JSON.parse(String(event.data)) as Record<string, unknown>; if (frame.resource === "context") { clearTimeout(timer); resolve(frame); } }); });
    await success(await f.call(`/hub/v1/projects/${f.project.id}/import`, { method: "POST", token: "remote-test-agent-" + "a".repeat(64), body: { expectedVersion: f.project.version, sourceRevision: "new-context", documents: [{ path: "wiki/a.md", kind: "wiki", content: "Actual committed context" }] } }));
    expect(await browserFrame).toMatchObject({ v: 2, type: "resource-changed", resource: "context", projectId: f.project.id, version: 1 });
    expect((await peer.next("context-changed")).payload).toEqual({ projectId: f.project.id, contextRevision: 1 });
    const closed = new Promise<number>((resolve) => browser.addEventListener("close", (event) => resolve(event.code), { once: true }));
    browser.send(JSON.stringify({ command: "not-a-command-channel" })); expect(await closed).toBe(1008);
  } finally { browser.close(); }
});

test("invalidation cursors distinguish controller and state events sharing one session CAS version", async () => {
  const { admittedSession } = await import("./fixture.test-support"); f = await fixture(); const s = await admittedSession(f);
  const browser = new NativeWebSocket(`${f.origin.replace("http", "ws")}/hub/v2/events/socket?projectId=${f.project.id}`, { headers: { Cookie: f.cookie, Origin: f.origin } });
  try {
    await new Promise<void>((resolve, reject) => { browser.addEventListener("open", () => resolve(), { once: true }); browser.addEventListener("error", () => reject(new Error("browser upgrade failed")), { once: true }); });
    const stateFrame = new Promise<Record<string, unknown>>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Missing distinct session-event invalidation cursor")), 1500); browser.addEventListener("message", (event) => { const frame = JSON.parse(String(event.data)) as Record<string, unknown>; if (frame.resource === "session" && Number(frame.version) > 0) { clearTimeout(timer); resolve(frame); } }); });
    const receipt = await success<import("../../remote-control/protocol").Control["ControllerReceipt"]>(await f.call(`${s.path}/controller/claim`, { method: "POST", cookie: f.cookie, body: { expectedSessionVersion: 1, expectedControllerVersion: 0, requestedLeaseSeconds: 60, mode: "claim" } })); await s.peer.next("session-command");
    s.peer.send("session-event", { sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: "checkout", sessionEventSeq: 2, observedAt: new Date().toISOString(), kind: "controller-changed", receipt }); await s.peer.next("session-event-ack");
    s.peer.send("session-event", { sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: "checkout", sessionEventSeq: 3, observedAt: new Date().toISOString(), kind: "session-state", session: { ...s.session, version: receipt.sessionVersion, controller: receipt.lease, sessionEventCursor: 3 } }); await s.peer.next("session-event-ack");
    const applied=await stateFrame;expect(applied).toMatchObject({ resourceId: s.session.sessionId });expect(Number(applied.version)).toBeGreaterThan(receipt.sessionVersion);
  } finally { browser.close(); }
});

test("a current scoped reviewer receives read invalidations without gaining operator mutation authority", async () => {
  const { reviewerToken } = await import("./fixture.test-support"); f = await fixture(); const cookie = await f.login(reviewerToken);
  const browser = new NativeWebSocket(`${f.origin.replace("http", "ws")}/hub/v2/events/socket?projectId=${f.project.id}`, { headers: { Cookie: cookie, Origin: f.origin } });
  try {
    await new Promise<void>((resolve, reject) => { browser.addEventListener("open", () => resolve(), { once: true }); browser.addEventListener("error", () => reject(new Error("reviewer upgrade failed")), { once: true }); });
    const received = new Promise<Record<string, unknown>>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Reviewer invalidation denied")), 1500); browser.addEventListener("message", (event) => { clearTimeout(timer); resolve(JSON.parse(String(event.data)) as Record<string, unknown>); }, { once: true }); });
    await success(await f.call(`/hub/v1/projects/${f.project.id}/import`, { method: "POST", token: "remote-test-agent-" + "a".repeat(64), body: { expectedVersion: f.project.version, sourceRevision: "reviewer-context", documents: [{ path: "wiki/reviewer.md", kind: "wiki", content: "Authorized read context" }] } })); expect(await received).toMatchObject({ projectId: f.project.id, resource: "context" });
    expect((await f.call("/hub/v2/machines/pairings", { method: "POST", cookie, body: { displayName: "denied", projectIds: [f.project.id] } })).status).toBe(403);
  } finally { browser.close(); }
});

test("native inventory changes invalidate machine readers over the scoped browser socket",async()=>{
 const {admittedSession}=await import("./fixture.test-support");f=await fixture();const s=await admittedSession(f);
 const browser=new NativeWebSocket(`${f.origin.replace("http","ws")}/hub/v2/events/socket?projectId=${f.project.id}`,{headers:{Cookie:f.cookie,Origin:f.origin}});
 try{await new Promise<void>((resolve,reject)=>{browser.addEventListener("open",()=>resolve(),{once:true});browser.addEventListener("error",()=>reject(new Error("browser upgrade")),{once:true});});
 const changed=new Promise<Record<string,unknown>>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("No machine inventory invalidation")),500);browser.addEventListener("message",event=>{const frame=JSON.parse(String(event.data));if(frame.resource==="machine"){clearTimeout(timer);resolve(frame);}});});
 const metadata=await success<import("../../remote-control/protocol").MachineSummary>(await f.call(`/hub/v2/machines/${s.machine.machineId}`,{cookie:f.cookie}));s.peer.send("inventory",{...metadata.inventory,inventoryVersion:2});
 const firstChange=await changed;expect(firstChange).toMatchObject({resource:"machine",resourceId:s.machine.machineId,projectId:f.project.id});
 const offline=new Promise<Record<string,unknown>>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("No offline invalidation")),500);browser.addEventListener("message",event=>{const frame=JSON.parse(String(event.data));if(frame.resource==="machine"&&frame.version>Number(firstChange.version)){clearTimeout(timer);resolve(frame);}});});s.peer.socket.close();expect(await offline).toMatchObject({resourceId:s.machine.machineId});
 }finally{browser.close();}
});
