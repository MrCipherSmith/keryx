import { catalogueDigest } from "../../remote-control/protocol";
import type { Control } from "../../remote-control/protocol";
import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHub,type HubServerConfig } from "../server";

const NativeWebSocket = WebSocket as unknown as { new (url: string, options: Bun.WebSocketOptions): WebSocket };
export const operatorToken = "remote-test-operator-" + "o".repeat(64);
export const reviewerToken = "remote-test-reviewer-" + "r".repeat(64);
export const agentToken = "remote-test-agent-" + "a".repeat(64);
export const D = "a".repeat(64);
export const HEAD = "b".repeat(40);
export const routing = { enabled: false, profileId: "default", candidateIds: ["local"], fallbackCandidateId: "local" };
export async function success<T = Record<string, unknown>>(response: Response): Promise<T> {
  const body = await response.json();
  expect({ status: response.status, body }).toMatchObject({ status: 200 });
  return body as T;
}
/** Hub's own stored rows, read-only from the data directory of a running Hub: the state its fences read, not an HTTP projection. */
function hubRows<T>(dataDir: string, read: (db: Database) => T): T {
  const db = new Database(join(dataDir, "hub.sqlite"), { readonly: true });
  try { db.exec("PRAGMA busy_timeout=5000"); return read(db); } finally { db.close(); }
}
/**
 * Hub settles an accepted session operation (a controller claim, a command invocation, a submitted message) only once the machine
 * applied it, and until then its idle fence refuses the next mutation as session-busy, even though the session events the operation
 * emitted (the new controller, the applied command outcome) are already visible. True while Hub's own session row still holds such
 * an operation; undefined when Hub has no row for the session.
 */
export function hubSessionPending(dataDir: string, sessionId: string): boolean | undefined {
  return hubRows(dataDir, (db) => {
    const row = db.query<{ body: string }, [string]>("SELECT body FROM remote_session WHERE id=?").get(sessionId);
    return row ? (JSON.parse(row.body) as { pending?: unknown }).pending !== undefined : undefined;
  });
}
/**
 * The machine's receipt Hub stored for the session command that delivered `operationId`. The machine sends it only after its own
 * ledger durably settled that command, so it is the proof that a crash from now on cannot leave the command uncertain.
 */
