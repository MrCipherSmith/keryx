import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dedupeSeeds, type Slate, type SlateChildDispatch, type SlateSeed, type SlateSeedKind } from "../session/slate";
import type { CourseProjection } from "../session/slate-course";
import { formatGuardWarning, guardOutput, prepareOutputForPersistence } from "../security/guard";

const execFileAsync = promisify(execFile);

export type AttributedSeed = { text: string; kind: SlateSeedKind; source: "parent" | { childDispatchId: string } };

export function describeSource(source: AttributedSeed["source"]): string {
  return source === "parent" ? "parent" : `child:${source.childDispatchId}`;
}

export function dedupedAttributedSeeds(slate: Slate): AttributedSeed[] {
  const seen = new Set<string>();
  const result: AttributedSeed[] = [];
  const take = (seeds: SlateSeed[], source: AttributedSeed["source"]): void => {
    for (const seed of dedupeSeeds(seeds)) {
      const key = seed.text.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ text: seed.text, kind: seed.kind ?? "follow-up", source });
    }
  };
  take(slate.seeds, "parent");
  const children: Record<string, SlateChildDispatch> = slate.childDispatches ?? {};
  for (const [id, dispatch] of Object.entries(children)) take(dispatch.seeds, { childDispatchId: id });
  return result;
}

