import { isOwnedControlCommand } from "../../remote-control/owned-controls";
import type { Control } from "../../remote-control/protocol";
import { fail } from "../domain";
import type { RemoteRepository } from "./storage";
import type { SessionRow } from "./model";
export function validateOwnedControl(repo: RemoteRepository, row: SessionRow, request: Control["CommandInvoke"]): void {
  if (!isOwnedControlCommand(request.commandName)) return;
  const args = request.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) fail(400, "invalid-arguments", "Typed owned-resource identity required");
  // A catalogue whose interrupt names no run binds the host's own active turn; the pinned session version keeps it the run this human saw.
  if (request.commandName === "interrupt" && !row.record.activeRunId) fail(409, "stale-reference", "Existing active run identity required");
  if ((request.commandName === "interrupt" && ("runId" in args || "turnId" in args)) || request.commandName === "questions.answer" || request.commandName === "approvals.allow-once" || request.commandName === "approvals.deny") {
    if (!row.record.activeRunId || args.runId !== row.record.activeRunId || args.turnId !== row.record.activeTurnId) fail(409, "stale-reference", "Existing active run identity required");
  }
  if (request.commandName === "approvals.allow-once" || request.commandName === "approvals.deny") {
    if (typeof args.approvalId !== "string") fail(400, "invalid-arguments", "Exact approval identity required");
    const waiter = repo.get<{ sessionId: string; runId: string; turnId: string; actionFingerprint: string; policyDigest: string; expiresAt: string; localRequired: boolean; status: string }>("remote_approval_projection", args.approvalId);
    if (!waiter || waiter.sessionId !== row.record.sessionId || waiter.runId !== args.runId || waiter.turnId !== args.turnId || waiter.actionFingerprint !== args.fingerprint || waiter.policyDigest !== args.policyDigest || waiter.localRequired || waiter.status !== "waiting" || Date.parse(waiter.expiresAt) <= Date.now()) fail(409, "approval-expired", "Exact current broker waiter required");
  }
  // Opaque local task ownership is checked against the native host's real JobRegistry before effects.
  if ((request.commandName === "tasks.kill" || request.commandName === "demote") && (typeof args.taskId !== "string" || !args.taskId)) fail(400, "invalid-arguments", "Exact local owned task identity required");
}
export function isStopOnlyCommand(request: Control["CommandInvoke"]): boolean { return request.commandName === "tasks.kill" || request.commandName === "interrupt" || request.commandName === "approvals.deny"; }
