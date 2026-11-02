// The one guarded "propose from a session" use case. `keryx workspace propose`,
// the agent-native `workspace_propose` tool and MCP `sac.propose` all build the
// same proposal; before this each carried its own copy, and the MCP copy
// dropped the note guard (secret/PII/injection scan) the other two applied, so a
// note that the CLI refused was persisted verbatim through MCP. Surfaces keep
// their own argument parsing and error wording; they only share this body.
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { guardOutput, prepareOutputForPersistence } from "../security/guard";
import { findSession } from "../session/store";
import { createHarnessProposalLifecycleService, normalizeProposalLifecycleResult } from "./proposal-lifecycle";
import { proposalNotePath } from "./proposal-evidence";
import { sessionEvidenceRef } from "./session-wrap-up";

export type ProposeFromSessionResult =
  | { ok: true; result: ReturnType<typeof normalizeProposalLifecycleResult> }
  | { ok: false; reason: "session-not-found" | "note-refused" | "no-actor"; message: string };

export async function proposeFromSession(input: {
  cwd: string;
  workspaceId: string;
  kind: string;
  sessionRef: string;
  note?: string | undefined;
  proposalRevision?: string | undefined;
}): Promise<ProposeFromSessionResult> {
  const { cwd, workspaceId, kind, sessionRef } = input;
  // Resolve the human-friendly id/prefix to a canonical session id ONLY to
  // build a schema-valid `sourceRef` path — resolveSessionWrapUp (inside
  // wrapUpAuthority.issue below) independently re-looks this session up itself
  // and never trusts this resolution as evidence.
  const session = findSession(cwd, sessionRef);
  if (!session) return { ok: false, reason: "session-not-found", message: `no session matching "${sessionRef}" in this project` };
  const proposalId = `proposal-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const notePath = proposalNotePath(cwd, workspaceId, proposalId);
  const materializedNote = input.note === undefined
    ? undefined
    : prepareOutputForPersistence(
        await guardOutput({ cwd, content: input.note, target: "task", source: "generated", path: notePath }),
        input.note,
      );
  if (materializedNote !== undefined && !materializedNote.allowed) {
    return { ok: false, reason: "note-refused", message: materializedNote.reason };
  }
  const persistedNote = materializedNote?.allowed ? materializedNote.content : undefined;
  const { service, wrapUpAuthority, authorizationServer } = createHarnessProposalLifecycleService(cwd, { workspaceId, ...(persistedNote ? { note: persistedNote } : {}) });
  const requestCorrelationId = randomUUID();
  const actor = await authorizationServer.actorContextFor(undefined, requestCorrelationId);
  if (!actor) return { ok: false, reason: "no-actor", message: "trusted ActorContext is required" };
  const wrapUp = await wrapUpAuthority.issue({ actor, source: "session", sourceRef: sessionEvidenceRef(workspaceId, session.id) });
  const proposal = await service.create({
    request: undefined,
    requestCorrelationId,
    workspaceId,
    id: proposalId,
    proposalRevision: input.proposalRevision ?? "1",
    kind: kind as never,
    wrapUp,
  });
  // The note is not part of the frozen proposal schema — it lives in a sidecar
  // the memory/wiki/skill owner-writers read back at accept time, since accept
  // may happen in a different process/reviewer session.
  if (persistedNote) await writeFile(notePath, persistedNote, "utf8");
  return { ok: true, result: normalizeProposalLifecycleResult(proposal) };
}