export async function gitDiff(cwd: string): Promise<string> {
  try { return (await execFileAsync("git", ["diff"], { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout; }
  catch { return ""; }
}

export function diffStatLine(diffText: string): string {
  if (diffText.trim().length === 0) return "no working-tree changes";
  return `working-tree diff: +${(diffText.match(/^\+(?!\+\+)/gm) ?? []).length}/-${(diffText.match(/^-(?!--)/gm) ?? []).length} line(s)`;
}

export function courseStatusLine(course: CourseProjection): string {
  if (course.state !== "bound") return "flow: unbound";
  return `flow ${course.flowRef.uri} snapshot=${course.flowRef.snapshot} completed=${course.completed.length} next=${course.next.length} blocked=${course.blocked.length}`;
}

// ---------------------------------------------------------------------------
// The redaction floor for wrap-up evidence, shared by BOTH producers of a
// `TrustedWrapUpResolution` — `session-wrap-up.ts` (`WrapUpSource === "session"`)
// and `machine-wrap-up.ts` (`"flow"`/`"external-slate"`).
//
// Two things were wrong before this existed.
//
// (1) Only one of the two producers ran the floor at all. `session-wrap-up.ts`
//     put every body through `guardOutput` + `prepareOutputForPersistence`
//     before writing it; `machine-wrap-up.ts` wrote `gitDiff`'s bytes straight
//     to the workspace tree with `writeFileAtomic` and sent the same bytes to a
//     model provider in its summary prompt. Measured on the same planted AWS
//     key in the same working tree, the session producer recorded
//     `aws_key = [REDACTED:secret]` and the machine producer recorded
//     `aws_key = AKIAIOSFODNN7EXAMPLE`. Same evidence taxonomy, same `gitDiff`
//     primitive, opposite outcome — which made the floor advisory rather than a
//     floor. Routing both producers through this one function is what makes the
//     two comparable claims in their own headers ("reuses this exact
//     best-effort git-diff primitive", "looks identical regardless of which of
//     the two wrap-up sources produced it") actually true.
//
// (2) When the floor DID fire, nothing said so. The floor's own "did anything
//     change" answer (`bytesPreserved`) was read by no one, the bytes written
//     were the altered ones, and `revision` was the sha256 OF the altered
//     bytes — so every downstream verifier (`readVerifiedProposalEvidence`,
//     `validateEvidence`, `scanEvidenceSecurityGate`) re-verified successfully
//     against the scrubbed form and reported a clean, intact record. A reviewer
//     reading evidence a proposal describes as the real observation could not
//     tell an untouched record from a rewritten one. That is the shape this
//     programme keeps closing: an alteration rendered indistinguishable from a
//     legitimate result.
//
// So: evidence either goes out with its bytes preserved, or it goes out with a
// `redaction-notice` evidence item beside it saying which bodies were rewritten
// and, as far as the seam can truthfully answer, why. Never altered and silent.
// ---------------------------------------------------------------------------

/** The `WrapUpEvidence.kind` of the notice — appended last, never `evidence[0]`. */
export const REDACTION_NOTICE_KIND = "redaction-notice";

/** One evidence body on its way to disk. */
export type EvidenceBody = Readonly<{
  /** The file name this body is persisted under; the notice names it. */
  name: string;
  content: string;
  /** Workspace-relative path, for the guard's path-scoped policies. */
  path: string;
  source: "generated" | "tool-output";
}>;

export type FlooredEvidenceBody = Readonly<{ name: string; content: string; altered: boolean }>;

export type EvidenceFloorResult =
  | Readonly<{ ok: true; bodies: readonly FlooredEvidenceBody[]; notice: string | undefined }>
  | Readonly<{ ok: false; reason: string }>;

/**
 * What the notice can say about a body the floor rewrote while the security
 * module is disabled for this workspace. The deterministic floor inside
 * `guardOutput` runs regardless of module enablement, but its per-span reasons
 * are not carried on `GuardResult` (only the cleaned text is), and
 * `prepareOutputForPersistence`'s own second pass sees text that is already
 * clean — so with the engine off there is no finding list to report. Saying
 * that plainly is the honest answer; reporting "no findings" would read as
 * "nothing was removed", which is the exact confusion this notice exists to
 * prevent.
 */
const FLOOR_ONLY_DETAIL =
  "rewritten by the deterministic output floor (no finding detail: the security module is disabled or reported none for this workspace)";

function renderRedactionNotice(bodies: readonly FlooredEvidenceBody[], details: ReadonlyMap<string, string>): string {
  const altered = bodies.filter((body) => body.altered);
  const preserved = bodies.filter((body) => !body.altered);
  return [
    "# Evidence redaction notice",
    "",
    "The keryx security redaction floor rewrote part of this proposal's evidence",
    "before it was recorded. The files listed under \"Rewritten\" are NOT the raw",
    "observation, and their recorded `revision` is the sha256 of the rewritten",
    "bytes — so a successful hash check on them proves the scrubbed form is",
    "intact, never that nothing was removed. Read them as scrubbed.",
    "",
    "## Rewritten",
    ...altered.map((body) => `- ${body.name} — ${details.get(body.name) ?? FLOOR_ONLY_DETAIL}`),
    "",
    "## Byte-preserved",
    ...(preserved.length > 0 ? preserved.map((body) => `- ${body.name}`) : ["- (none)"]),
    "",
    "This notice never names the removed content. It records only that removal",
    "happened, which files it happened to, and whatever leak-safe category counts",
    "the security engine produced.",
    "",
  ].join("\n");
}

/**
 * Put every wrap-up evidence body through the floor before it is persisted,
 * hashed, or handed to a model.
 *
 * Refusal is fail-closed and first-wins in the order given: a blocked body
 * means no evidence is written at all, matching the posture
 * `session-wrap-up.ts` already took for its own three bodies.
 */
export async function applyEvidenceRedactionFloor(
  cwd: string,
  bodies: readonly EvidenceBody[],
): Promise<EvidenceFloorResult> {
  const floored: FlooredEvidenceBody[] = [];
  const details = new Map<string, string>();
  for (const body of bodies) {
    const guard = await guardOutput({ cwd, content: body.content, target: "report", source: body.source, path: body.path });
    const output = prepareOutputForPersistence(guard, body.content);
    if (!output.allowed) return { ok: false, reason: output.reason };
    floored.push({ name: body.name, content: output.content, altered: !output.bytesPreserved });
    if (!output.bytesPreserved) {
      // Leak-safe by construction: categories and counts only, never spans.
      const warning = formatGuardWarning(guard.decision, "security");
      if (warning !== null) details.set(body.name, warning);
    }
  }
  const anyAltered = floored.some((body) => body.altered);
  return { ok: true, bodies: floored, notice: anyAltered ? renderRedactionNotice(floored, details) : undefined };
}
