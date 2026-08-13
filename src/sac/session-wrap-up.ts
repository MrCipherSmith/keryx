// Real "session" TrustedWrapUpResolution producer (harness/session composition —
// see proposal-lifecycle.ts createLocalProposalLifecycleService: "Local adapters
// deliberately do not receive this authority... trusted Harness/session composition
// injects it"). This is that composition's session half.
//
// A wrap-up must point at real, verifiable evidence a reviewer can independently
// check — never the agent's own summary of what it did. So this does not read the
// session's title or message count and hand them back as "evidence"; it EXPORTS the
// session's real archive (src/session/store.ts exportSessionMarkdown — every role,
// every message, verbatim) into a file INSIDE the target workspace, hashes that
// export, and returns a pointer to it. `resolveWorkspaceReference` (src/sac/index.ts)
// then enforces the same workspace-containment check on this evidence as on any
// other — the export exists precisely so a session (which lives outside the
// workspace root, under the shared keryx data dir) has a workspace-relative
// reference to point at.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { findSession, exportSessionMarkdown, TranscriptUnreadableError } from "../session/store";
import type { TrustedWrapUpResolution } from "./trusted-wrap-up";

/** How long a resolved wrap-up may sit unconsumed before `verify()` expires it. */
const WRAP_UP_TTL_MS = 60 * 60 * 1000;

export class SessionWrapUpError extends Error {
  constructor(
    readonly code: "session_not_found" | "session_too_short" | "session_unreadable",
    message: string,
  ) {
    super(message);
  }
}

/**
 * The workspace-relative evidence path a session wrap-up for `sessionId` under
 * `workspaceId` writes to (and `TrustedWrapUpProvenance.sourceRef` must equal —
 * the SAC contract schema requires `wrapUp.sourceRef` to be a workspace-relative
 * `path`, not a bare session id, so the id travels encoded in this path's last
 * segment instead of as a separate free-form string). Pure — no I/O.
 */
export function sessionEvidenceRef(workspaceId: string, sessionId: string): string {
  return `./.metaproject/workspaces/${workspaceId}/session-evidence/${sessionId}.md`;
}

/**
 * Resolve a real, completed keryx shell session into a `TrustedWrapUpResolution`
 * for `workspaceId`. `sourceRef` must be a `sessionEvidenceRef(workspaceId, id)`
 * path — the caller builds it via that function after resolving a human-friendly
 * `keryx sessions`-style id/prefix to a canonical session id; this resolver then
 * independently re-looks-up that exact session (never trusting the caller's
 * resolution) before treating anything as evidence. Requires at least one real
 * exchange (a lone freshly-created session with no messages cannot wrap up
 * anything) — a legitimacy floor, not a content filter.
 */
export async function resolveSessionWrapUp(input: {
  cwd: string;
  workspaceId: string;
  sourceRef: string;
  now?: () => Date;
}): Promise<TrustedWrapUpResolution> {
  const now = input.now ?? (() => new Date());
  const sessionId = path.posix.basename(input.sourceRef, ".md");
  const summary = findSession(input.cwd, sessionId);
  if (summary === undefined || input.sourceRef !== sessionEvidenceRef(input.workspaceId, summary.id)) {
    throw new SessionWrapUpError(
      "session_not_found",
      `no session matching "${input.sourceRef}" in this project — use \`keryx sessions list\``,
    );
  }
  if (summary.archiveMessageCount < 2) {
    throw new SessionWrapUpError(
      "session_too_short",
      `session "${summary.id}" has ${summary.archiveMessageCount} archived message(s) — nothing to wrap up yet`,
    );
  }

  // Guarded: `exportSessionMarkdown` throws `TranscriptUnreadableError` on an
  // oversized or non-regular transcript rather than reading it back empty
  // (flow 130); a wrap-up caller cares that evidence is trustworthy, not that
  // the process kept running, so this surfaces as a typed refusal instead of
  // an uncaught crash.
  let markdown: string;
  try {
    markdown = exportSessionMarkdown(input.cwd, summary.id);
  } catch (cause) {
    if (!(cause instanceof TranscriptUnreadableError)) throw cause;
    throw new SessionWrapUpError("session_unreadable", `session "${summary.id}" could not be read: ${cause.message}`);
  }
  const relPath = sessionEvidenceRef(input.workspaceId, summary.id).slice(2); // drop leading "./"
  await mkdir(path.join(input.cwd, path.dirname(relPath)), { recursive: true });
  await writeFile(path.join(input.cwd, relPath), markdown, "utf8");

  const observedAt = now().toISOString();
  return {
    workspaceId: input.workspaceId,
    sourceRevision: summary.updatedAt,
    summary: `Session "${summary.title}" (${summary.archiveMessageCount} messages${
      summary.model ? `, ${summary.provider ?? "?"}/${summary.model}` : ""
    })`,
    evidence: [
      {
        kind: "session",
        uri: `./${relPath}`,
        revision: createHash("sha256").update(markdown).digest("hex"),
        observedAt,
      },
    ],
    expiresAt: new Date(now().getTime() + WRAP_UP_TTL_MS).toISOString(),
  };
}