export function hubCommandReceipt(dataDir: string, sessionId: string, operationId: string): { status: string; errorCode: string | null } | undefined {
  return hubRows(dataDir, (db) => db.query<{ body: string }, [string]>("SELECT body FROM remote_command WHERE sessionId=?").all(sessionId)
    .map((row) => JSON.parse(row.body) as { frameType?: string; operationId?: string; receipt?: { status: string; errorCode: string | null } })
    .find((command) => command.frameType === "session-command" && command.operationId === operationId)?.receipt);
}
/** Hub's stored run row, including the fields the HTTP projection leaves out (terminalAt, notificationVersion); undefined when absent. */
export function hubRun(dataDir: string, runId: string): { state: string; terminalAt?: string; notificationVersion?: number } | undefined {
  return hubRows(dataDir, (db) => {
    const row = db.query<{ body: string }, [string]>("SELECT body FROM remote_run WHERE id=?").get(runId);
    return row ? JSON.parse(row.body) as { state: string; terminalAt?: string; notificationVersion?: number } : undefined;
  });
}
export async function fixture(overrides:Pick<HubServerConfig,'remoteBudgets'|'observeRemoteTransport'|'workManagement'>={}) {
  const dataDir = mkdtempSync(join(tmpdir(), "hub-remote-v2-"));
  const server = startHub({ dataDir, operatorToken, reviewerToken, agentToken, port: 0, host: "127.0.0.1",...overrides });
  const origin = server.url.origin;
  const sockets: WebSocket[] = [];
  const call = (path: string, options: { method?: string; body?: unknown; key?: string; token?: string; cookie?: string; origin?: string | null } = {}) => {
    const method = options.method ?? "GET";
    const headers = new Headers();
    if (options.cookie) headers.set("Cookie", options.cookie);
    if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
    if (options.origin !== null) headers.set("Origin", options.origin ?? origin);
    if (method !== "GET") headers.set("Idempotency-Key", options.key ?? randomUUID());
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    return fetch(`${origin}${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  };
  const login = async (token = operatorToken) => {
    const res = await call("/hub/v1/session", { method: "POST", body: { token } });
    await success(res);
    return res.headers.get("set-cookie")!.split(";")[0]!;
  };
  const cookie = await login();
  const project = await success<{ id: string; version: number }>(await call("/hub/v1/projects", { method: "POST", cookie, body: { name: "Remote network tests" } }));
  const enroll = async (projects = [project.id]) => {
    const pairing = await success<{ pairingId: string; code: string; expiresAt: string }>(await call("/hub/v2/machines/pairings", { method: "POST", cookie, body: { displayName: "Test machine", projectIds: projects } }));
    const machine = await success<{ machineId: string; secret: string }>(await call("/hub/v2/machines/enroll", { method: "POST", body: { code: pairing.code, agentVersion: "test-v2", ledgerId: "ledger-1" } }));
    return { ...machine, pairing };
  };
  const connect = async (machine: { machineId: string; secret: string }) => {
    // A protocol peer over a real network, not a fake native runtime or vendor trial.
    const socket = new NativeWebSocket(`${origin.replace("http", "ws")}/hub/v2/machines/socket`, { protocols: ["keryx.hub.machine.v2"], headers: { Authorization: `Bearer ${machine.secret}` } });
    sockets.push(socket);
    const pending: { predicate: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
    const frames: Record<string, unknown>[] = [];
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      const index = pending.findIndex((waiter) => waiter.predicate(frame));
      if (index >= 0) { const waiter = pending.splice(index, 1)[0]!; clearTimeout(waiter.timer); waiter.resolve(frame); }
      else frames.push(frame);
    });
    const next = (type: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const index = frames.findIndex((frame) => frame.type === type);
      if (index >= 0) { resolve(frames.splice(index, 1)[0]!); return; }
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 1500);
      pending.push({ predicate: (frame) => frame.type === type, resolve, reject, timer });
    });
    await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("Machine upgrade failed")), { once: true }); });
    let epoch = 0;
    const send = (type: string, payload: unknown) => socket.send(JSON.stringify({ v: 2, type, messageId: randomUUID(), epoch, payload }));
    send("hello", { machineId: machine.machineId, ledgerId: "ledger-1", daemonId: "daemon-1", agentVersion: "test-v2", capabilities: ["keryx-native-v1"], lastHubSequence: 0, runCursors: [], sessionCursors: [] });
    const welcome = await next("welcome"); epoch = welcome.epoch as number;
    return { socket, next, send, epoch, pendingFrames() { return [...frames]; } };
  };
  return { dataDir, server, origin, cookie, project, call, login, enroll, connect, async close() { for (const socket of sockets) socket.close(); await server.stop(true); rmSync(dataDir, { recursive: true, force: true }); } };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function admittedSession(f: Fixture, catalogue: Control["CommandCatalogueEntry"][] = []) {
  const machine = await f.enroll(); const peer = await f.connect(machine);
  await publishCapabilities(f, peer, catalogue);
  const receipt = await success<{ sessionId: string; status: string }>(await f.call(`/hub/v2/projects/${f.project.id}/sessions`, { method: "POST", cookie: f.cookie, body: { machineId: machine.machineId, checkoutId: "checkout", agentProfileId: "native", expectedInventoryVersion: 1, expectedHeadSha: HEAD, capabilityDigest: D, policyDigest: D, title: "Persistent session" } }));
  expect(receipt.status).toBe("pending");
  const command = await peer.next("session-command"); const envelope = command.payload as Record<string, unknown>;
  const session: Control["SessionRecord"] = { sessionId: receipt.sessionId, projectId: f.project.id, machineId: machine.machineId, checkoutId: "checkout", agentProfileId: "native", version: 1, historyVersion: 1, state: "idle", title: "Persistent session", config: { configVersion: 1, baselineCandidateId: "local", reasoningEffort: "none", routing, policyDigest: D, capabilityDigest: D }, controller: null, activeRunId: null, activeTurnId: null, nextTurnOrdinal: 1, historyCursor: 0, sessionEventCursor: 0, queueVersion: 0, workspaceBaseline: D, forkedFromSessionId: null, capabilities: { literalText: true, attachments: false, attachmentReason: "typed-artifact-contract-required", commandCatalogue: true, modelRouting: true } };
  peer.send("session-command-receipt", { commandId: envelope.commandId, hubSequence: envelope.hubSequence, sessionId: receipt.sessionId, observedSessionVersion: 1, status: "applied", receiptId: randomUUID(), errorCode: null });
  peer.send("session-event", { sessionId: receipt.sessionId, projectId: f.project.id, checkoutId: "checkout", sessionEventSeq: 1, observedAt: new Date().toISOString(), kind: "session-state", session });
  await peer.next("session-event-ack");
  const path = `/hub/v2/projects/${f.project.id}/sessions/${receipt.sessionId}`;
  return { machine, peer, path, session };
}

export async function appliedController(f: Fixture, s: Awaited<ReturnType<typeof admittedSession>>, key?: string) {
  const receipt = await success<Control["ControllerReceipt"]>(await f.call(`${s.path}/controller/claim`, { method: "POST", cookie: f.cookie, ...(key ? { key } : {}), body: { expectedSessionVersion: s.session.version, expectedControllerVersion: 0, requestedLeaseSeconds: 60, mode: "claim" } }));
  const frame = await s.peer.next("session-command"); const command = frame.payload as { commandId: string; hubSequence: number };
  s.peer.send("session-command-receipt", { commandId: command.commandId, hubSequence: command.hubSequence, sessionId: s.session.sessionId, observedSessionVersion: receipt.sessionVersion, status: "applied", receiptId: receipt.receiptId, errorCode: null });
  s.peer.send("session-event", { sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: "checkout", sessionEventSeq: 2, observedAt: new Date().toISOString(), kind: "controller-changed", receipt }); await s.peer.next("session-event-ack");
  s.session = { ...s.session, version: receipt.sessionVersion, controller: receipt.lease, sessionEventCursor: 3 };
  s.peer.send("session-event", { sessionId: s.session.sessionId, projectId: f.project.id, checkoutId: "checkout", sessionEventSeq: 3, observedAt: new Date().toISOString(), kind: "session-state", session: s.session }); await s.peer.next("session-event-ack");
  return receipt;
}

export async function publishCapabilities(f: Fixture, peer: Awaited<ReturnType<Fixture["connect"]>>, catalogue: Control["CommandCatalogueEntry"][] = [],projectionVersion=1,inventoryVersion=1) {
  peer.send("inventory", { inventoryVersion, checkouts: [{ projectId: f.project.id, checkoutId: "checkout", localBindingId: "binding", label: "Explicit test checkout", headSha: HEAD, clean: true, available: true, busy: false, agentProfiles: [{ profileId: "native", adapter: "keryx-native-v1", readiness: "ready", reason: "none", capabilityDigest: D, policyDigest: D }] }] });
  const page = { projectId: f.project.id, checkoutId: "checkout", agentProfileId: "native", projectionVersion, inventoryVersion, policyDigest: D, capabilityDigest: D, catalogueVersion: 1, catalogueDigest: catalogueDigest(catalogue), cursor: 0, nextCursor: null };
  peer.send("capability-page", { ...page, kind: "catalogue", totalEntries: catalogue.length, entries: catalogue });
  peer.send("capability-page", { ...page, kind: "routing", totalEntries: 2, profileIds: ["default"], entries: [
    { candidateId: "local", providerId: "deterministic", modelId: "local", reasoningEfforts: ["none", "high"], available: true, reason: "none", privacyClass: "local", costClass: "local" },
    { candidateId: "metered", providerId: "deterministic", modelId: "metered", reasoningEfforts: ["high"], available: true, reason: "none", privacyClass: "approved-egress", costClass: "metered" },
  ] });
  peer.send("heartbeat", { daemonId: "daemon-1" }); await peer.next("heartbeat-ack");
}
