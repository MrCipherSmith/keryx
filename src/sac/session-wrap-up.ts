// Real "session" TrustedWrapUpResolution producer (harness/session composition —
// see proposal-lifecycle.ts createLocalProposalLifecycleService: "Local adapters
// deliberately do not receive this authority... trusted Harness/session composition
// injects it"). This is that composition's session half.
//
// A wrap-up must point at real, verifiable evidence a reviewer can independently
// check — never the agent's own summary of what it did.
//
// SLATE-21: the PRIMARY evidence (evidence[0], the item `readVerifiedProposalEvidence`
// hands every owner writer — memory/wiki/skill) is now the SAME compact, structured
// shape `machine-wrap-up.ts`'s `resolveMachineWrapUp` already produces for the
// "flow"-triggered wrap-up source: a Course/flow status line, this session's Seeds,
// and a working-tree diff stat, built from `gitDiff`/`courseStatusLine`/
// `dedupedAttributedSeeds` (all exported from `./machine-wrap-up` for reuse) — never
// the agent's own free-text account of what it did. The full raw diff and the
// session's real archive export (src/session/store.ts's exportSessionMarkdown —
// every role, every message, verbatim) are STILL produced and STILL hash-verified,
// but now as secondary/reference evidence items (evidence[1]/evidence[2]), not the
// sole or primary evidence a reviewer has to read to review this proposal — matching
// the design intent this module's own SLATE-7 comment originally deferred ("Seeds +
// diff + flow as the primary candidate, transcript as a linked attachment").
// `resolveWorkspaceReference` (src/sac/index.ts) enforces the same workspace-
// containment check on every evidence item here as on any other — every file below
// is written inside the target workspace tree precisely so a session (which lives
// outside the workspace root, under the shared keryx data dir) has workspace-relative
// references to point at.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sessionDir } from "../session/paths";
import { readSlate } from "../session/slate";
import { findSession, exportSessionMarkdown, TranscriptUnreadableError } from "../session/store";
import { courseStatusLine, describeSource, dedupedAttributedSeeds, diffStatLine, gitDiff } from "./machine-wrap-up";
import { readCourse } from "../session/slate-course";
import type { TrustedWrapUpResolution, WrapUpEvidence } from "./trusted-wrap-up";

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
  const evidenceDir = path.dirname(relPath);
  await mkdir(path.join(input.cwd, evidenceDir), { recursive: true });
  await writeFile(path.join(input.cwd, relPath), markdown, "utf8");

  // SLATE-21 primary evidence: same machine-collected shape as
  // resolveMachineWrapUp's "flow" source — Course/flow status, this session's
  // Seeds, and a diff stat, from real Slate/Anchors/git state, never a
  // free-text account of what the agent believes it did. `readSlate` is
  // lenient (undefined, not thrown) for a session that never opened one — an
  // ordinary chat with no Slate engagement still gets a valid, if sparse,
  // wrap-up rather than failing.
  const slate = await readSlate(sessionDir(input.cwd, summary.id)).catch(() => undefined);
  const diffText = await gitDiff(input.cwd);
  const course = await readCourse(input.cwd, slate?.course.flowRef);
  const seeds = slate ? dedupedAttributedSeeds(slate) : [];
  const seedLines = seeds.length > 0
    ? seeds.map((seed) => `- ${seed.text} [${seed.kind}] (source: ${describeSource(seed.source)})`)
    : ["(no Seeds captured this session)"];
  const wrapUpMarkdown = [
    `# ${summary.title}`,
    "",
    "## Course",
    courseStatusLine(course),
    "",
    "## Seeds",
    ...seedLines,
    "",
    "## Working-tree diff",
    diffStatLine(diffText),
    "",
  ].join("\n");
  const wrapUpRelPath = path.join(evidenceDir, `${summary.id}.wrap-up.md`);
  const diffRelPath = path.join(evidenceDir, `${summary.id}.diff.txt`);
  await writeFile(path.join(input.cwd, wrapUpRelPath), wrapUpMarkdown, "utf8");
  await writeFile(path.join(input.cwd, diffRelPath), diffText, "utf8");

  const observedAt = now().toISOString();
  const evidence: WrapUpEvidence[] = [
    { kind: "wrap-up", uri: `./${wrapUpRelPath}`, revision: createHash("sha256").update(wrapUpMarkdown).digest("hex"), observedAt },
    { kind: "diff", uri: `./${diffRelPath}`, revision: createHash("sha256").update(diffText).digest("hex"), observedAt },
    // Reference/attachment, deliberately last (never evidence[0], which
    // readVerifiedProposalEvidence hands to every owner writer as THE
    // content) — the full verbatim transcript, still hash-verified.
    { kind: "session", uri: `./${relPath}`, revision: createHash("sha256").update(markdown).digest("hex"), observedAt },
  ];
  return {
    workspaceId: input.workspaceId,
    sourceRevision: summary.updatedAt,
    summary: `Session "${summary.title}" (${summary.archiveMessageCount} messages${
      summary.model ? `, ${summary.provider ?? "?"}/${summary.model}` : ""
    })`,
    evidence,
    expiresAt: new Date(now().getTime() + WRAP_UP_TTL_MS).toISOString(),
  };
}
