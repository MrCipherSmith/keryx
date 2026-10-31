import type { FrameOf } from "../../remote-control/protocol";
import { fail } from "../domain";
import type { RemoteRepository } from "./storage";
import type { MachineRecord, RunRow, SessionRow } from "./model";
export function admitHello(repo: RemoteRepository, machine: MachineRecord, hello: FrameOf<"hello">["payload"]): "replay" | "resync-required" | "ledger-mismatch" {
  if (hello.machineId !== machine.machineId) fail(403, "scope-denied", "Authenticated machine identity differs");
  if (hello.ledgerId !== machine.ledgerId) { machine.recoveryRequired = true; machine.recoveryCause = "ledger-mismatch"; return "ledger-mismatch"; }
  const runs: { runId: string; cursor: number }[] = [], sessions: { sessionId: string; cursor: number }[] = [];
  let unknown = hello.lastHubSequence > machine.hubSequence;
  if (new Set(hello.runCursors.map((c) => c.runId)).size !== hello.runCursors.length || new Set(hello.sessionCursors.map((c) => c.sessionId)).size !== hello.sessionCursors.length) fail(400, "invalid-frame", "Cursor identities must be unique");
  for (const cursor of hello.runCursors) { const run = repo.get<RunRow>("remote_run", cursor.runId); if (!run) { unknown = true; continue; } if (run.machineId !== machine.machineId || !machine.projectIds.includes(run.projectId)) fail(403, "scope-denied", "Run cursor ownership denied"); if (cursor.lastLocalSeq > run.lastLocalSeq) runs.push({ runId: run.runId, cursor: cursor.lastLocalSeq }); }
  for (const cursor of hello.sessionCursors) { const session = repo.get<SessionRow>("remote_session", cursor.sessionId); if (!session) { unknown = true; continue; } if (session.record.machineId !== machine.machineId || !machine.projectIds.includes(session.record.projectId)) fail(403, "scope-denied", "Session cursor ownership denied"); if (cursor.lastSessionEventSeq > session.record.sessionEventCursor) sessions.push({ sessionId: cursor.sessionId, cursor: cursor.lastSessionEventSeq }); }
  if (unknown) { machine.recoveryRequired = true; machine.recoveryCause = "unknown-claims"; }
  else if (runs.length || sessions.length) { machine.recoveryRequired = true; machine.recoveryCause = "cursor-replay"; machine.replayTargets = { runs, sessions }; }
  return machine.recoveryRequired ? "resync-required" : "replay";
}
export function completeCursorRecovery(repo: RemoteRepository, machine: MachineRecord): void {
  if (machine.recoveryCause !== "cursor-replay" || !machine.replayTargets) return;
  if (machine.replayTargets.runs.some((c) => (repo.get<RunRow>("remote_run", c.runId)?.lastLocalSeq ?? -1) < c.cursor) || machine.replayTargets.sessions.some((c) => (repo.get<SessionRow>("remote_session", c.sessionId)?.record.sessionEventCursor ?? -1) < c.cursor)) return;
  machine.recoveryRequired = false; delete machine.recoveryCause; delete machine.replayTargets;
}
