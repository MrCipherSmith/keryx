import {MAX_STORED_COMMAND_BYTES} from './budgets';
import { parseMachineFrame, runCommandDigest, sessionCommandDigest, type Control, type FrameOf } from "../../remote-control/protocol";
import { fail } from "../domain";
import type { RemoteRepository } from "./storage";
import type { HumanAuthority, MachineRecord, SessionRow, StoredCommand } from "./model";
import { id, iso, saveSession, unwrap } from "./guards";
export function sessionCommand(repo: RemoteRepository, machine: MachineRecord, row: SessionRow, authority: HumanAuthority, operationId: string, kind: FrameOf<"session-command">["payload"]["kind"], body: unknown, target?: Control["CommandTarget"]): StoredCommand {
  const raw = { commandId: id(), hubSequence: ++machine.hubSequence, projectId: row.record.projectId, checkoutId: row.record.checkoutId, target: target ?? { scope: "session", sessionId: row.record.sessionId, expectedSessionVersion: kind === "create-session" ? 0 : row.record.version }, kind, authorizedBy: authority.actor.id, expiresAt: iso(Date.now() + 60000), commandDigest: "0".repeat(64), body };
  const frame = unwrap(parseMachineFrame(JSON.stringify({ v: 2, type: "session-command", messageId: id(), epoch: 1, payload: raw }), "hub-to-machine"));
  if (frame.type !== "session-command") throw new TypeError("Session command factory invariant");
  frame.payload.commandDigest = sessionCommandDigest(frame.payload);
  const command: StoredCommand = { envelope: frame.payload, frameType: "session-command", machineId: machine.machineId, projectId: row.record.projectId, operationId, authority, policyDigest: row.record.config.policyDigest, status: "pending" };
  checkCommandCapacity(repo,command);
  repo.put("remote_command", raw.commandId, command, { machineId: machine.machineId, projectId: row.record.projectId, sessionId: row.record.sessionId, seq: raw.hubSequence });
  repo.put("remote_machine", machine.machineId, machine);
  row.pending = { commandId: raw.commandId, operationId, kind, expectedAppliedVersion: row.record.version }; saveSession(repo, row); return command;
}
export function runCommand(repo: RemoteRepository, machine: MachineRecord, row: SessionRow, authority: HumanAuthority, operationId: string, runId: string, turnId: string, runVersion: number, kind: FrameOf<"command">["payload"]["kind"], body: unknown, controller: Control["ControllerBinding"]): StoredCommand {
  const raw = { commandId: id(), hubSequence: ++machine.hubSequence, sessionId: row.record.sessionId, runId, turnId, projectId: row.record.projectId, checkoutId: row.record.checkoutId, expectedSessionVersion: row.record.version, expectedRunVersion: runVersion, controller, expiresAt: iso(Date.now() + 60000), authorizedBy: authority.actor.id, kind, body, commandDigest: "0".repeat(64) };
  const frame = unwrap(parseMachineFrame(JSON.stringify({ v: 2, type: "command", messageId: id(), epoch: 1, payload: raw }), "hub-to-machine"));
  if (frame.type !== "command") throw new TypeError("Run command factory invariant");
  frame.payload.commandDigest = runCommandDigest(frame.payload);
  const command: StoredCommand = { envelope: frame.payload, frameType: "command", machineId: machine.machineId, projectId: row.record.projectId, operationId, authority, policyDigest: row.record.config.policyDigest, status: "pending" };
  checkCommandCapacity(repo,command);
  repo.put("remote_command", raw.commandId, command, { machineId: machine.machineId, projectId: row.record.projectId, sessionId: row.record.sessionId, runId, seq: raw.hubSequence }); repo.put("remote_machine", machine.machineId, machine);
  if (kind === "start-turn") { row.pending = { commandId: raw.commandId, operationId, kind, expectedAppliedVersion: row.record.version }; saveSession(repo, row); } return command;
}

function checkCommandCapacity(repo:RemoteRepository,command:StoredCommand):void {
 const envelope=command.envelope;
 command.capacity=envelope.kind==='cancel-run'?'cancel':(envelope.kind==='close-session'||((envelope.kind==='answer-approval'||envelope.kind==='confirm-command')&&envelope.body.decision==='deny'))?'denial':'ordinary';
 const bytes=Buffer.byteLength(JSON.stringify(command));
 if(bytes>MAX_STORED_COMMAND_BYTES)fail(413,'quota-exceeded','Stored command exceeds bounded critical record size');
 const usage=repo.commandUsage(command.capacity);
 if(command.capacity==='ordinary'){
  if(repo.unresolvedCommands(command.machineId)>=1000||usage.bytes+bytes>repo.budgets.pendingBytes)fail(413,'quota-exceeded','Ordinary pending command budget exhausted');
 }else if(usage.count>=repo.budgets.activeRuns||usage.bytes+bytes>repo.budgets.activeRuns*MAX_STORED_COMMAND_BYTES)fail(413,'quota-exceeded','Reserved control delivery capacity exhausted');
 if(command.capacity==='cancel'&&'runId' in envelope&&repo.pendingCancel(envelope.runId))fail(409,'session-busy','An unexpired cancellation is already pending for this run');
}
