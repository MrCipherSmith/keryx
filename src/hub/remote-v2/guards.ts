import { randomUUID } from "node:crypto";
import { canonicalDigest, validateControl, type Control, type ProtocolResult } from "../../remote-control/protocol";
import { fail } from "../domain";
import type { HubState } from "../store";
import type { RemoteRepository } from "./storage";
import type { HumanAuthority, MachineRecord, SessionRow } from "./model";
export const iso = (now = Date.now()) => new Date(now).toISOString();
export const id = () => randomUUID();
export function unwrap<T>(result: ProtocolResult<T>): T { if (!result.ok) fail(result.error.code === "quota-exceeded" ? 413 : 400, result.error.code, result.error.message); return result.value; }
export function control<K extends keyof Control>(name: K, value: unknown): Control[K] { return unwrap(validateControl(name, value)); }
export function machine(repo: RemoteRepository, machineId: string): MachineRecord { const row = repo.get<MachineRecord>("remote_machine", machineId); if (!row || row.revoked) fail(401, "unauthorized", "Machine credentials unavailable"); return row; }
export function scoped(actor: HumanAuthority, projectId: string, state: HubState): void { if (!state.projects.some((p) => p.id === projectId) || (actor.actor.projectIds && !actor.actor.projectIds.includes(projectId))) fail(404, "not-found", "Resource not found"); }
export function operator(auth: HumanAuthority): void { if (auth.actor.kind !== "human" || auth.actor.role !== "operator") fail(403, "human-operator-required", "Current human operator session required"); }
export function session(repo: RemoteRepository, projectId: string, sessionId: string): SessionRow { const row = repo.get<SessionRow>("remote_session", sessionId); if (!row || row.record.projectId !== projectId) fail(404, "not-found", "Session not found"); return row; }
export function version(actual: number, expected: number): void { if (actual !== expected) fail(409, "stale-version", "Version changed; refresh before applying"); }
export function held(row: SessionRow, auth: HumanAuthority, binding: Control["ControllerBinding"], now = Date.now()): void {
  const lease = row.record.controller;
  if (!lease || lease.state !== "held" || lease.controllerLeaseId !== binding.controllerLeaseId || lease.actorId !== auth.actor.id || lease.version !== binding.expectedControllerVersion) fail(409, "controller-conflict", "Current controller ownership required");
  if (Date.parse(lease.expiresAt) <= now) fail(409, "controller-expired", "Controller lease expired");
}
export function saveSession(repo: RemoteRepository, row: SessionRow): void { row.notificationVersion=(row.notificationVersion??0)+1; repo.put("remote_session", row.record.sessionId, row, { projectId: row.record.projectId, machineId: row.record.machineId, sessionId: row.record.sessionId }); }
export function projectionKey(machineId: string, projectId: string, checkoutId: string, profileId: string) { return canonicalDigest([machineId, projectId, checkoutId, profileId]); }

export function idleFence(row: SessionRow): void { if (row.pending) fail(409, "session-busy", "An accepted operation is waiting for machine application"); }
