// Machine-triggered wrap-up composer (flow 163, Track B — SLATE-7).
//
// `trusted-wrap-up.ts`'s `TrustedWrapUpResolution` has had exactly ONE real
// producer since flow 130/session-wrap-up.ts: `resolveSessionWrapUp`, for
// `WrapUpSource === "session"`. This module is the second, machine-triggered
// producer for `WrapUpSource === "flow"` — a Flow-complete, explicit-command,
// or one-shot-process-termination (AC8) trigger that has NO human at a
// terminal narrating what happened, only whatever the session's own Slate
// (Anchors/Course/Seeds, `../session/slate.ts`) already captured.
//
// Mirrors `session-wrap-up.ts`'s shape and placement deliberately: a pure
// `resolveMachineWrapUp` evidence/summary resolver, plus (unlike
// session-wrap-up.ts, which has no composer of its own — `workspace.ts`'s
// `propose` subcommand IS its composer) a `runWrapUp` composer entry point,
// because a machine trigger — unlike a human typing `keryx workspace
// propose` — must decide FOR ITSELF how many proposals to attempt (one per
// non-empty Seed `kind` group, AC7) and what to do when no workspace was
// ever bound (AC6), which a single CLI subcommand invocation never has to.
//
// AC1 for this track: this module — `resolveMachineWrapUp`/`runWrapUp` — is
// the ONLY code in this Flow's Track B that ever calls
// `wrapUpAuthority.issue()`/`service.create()` for `source: "flow"`, and
// nothing here ever calls the accept/decision flow at all (see this file's
// own AC1 source-text audit, `machine-wrap-up.test.ts`).
//
// DELIBERATE DEVIATION from plan.md's suggested shapes (pinned by
// `machine-wrap-up.test.ts`, which is authoritative over plan.md's prose —
// see that file's own top-of-file comment for the full rationale):
//   1. `kind: SlateSeedKind` (`../session/slate.ts`'s already-exported,
//      already-shipped type), not the private, non-exported `ProposalKind`
//      alias in `./proposal-lifecycle.ts` — there is nothing importable
//      there. The two are the SAME literal union by design (slate.ts's own
//      doc comment: "mirrors ProposalKind ... intentionally").
//   2. `resolveMachineWrapUp` returns `{ ok: true; resolution } | { ok:
//      false; code: "no_credential" }`, not a bare `Promise<
//      TrustedWrapUpResolution>` that throws — `runWrapUp` below must keep
//      going across MULTIPLE Seed-kind groups even when one group's model
//      turn fails closed, which a thrown exception does not compose with.
//   3. `now`/`env`/`modelTurn`/`modelTurnTimeoutMs` are extra, all-optional
//      injection seams (`modelTurn` was `providerFactory` until flow 239
//      phase 7 — see the import block below).
//   4. `runWrapUp` takes BOTH `cwd` (project root — git diff, the SAC
//      workspace tree) AND `dir` (the session dir where `slate.json`/
//      `slate-archive/` actually live) — two different filesystem
//      locations, mirroring `openSlate`'s/`ensureSlateOpened`'s existing
//      `{ dir, cwd }` convention in `../session/slate-lifecycle.ts`.

import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { type Slate, type SlateSeedKind, writeSlate } from "../session/slate";
import { readCourse, type CourseProjection } from "../session/slate-course";
import { createTrustedWrapUpAuthority, type TrustedWrapUpResolution, type WrapUpEvidence, type WrapUpSource } from "./trusted-wrap-up";
import { createHarnessProposalLifecycleService, ProposalLifecycleError } from "./proposal-lifecycle";
import { resolveOrCreateWorkspace } from "./workspace-resolve";
import { applyEvidenceRedactionFloor, courseStatusLine, dedupedAttributedSeeds, describeSource, diffStatLine, gitDiff, REDACTION_NOTICE_KIND, type AttributedSeed } from "./wrap-up-evidence";
// AFC-19 (flow 239, phase 7): the model turn used to arrive as a static
// `runModelTurn` import from `../harness/provider/single-turn`, which put the
// entire provider registry into the public SAC facade's shipped graph. It is
// now an INJECTED port that core declares and a client supplies; absence is a
// refusal with its own code, never a summary nobody asked a model for. See
// `./model-turn-port.ts` and `./core-graph.test.ts`.
import {
  resolveModelTurnPort,
  warnModelTurnUnavailable,
  type ModelTurnOutcome,
  type ModelTurnPort,
} from "./model-turn-port";

export { courseStatusLine, dedupedAttributedSeeds, describeSource, diffStatLine, gitDiff } from "./wrap-up-evidence";
export type { AttributedSeed } from "./wrap-up-evidence";

/**
 * Same TTL `session-wrap-up.ts` uses for its own `TrustedWrapUpResolution`.
 * Safe against real-vs-injected-`now` clock skew because every downstream
 * consumer of a machine-issued provenance in THIS file (the local
 * `wrapUpAuthority` built in `proposeOneGroup`, AND
 * `createHarnessProposalLifecycleService`'s own internal authority/service
 * timestamps) is constructed with the SAME injected `now` — see
 * `proposeOneGroup` below.
 */
const WRAP_UP_TTL_MS = 60 * 60 * 1000;

/**
 * Generous default so a real (non-hanging) provider has room to answer under
 * normal network conditions; a test overrides this to exercise the
 * mechanical-fallback path deterministically without waiting.
 */
const DEFAULT_MODEL_TURN_TIMEOUT_MS = 30_000;

export type MachineWrapUpInput = {
  cwd: string;
  workspaceId: string;
  slate: Slate;
  kind: SlateSeedKind;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  /**
   * The injected single-turn capability (`./model-turn-port.ts`). Core carries
   * no provider registry of its own (AFC-19); without this — and without a
   * process-wide default from `setModelTurnPort` — this resolver refuses with
   * `no_model_turn` instead of writing an unauthored summary.
   */
  modelTurn?: ModelTurnPort;
  modelTurnTimeoutMs?: number;
};

export type MachineWrapUpResolution =
  | { ok: true; resolution: TrustedWrapUpResolution }
  /**
   * `no_credential`: a port was supplied and reported it has no key.
   * `no_model_turn`: no port was supplied at all — a wiring gap, not a key gap.
   * Kept distinct HERE, at the boundary that knows the difference. Note that
   * `proposeOneGroup` still folds both into the existing
   * `WrapUpGroupOutcome`'s `"no_credential"`, because that union is consumed by
   * `./catch-up.ts` and `../tui/review-inspector.ts` — files this change does
   * not own — and widening it would break their exhaustive reads. The
   * distinction survives at this boundary and on stderr (warn-once); widening
   * the group union is left to the lane that owns those two files.
   */
  | { ok: false; code: "no_credential" | "no_model_turn" }
  /**
   * The redaction floor refused one of the evidence bodies outright (an
   * `enforced`/`ci` workspace whose gate came back `fail`/`needs-approval`/
   * `incomplete`, or a body with no format-safe representation at all). Kept
   * as its OWN code, and carried through `proposeOneGroup` as the existing
   * `"error"` group outcome rather than folded into `"no_credential"`: a
   * security refusal that reports itself as a missing credential is a failure
   * disguised as a different, benign failure, and a reviewer would go looking
   * for an API key that was never the problem. `detail` is
   * `prepareOutputForPersistence`'s own reason, which is already leak-safe
   * (categories and counts, never spans).
   */
  | { ok: false; code: "security_denied"; detail: string };

/** A Seed together with which slate it actually came from — a child's Seed is
 * NEVER laundered as the parent's own (spec: "attributed, not merged"). Exported
 * (SLATE-21): `session-wrap-up.ts` reuses this SAME attribution shape for the
 * "session" wrap-up source, so a proposal's evidence taxonomy (diff/flow/seeds)
 * looks identical regardless of which of the two wrap-up sources produced it. */
/**
 * Deduped (SLATE-4's `dedupeSeeds`, applied per-source THEN globally —
 * mirrors `runWrapUp`'s own step 1) Seeds from `slate.seeds` (tagged
 * `"parent"`) plus every `slate.childDispatches[*].seeds` (tagged with that
 * dispatch's id) — a child's Seeds are folded in for grouping/evidence
 * purposes but never presented as the parent's own (AC2/AC3 of Track A are
 * about the LIVE slate structure; this is the read-side analog for wrap-up).
 * Untagged Seeds default to `"follow-up"` (AC7) — never an invented kind.
 */
/** All non-empty `(kind -> Seeds)` groups over the FULL deduped seed pool. */
function groupSeedsByKind(slate: Slate): Map<SlateSeedKind, AttributedSeed[]> {
  const map = new Map<SlateSeedKind, AttributedSeed[]>();
  for (const seed of dedupedAttributedSeeds(slate)) {
    const bucket = map.get(seed.kind);
    if (bucket) bucket.push(seed);
    else map.set(seed.kind, [seed]);
  }
  return map;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Best-effort working-tree diff; swallows "not a git repo"/`git` missing the
 * same way `slate-lifecycle.ts`'s `resolveTree` does — evidence with an empty
 * diff is still valid evidence (a real "nothing changed" observation), never
 * a reason to fail the whole wrap-up. Exported (SLATE-21): `session-wrap-up.ts`
 * reuses this exact best-effort git-diff primitive for its own evidence. */
/** Bounded-timeout fallback template — "git diff stat + flow status line"
 * per plan.md, never a hang and never an invented fact. */
function mechanicalSummary(diffText: string, course: CourseProjection): string {
  return `Mechanical wrap-up summary (model turn unavailable or timed out):\n${diffStatLine(diffText)}\n${courseStatusLine(course)}`;
}

/**
 * The `WrapUpSource === "flow"` resolver `createTrustedWrapUpAuthority`'s
 * `resolveExplicitWrapUp` callback delegates to (see `proposeOneGroup`
 * below) — builds real, independently-re-verifiable evidence for ONE Seed
 * `kind` group and a model-authored (or, on timeout, mechanical) summary of
 * ONLY that evidence.
 *
 * Evidence is never written to disk until a real resolution is about to be
 * returned (see step 4 below) — the fail-closed `no_credential` path never
 * touches the workspace tree at all.
 */
export async function resolveMachineWrapUp(input: MachineWrapUpInput): Promise<MachineWrapUpResolution> {
  const now = input.now ?? (() => new Date());

  // 1. Pure, local evidence content — no model call, no disk write yet.
  const diffText = await gitDiff(input.cwd);
  const course = await readCourse(input.cwd, input.slate.course.flowRef);
  const seedsForKind = dedupedAttributedSeeds(input.slate).filter((seed) => seed.kind === input.kind);
  const flowSnapshotJson = `${JSON.stringify(course, null, 2)}\n`;
  const seedsJson = `${JSON.stringify(
    seedsForKind.map((seed) => ({ text: seed.text, source: describeSource(seed.source) })),
    null,
    2,
  )}\n`;

  // 2. The redaction floor, BEFORE the content is hashed, prompted or written.
  //    `session-wrap-up.ts` — the sibling producer of this same diff/flow/seeds
  //    evidence taxonomy — has always run this seam; this resolver did not, so
  //    `gitDiff`'s raw bytes reached both the workspace tree and the model
  //    prompt below unscrubbed. See `applyEvidenceRedactionFloor` for the
  //    measured asymmetry. Running it here rather than just before
  //    `writeFileAtomic` is deliberate: the model prompt in step 3 is an
  //    egress of the same bytes, and a floor the prompt goes around is not a
  //    floor.
  //
  //    The `path` given to the guard is the hash-free evidence path: the real
  //    file names below embed `shortHash`, which is derived FROM the floored
  //    content, and a path hint is not worth an ordering cycle.
  const evidenceRelBase = path.posix.join(".metaproject", "workspaces", input.workspaceId, "machine-evidence");
  const floor = await applyEvidenceRedactionFloor(input.cwd, [
    { name: `${input.kind}.diff.txt`, content: diffText, path: path.posix.join(evidenceRelBase, `${input.kind}.diff.txt`), source: "tool-output" },
    { name: `${input.kind}.flow.json`, content: flowSnapshotJson, path: path.posix.join(evidenceRelBase, `${input.kind}.flow.json`), source: "generated" },
    { name: `${input.kind}.seeds.json`, content: seedsJson, path: path.posix.join(evidenceRelBase, `${input.kind}.seeds.json`), source: "generated" },
  ]);
  if (!floor.ok) return { ok: false, code: "security_denied", detail: floor.reason };
  const [safeDiff, safeFlow, safeSeeds] = floor.bodies as [
    { name: string; content: string; altered: boolean },
    { name: string; content: string; altered: boolean },
    { name: string; content: string; altered: boolean },
  ];

  // 3. A deterministic content hash — over the FLOORED bodies, which are the
  //    bytes that actually get recorded, so the dedup identity and the evidence
  //    it stands for can never disagree. Baking it into the evidence file NAMES
  //    below (step 5) is what lets AC4's two near-simultaneous racers safely
  //    "collide" onto the SAME bytes when their evidence is genuinely
  //    identical (the common case this AC targets), while two racers that
  //    legitimately observe DIFFERENT evidence (a real flow-snapshot change
  //    mid-race — plan.md's own Risks section calls this out) never
  //    overwrite each other's evidence file, since their hashes — and so
  //    their filenames — differ. It is also what `proposeOneGroup` (below)
  //    folds into the deterministic PROPOSAL id (AC4's actual dedup
  //    mechanism, via `ProposalLifecycleService.create()`'s existing
  //    same-path `"conflict"` rejection — no new lock invented here).
  const sourceRevision = sha256([safeDiff.content, safeFlow.content, safeSeeds.content].join("\u0000"));
  const shortHash = sourceRevision.slice(0, 16);

  // 4. Model summary, raced against a bounded timeout — mirrors
  //    spawn-subagent-tool.ts's own child-deadline `Promise.race` exactly,
  //    including safely ignoring the abandoned promise on timeout (`void
  //    turn.catch(...)`) rather than leaving an unhandled rejection.
  //    A supplied port resolves as fast as any other call (immediately, with
  //    `credentialAvailable: false` and empty text) when it has no credential,
  //    so the fail-closed path below never actually waits out the timeout — and
  //    an ABSENT port never starts a timer at all.
  const system =
    "Summarize ONLY the machine evidence provided below — a git diff, a Flow snapshot, and the Seeds captured " +
    "this session for one proposal kind. Never invent facts that are not present in the evidence.";
  // The floored bodies, not the raw ones: this prompt leaves the machine.
  const user =
    `--- git diff ---\n${safeDiff.content.length > 0 ? safeDiff.content : "(no working-tree changes)"}\n\n` +
    `--- flow snapshot ---\n${safeFlow.content}\n` +
    `--- seeds (${input.kind}) ---\n${safeSeeds.content}`;

  // No port, no summary: refuse before any evidence is written (step 4 below
  // is the only writer, and it is never reached from here), exactly as the
  // no-credential path already did. A mechanical summary is NOT substituted —
  // that is reserved for a real model turn that timed out, and using it here
  // would present an unrequested summary as a wrap-up the model authored.
  const modelTurn = resolveModelTurnPort(input.modelTurn);
  if (modelTurn === undefined) {
    warnModelTurnUnavailable("machine-wrap-up");
    return { ok: false, code: "no_model_turn" };
  }

  let modelResult: ModelTurnOutcome | undefined;
  const modelTurnTimeoutMs = input.modelTurnTimeoutMs ?? DEFAULT_MODEL_TURN_TIMEOUT_MS;
  const turn = modelTurn({
    system,
    user,
    requestId: `machine-wrap-up-${shortHash}`,
    ...(input.env !== undefined ? { env: input.env } : {}),
  }).then((result) => {
    modelResult = result;
    return "done" as const;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), modelTurnTimeoutMs);
  });
  let raceOutcome: "done" | "timeout";
  try {
    raceOutcome = await Promise.race([turn, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  let summary: string;
  if (raceOutcome === "timeout") {
    // Abandoned model-turn promise — safely ignored, never an unhandled
    // rejection (mirrors spawn-subagent-tool.ts's `void turn.catch(...)`).
    void turn.catch(() => {});
    summary = mechanicalSummary(safeDiff.content, course);
  } else {
    const result = modelResult!;
    if (result.text.trim().length === 0 && !result.credentialAvailable) {
      // Fail-closed: `runModelTurn`'s own documented contract (no credential
      // AND no injected test factory produced any text) — never silently
      // proceed with an empty or fabricated summary.
      return { ok: false, code: "no_credential" };
    }
    summary = result.text.trim().length > 0 ? result.text.trim() : mechanicalSummary(safeDiff.content, course);
  }

  // 5. Only now — with a real summary in hand — persist evidence under the
  //    WORKSPACE's own tree (never the session dir; that's `runWrapUp`'s
  //    unbound-candidate path, below) and NEVER under `session-evidence/`
  //    (AC5 — that directory name is `session-wrap-up.ts`'s own full-archive
  //    dump, a structurally different evidence shape this module must never
  //    produce or reference). The bytes written and the `revision` recorded for
  //    them are the FLOORED ones, so a hash check downstream verifies exactly
  //    what is on disk.
  const evidenceDir = path.join(input.cwd, ".metaproject", "workspaces", input.workspaceId, "machine-evidence");
  await mkdir(evidenceDir, { recursive: true });
  const diffFile = `${input.kind}.${shortHash}.diff.txt`;
  const flowFile = `${input.kind}.${shortHash}.flow.json`;
  const seedsFile = `${input.kind}.${shortHash}.seeds.json`;
  await writeFileAtomic(path.join(evidenceDir, diffFile), safeDiff.content);
  await writeFileAtomic(path.join(evidenceDir, flowFile), safeFlow.content);
  await writeFileAtomic(path.join(evidenceDir, seedsFile), safeSeeds.content);

  const observedAt = now().toISOString();
  const relBase = `./.metaproject/workspaces/${input.workspaceId}/machine-evidence`;
  const evidence: WrapUpEvidence[] = [
    { kind: "diff", uri: `${relBase}/${diffFile}`, revision: sha256(safeDiff.content), observedAt },
    { kind: "flow", uri: `${relBase}/${flowFile}`, revision: sha256(safeFlow.content), observedAt },
    { kind: "seeds", uri: `${relBase}/${seedsFile}`, revision: sha256(safeSeeds.content), observedAt },
  ];
  // Appended LAST so `evidence[0]` — the item `readVerifiedProposalEvidence`
  // hands every owner writer as THE content — is still the diff. Present only
  // when the floor actually changed something, so its presence is itself the
  // signal, and hash-verified like every other item so it travels with the
  // proposal instead of sitting beside it as a strippable footnote.
  if (floor.notice !== undefined) {
    const noticeFile = `${input.kind}.${shortHash}.redaction.md`;
    await writeFileAtomic(path.join(evidenceDir, noticeFile), floor.notice);
    evidence.push({ kind: REDACTION_NOTICE_KIND, uri: `${relBase}/${noticeFile}`, revision: sha256(floor.notice), observedAt });
  }

  return {
    ok: true,
    resolution: {
      workspaceId: input.workspaceId,
      sourceRevision,
      summary,
      evidence,
      expiresAt: new Date(now().getTime() + WRAP_UP_TTL_MS).toISOString(),
    },
  };
}

export type WrapUpTrigger =
  | "flow-complete"
  | "explicit"
  | "process-termination"
  // SLATE-25/26 (v3, flow 182 T3): an external-hand slate's own two close
  // triggers — `slate.close` (explicit) and the SLATE-26 idle-TTL reclaim
  // (no daemon; a lazy check other `slate.*` calls perform on themselves).
  | "external-slate-close"
  | "external-slate-idle-reclaim";

export type WrapUpGroupOutcome =
  | { kind: SlateSeedKind; outcome: "proposed"; proposalId: string }
  | { kind: SlateSeedKind; outcome: "conflict" }
  | { kind: SlateSeedKind; outcome: "unbound-candidate" }
  | { kind: SlateSeedKind; outcome: "no_credential" }
  // F-002 fix (flow 163 fix round, logic reviewer MAJOR finding): a
  // genuinely-thrown, non-conflict failure for ONE kind-group (any
  // `ProposalLifecycleError` code other than `"conflict"` — e.g.
  // `"guard_denied"`/`"trusted_wrap_up_required"` — the `actor` guard's
  // plain `Error`, or an unhandled exception from `resolveMachineWrapUp`'s
  // own `mkdir`/`writeFileAtomic` evidence write) is now captured as an
  // outcome value rather than left to reject `proposeOneGroup`'s promise —
  // see `proposeOneGroup`'s own top-level try/catch below for why this
  // matters: `runWrapUp`'s `Promise.all` over every kind-group must never
  // let one group's hard failure discard results already computed/persisted
  // for sibling groups (this module's own top-of-file comment: "must keep
  // going across MULTIPLE Seed-kind groups even when one group's model turn
  // fails closed").
  | { kind: SlateSeedKind; outcome: "error"; message: string };

export type WrapUpOutcome = { groups: WrapUpGroupOutcome[] };

export type RunWrapUpInput = {
  /** Project root — git diff, the SAC workspace tree. */
  cwd: string;
  /** Session dir where `slate.json`/`slate-archive/` actually live. */
  dir: string;
  slate: Slate;
  trigger: WrapUpTrigger;
  /**
   * SLATE-25 (v3): the `TrustedWrapUpProvenance.source` a bound-workspaceId
   * dispatch issues — defaults to `"flow"` (this function's original, only
   * caller before flow 182: keryx-native `commands/agent.ts`). An
   * external-hand `slate.close`/idle-TTL reclaim (`src/session/
   * external-slate.ts`) passes `"external-slate"` explicitly so a
   * proposal's evidence records which wrap-up path actually produced it —
   * reuses this SAME propose/evidence machinery end to end, never a second
   * one.
   */
  wrapUpSource?: WrapUpSource;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  /** Injected model-turn capability, threaded to every group (see above). */
  modelTurn?: ModelTurnPort;
  modelTurnTimeoutMs?: number;
  /**
   * Flow 200 test seam: overrides the real `resolveOrCreateWorkspace`
   * (`./workspace-resolve`) used to bind a workspace from Seeds when
   * `slate.workspaceId` is unset at wrap-up time. Every real call site
   * leaves this unset and gets the real resolver; tests inject a canned
   * decision here.
   */
  resolveWorkspace?: (input: {
    cwd: string;
    topicHint: string;
    env?: Record<string, string | undefined>;
    modelTurn?: ModelTurnPort;
    modelTurnTimeoutMs?: number;
  }) => Promise<{ ok: true; workspaceId: string; action: "bound-existing" | "created" } | { ok: false; reason: string }>;
};

/**
 * The outcome of writing ONE `slate-archive/` artifact through the redaction
 * floor. `security_denied` is kept as its own code — never collapsed into
 * "written" — for the same reason `MachineWrapUpResolution` keeps it: a
 * refusal that reports itself as the ordinary result is a failure disguised as
 * a success, and here the ordinary result (`"unbound-candidate"`) means
 * "a durable artifact for this session already exists", which after a refusal
 * is simply false. `detail` is `prepareOutputForPersistence`'s own reason,
 * already leak-safe (categories and counts, never spans).
 */
type ArchiveArtifactResult =
  | { ok: true; altered: boolean }
  | { ok: false; code: "security_denied"; detail: string };

/**
 * Every `slate-archive/` write in this module goes through here, and here
 * goes through `applyEvidenceRedactionFloor` — the SAME floor
 * `resolveMachineWrapUp` runs over its diff/flow/seeds bodies, not a second
 * implementation of it.
 *
 * This seam exists because the floor used to be applied to only ONE of this
 * producer's two write paths. `resolveMachineWrapUp` floored its bodies before
 * hashing, prompting and writing; the `slate-archive/` writers below wrote the
 * same seed texts — and, in the outcome record, thrown-`Error` messages —
 * verbatim. Measured on an unbound slate whose single seed read `follow up on
 * the key AKIAIOSFODNN7EXAMPLE in config`, the artifact on disk contained that
 * key in the clear while the identical bytes through this floor came back as
 * `follow up on the key [REDACTED:secret] in config`. Same producer, same
 * user-authored content, opposite outcome — which is the asymmetry the
 * previous lane closed BETWEEN the two producers, reappearing WITHIN one of
 * them.
 *
 * Alteration is never silent: when the floor rewrites the body, a sibling
 * `<artifact>.redaction.md` notice lands next to it carrying the same
 * `renderRedactionNotice` text the evidence path attaches as a
 * `redaction-notice` evidence item. There is no `evidence[]` to append to
 * here — these artifacts are read back by filename suffix
 * (`catch-up.ts`'s `*-unbound-candidate.json` / `*-wrap-up-outcome.json`
 * scans) — so the notice is a sibling FILE instead, deliberately named so it
 * matches neither suffix and cannot be mistaken for a second record.
 *
 * The `path` handed to the guard is a best-effort workspace-relative hint for
 * its path-scoped policies. A session dir is not necessarily under `cwd` at
 * all (`runWrapUp` takes the two separately for exactly that reason), so this
 * names the artifact's location within the archive rather than inventing an
 * absolute path the policy layer would not recognise.
 */
async function writeFlooredArchiveArtifact(params: {
  cwd: string;
  dir: string;
  filename: string;
  content: string;
}): Promise<ArchiveArtifactResult> {
  const floor = await applyEvidenceRedactionFloor(params.cwd, [
    {
      name: params.filename,
      content: params.content,
      path: path.posix.join("slate-archive", params.filename),
      source: "generated",
    },
  ]);
  if (!floor.ok) return { ok: false, code: "security_denied", detail: floor.reason };
  const body = floor.bodies[0]!;

  const archiveDir = path.join(params.dir, "slate-archive");
  await mkdir(archiveDir, { recursive: true });
  await writeFileAtomic(path.join(archiveDir, params.filename), body.content);
  if (floor.notice !== undefined) {
    await writeFileAtomic(path.join(archiveDir, `${params.filename}${ARCHIVE_REDACTION_NOTICE_SUFFIX}`), floor.notice);
  }
  return { ok: true, altered: body.altered };
}

/**
 * Suffix for the sibling notice a floored archive artifact gets. Chosen so it
 * ends in neither `-unbound-candidate.json` nor `-wrap-up-outcome.json` —
 * `catch-up.ts` scans `slate-archive/` by exactly those suffixes, and a notice
 * that matched one would be parsed as a malformed record instead of read as
 * what it is.
 */
const ARCHIVE_REDACTION_NOTICE_SUFFIX = ".redaction.md";

/**
 * AC6: the unbound-candidate degrade — never a guessed/default workspaceId,
 * ever. Written under the SESSION dir's `slate-archive/` (NOT the workspace
 * tree, which does not exist to write into when there is no workspaceId at
 * all), one artifact per `runWrapUp` call covering every non-empty kind
 * group at once.
 *
 * The seed texts this records are user-authored session content — the same
 * category `resolveMachineWrapUp` floors into `<kind>.seeds.json` — so this
 * write goes through the same floor (`writeFlooredArchiveArtifact`). The JSON
 * is floored as a whole serialized body, exactly as `seedsJson` already is on
 * the bound path, rather than field by field.
 */
async function writeUnboundCandidateArtifact(
  cwd: string,
  dir: string,
  trigger: WrapUpTrigger,
  now: () => Date,
  grouped: Map<SlateSeedKind, AttributedSeed[]>,
  nonEmptyKinds: SlateSeedKind[],
): Promise<ArchiveArtifactResult> {
  const nowIso = now().toISOString();
  const filename = `${nowIso.replace(/[:.]/g, "-")}-unbound-candidate.json`;
  const content = {
    recordType: "unbound-candidate",
    trigger,
    generatedAt: nowIso,
    groups: nonEmptyKinds.map((kind) => ({
      kind,
      seeds: (grouped.get(kind) ?? []).map((seed) => ({ text: seed.text, source: describeSource(seed.source) })),
    })),
  };
  return writeFlooredArchiveArtifact({ cwd, dir, filename, content: `${JSON.stringify(content, null, 2)}\n` });
}

/**
 * SAC durable wrap-up dispatch outcome recording (flow 173): a second,
 * sibling best-effort artifact — mirrors `writeUnboundCandidateArtifact`
 * exactly (same `slate-archive/` directory, same `writeFileAtomic`, same
 * filename-suffix scheme) — recording the FULL `WrapUpGroupOutcome[]` a
 * `runWrapUp` call produced, unconditionally (success or failure groups
 * alike). Unlike `writeUnboundCandidateArtifact`, this write is wrapped in
 * its OWN try/catch: a failure to record the outcome must not itself throw
 * and must not prevent `runWrapUp` from returning its already-computed
 * result to the caller (both real callers, `agent.ts`/`harness.ts`, already
 * treat `runWrapUp` as best-effort and only log a thrown exception
 * transiently — this write must never become a NEW way for that to happen).
 * `classifySession` (`catch-up.ts`) reads this artifact back to distinguish
 * "wrap-up genuinely failed" from "wrap-up never triggered" in the Review UI.
 *
 * Floored like every other archive write. The reviewer who found the unbound
 * -candidate leak measured this record clean on their probe — it carries only
 * kinds, outcomes, proposal ids and thrown-`Error` messages — but "clean on
 * one probe" is not a category. `WrapUpGroupOutcome`'s `message` is
 * `error.message` from ANY throw inside `proposeOneGroup`, including one
 * raised by the injected `ModelTurnPort`, whose prompt is built from the
 * working-tree diff and the session's seeds; a provider that echoes the
 * request it rejected puts that content straight into this field. Flooring it
 * costs one guard call and removes the assumption.
 */
async function writeWrapUpOutcomeArtifact(
  cwd: string,
  dir: string,
  trigger: WrapUpTrigger,
  now: () => Date,
  groups: WrapUpGroupOutcome[],
): Promise<void> {
  try {
    const nowIso = now().toISOString();
    const filename = `${nowIso.replace(/[:.]/g, "-")}-wrap-up-outcome.json`;
    const content = { recordType: "wrap-up-outcome", trigger, generatedAt: nowIso, groups };
    const written = await writeFlooredArchiveArtifact({
      cwd,
      dir,
      filename,
      content: `${JSON.stringify(content, null, 2)}\n`,
    });
    if (written.ok) return;

    // The floor refused this record outright. Writing nothing would be the
    // easy answer and the wrong one: `classifySession` reads the ABSENCE of
    // this artifact as "wrap-up never triggered", so a silent refusal would
    // erase a session that did run from the Review UI entirely — the same
    // "an alteration rendered indistinguishable from a legitimate result"
    // shape this programme keeps closing. So a refusal marker goes down
    // instead: the record type, trigger and timestamp are preserved (they are
    // this module's own values, never session content), `groups` is empty
    // because none of it could be recorded, and `redaction` says why. The
    // reason is `prepareOutputForPersistence`'s own, already leak-safe
    // (categories and counts, never spans) — the same string
    // `proposeOneGroup` already puts on a group's `message`.
    const refusalIso = now().toISOString();
    const refusalFilename = `${refusalIso.replace(/[:.]/g, "-")}-wrap-up-outcome.json`;
    const archiveDir = path.join(dir, "slate-archive");
    await mkdir(archiveDir, { recursive: true });
    await writeFileAtomic(
      path.join(archiveDir, refusalFilename),
      `${JSON.stringify(
        {
          recordType: "wrap-up-outcome",
          trigger,
          generatedAt: refusalIso,
          groups: [],
          redaction: { refused: true, reason: written.detail },
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    // Best-effort — a failure to record the outcome (including the `mkdir`
    // above) must not itself throw and must not prevent runWrapUp from
    // returning its already-computed result to the caller.
  }
}

/**
 * Attempts ONE proposal for ONE non-empty Seed-kind group — the only place
 * in this Flow's Track B that ever calls `wrapUpAuthority.issue()`/
 * `service.create()` (AC1). Builds its OWN local `TrustedWrapUpAuthority`
 * rather than reusing `createHarnessProposalLifecycleService`'s internal
 * one: `trusted-wrap-up.ts`'s `issued`/`consumed` tracking sets are declared
 * at MODULE scope (shared by every authority instance, by that module's own
 * design), so a provenance minted by THIS local authority still verifies
 * correctly against the SERVICE's own internal authority inside
 * `service.create()`. This sidesteps extending
 * `createHarnessProposalLifecycleService`'s `resolveExplicitWrapUp` to know
 * about `resolveMachineWrapUp` at all, which would otherwise require
 * `proposal-lifecycle.ts` to import THIS module while this module also
 * imports `proposal-lifecycle.ts` — a circular import that is avoidable
 * entirely by minting the provenance locally instead.
 */
async function proposeOneGroup(params: {
  cwd: string;
  workspaceId: string;
  slate: Slate;
  kind: SlateSeedKind;
  now: () => Date;
  wrapUpSource?: WrapUpSource;
  env?: Record<string, string | undefined>;
  modelTurn?: ModelTurnPort;
  modelTurnTimeoutMs?: number;
}): Promise<WrapUpGroupOutcome> {
  const wrapUpSource: WrapUpSource = params.wrapUpSource ?? "flow";
  // F-002 fix (flow 163 fix round, logic reviewer MAJOR finding): this
  // function used to let a non-conflict failure — any other
  // `ProposalLifecycleError` code, the `actor` guard's plain `Error` a few
  // lines down, or an unhandled exception surfacing from
  // `resolveMachineWrapUp`'s own `mkdir`/`writeFileAtomic` evidence write —
  // reject this function's returned promise. Since `runWrapUp` (below) maps
  // every non-empty kind-group through `proposeOneGroup` and awaits them all
  // via `Promise.all`, ANY one group throwing rejected the WHOLE call,
  // discarding results/proposals already computed/persisted for sibling
  // groups — directly contradicting this module's own top-of-file comment
  // ("must keep going across MULTIPLE Seed-kind groups even when one
  // group's model turn fails closed"). Wrapping the ENTIRE body in one
  // top-level try/catch — rather than only `Promise.allSettled`-ing at the
  // `runWrapUp` call site — keeps `proposeOneGroup`'s contract simple
  // ("always resolves to a `WrapUpGroupOutcome`, never rejects") and keeps
  // `runWrapUp`'s existing `Promise.all` correct as-is: once no branch of
  // this function can reject, `Promise.all` over several `proposeOneGroup`
  // calls can no longer have one group's failure poison the others.
  try {
    const resolved = await resolveMachineWrapUp({
      cwd: params.cwd,
      workspaceId: params.workspaceId,
      slate: params.slate,
      kind: params.kind,
      now: params.now,
      ...(params.env !== undefined ? { env: params.env } : {}),
      ...(params.modelTurn !== undefined ? { modelTurn: params.modelTurn } : {}),
      ...(params.modelTurnTimeoutMs !== undefined ? { modelTurnTimeoutMs: params.modelTurnTimeoutMs } : {}),
    });
    if (!resolved.ok) {
      // A refusal by the redaction floor is NOT a credential problem, and must
      // not arrive at the Review UI wearing that label — a reviewer would go
      // looking for an API key that was never missing. `"error"` is the
      // existing `WrapUpGroupOutcome` slot for "this group failed, here is
      // why", already consumed exhaustively by `catch-up.ts` and
      // `tui/review-inspector.ts`, so this needs no union widening either.
      if (resolved.code === "security_denied") {
        return { kind: params.kind, outcome: "error", message: `wrap-up evidence refused by the security floor: ${resolved.detail}` };
      }
      // Both `no_credential` and `no_model_turn` land on the existing
      // `"no_credential"` group outcome — see `MachineWrapUpResolution`'s own
      // comment for why that union is not widened here. `resolveMachineWrapUp`
      // has already said which it was, once, on stderr.
      return { kind: params.kind, outcome: "no_credential" };
    }

    const flowEvidence = resolved.resolution.evidence.find((item) => item.kind === "flow");
    const sourceRef = (flowEvidence ?? resolved.resolution.evidence[0])!.uri;
    const flowRef = params.slate.course.flowRef ?? "";
    // AC4's actual dedup mechanism: a deterministic id from the tuple plan.md
    // specifies, relying on `ProposalLifecycleService.create()`'s EXISTING
    // same-path `"conflict"` rejection (inside its own file lock) — no new
    // lock/dedup mechanism invented here.
    const dedupHash = sha256(`${params.workspaceId}:${flowRef}:${resolved.resolution.sourceRevision}:${params.kind}`);
    const proposalId = `wrapup-${dedupHash.slice(0, 32)}`;

    const wrapUpAuthority = createTrustedWrapUpAuthority({
      now: params.now,
      resolveExplicitWrapUp: async (request) => {
        if (request.source !== wrapUpSource) {
          throw new Error(`machine-wrap-up only resolves "${wrapUpSource}" wrap-ups, got "${request.source}"`);
        }
        return resolved.resolution;
      },
    });
    const { service, authorizationServer } = createHarnessProposalLifecycleService(params.cwd, {
      workspaceId: params.workspaceId,
      now: params.now,
    });
    const requestCorrelationId = randomUUID();
    const actor = await authorizationServer.actorContextFor(undefined, requestCorrelationId);
    // This `throw` — like every other throw in this function's body — is
    // caught by the outer catch below and turned into an `"error"` outcome
    // rather than rejecting `proposeOneGroup`'s own promise (F-002 fix).
    if (!actor) throw new Error("trusted ActorContext is required for a machine wrap-up propose");
    const provenance = await wrapUpAuthority.issue({ actor, source: wrapUpSource, sourceRef });

    try {
      const proposal = await service.create({
        request: undefined,
        requestCorrelationId,
        workspaceId: params.workspaceId,
        id: proposalId,
        proposalRevision: "1",
        kind: params.kind,
        wrapUp: provenance,
      });
      return { kind: params.kind, outcome: "proposed", proposalId: proposal.id };
    } catch (error) {
      if (error instanceof ProposalLifecycleError && error.code === "conflict") {
        // Two near-simultaneous triggers for the SAME flow transition
        // converged on the identical `proposalId` above — the lock-protected
        // second writer sees the first writer's already-committed proposal
        // and is turned away here, exactly AC4's "at most one accepted
        // evidence set" (never a second reviewable proposal). Every OTHER
        // `ProposalLifecycleError` code (and any other kind of error) falls
        // through to the outer catch below (F-002 fix) rather than being
        // special-cased here too.
        return { kind: params.kind, outcome: "conflict" };
      }
      throw error;
    }
  } catch (error) {
    // F-002 fix: the single place that turns a genuinely-thrown, non-conflict
    // failure — from `resolveMachineWrapUp` itself (including its
    // `mkdir`/`writeFileAtomic` evidence write, which has no try/catch of its
    // own), the `actor` guard above, or any other unexpected throw in this
    // function's body — into a `WrapUpGroupOutcome` value instead of letting
    // it reject this function's promise and poison `runWrapUp`'s
    // `Promise.all` over sibling kind-groups.
    const message = error instanceof Error ? error.message : String(error);
    return { kind: params.kind, outcome: "error", message };
  }
}

/**
 * Composer entry point (plan.md's `runWrapUp`). Dedupes+groups Seeds by
 * `kind` (untagged -> `"follow-up"`, AC7 — never inventing a kind for an
 * empty group, so only groups with at least one real Seed ever appear in
 * the returned `groups`), then either:
 *   - `slate.workspaceId` unset: writes ONE local unbound-candidate artifact
 *     covering every non-empty group and skips ALL propose attempts (AC6 —
 *     the only outcome in that case); or
 *   - `slate.workspaceId` set: attempts one `propose` per non-empty group
 *     (`proposeOneGroup`, above), in parallel.
 */
export async function runWrapUp(input: RunWrapUpInput): Promise<WrapUpOutcome> {
  const now = input.now ?? (() => new Date());
  const grouped = groupSeedsByKind(input.slate);
  const nonEmptyKinds = [...grouped.keys()].filter((kind) => (grouped.get(kind)?.length ?? 0) > 0);

  if (nonEmptyKinds.length === 0) {
    // Nothing to wrap up — a harmless no-op (AC8's own "a run with no seeds
    // ... degrades harmlessly" requirement), regardless of whether
    // `workspaceId` is set.
    return { groups: [] };
  }

  /**
   * The unbound degrade, shared by the two branches below. A floor refusal
   * must NOT come back as `"unbound-candidate"`: that outcome means "a durable
   * artifact for this session's seeds already exists on disk", which is
   * exactly what a refusal makes untrue, and `catch-up.ts`'s `classifySession`
   * treats it as a completed dispatch that outranks every failure signal — so
   * reporting it after a refusal would hide the refusal behind a success.
   *
   * It lands on the existing `"error"` outcome rather than a new union member
   * for the reason `MachineWrapUpResolution` already documents for
   * `security_denied`: `WrapUpGroupOutcome` is read exhaustively by
   * `./catch-up.ts` and `../tui/review-inspector.ts`, files this change does
   * not own, and `"error"` is their existing "this group failed, here is why"
   * slot. The message names the security floor, so it is never mistaken for
   * the generic-throw case that shares the slot.
   */
  const unboundDegrade = async (): Promise<WrapUpOutcome> => {
    const written = await writeUnboundCandidateArtifact(input.cwd, input.dir, input.trigger, now, grouped, nonEmptyKinds);
    const groups: WrapUpGroupOutcome[] = written.ok
      ? nonEmptyKinds.map((kind) => ({ kind, outcome: "unbound-candidate" as const }))
      : nonEmptyKinds.map((kind) => ({
          kind,
          outcome: "error" as const,
          message: `unbound-candidate artifact refused by the security floor: ${written.detail}`,
        }));
    await writeWrapUpOutcomeArtifact(input.cwd, input.dir, input.trigger, now, groups);
    return { groups };
  };

  let workspaceId = input.slate.workspaceId;
  if (workspaceId === undefined && input.wrapUpSource === "external-slate") {
    // AC-38 (flow 182): an EXTERNAL slate that never bound a workspaceId
    // must never have one created for it at close — the artifact path is
    // the ONLY outcome, unconditionally.
    return unboundDegrade();
  }
  if (workspaceId === undefined) {
    // Flow 200 (lazy binding): a SESSION with REAL Seeds but no bound
    // workspace resolves-or-creates one FROM THE SEEDS (their texts are the
    // session's actual topic — far better judgment context than the first
    // message was), binds it to the slate, then proposes per kind-group as
    // usual. Only when the resolver fails closed (no credential, timeout,
    // ambiguous) does the old unbound-candidate artifact remain the degrade.
    // AC-38 (flow 182): EXTERNAL slates are exempt — an external hand that
    // never bound a workspaceId must never have one created for it at close
    // (the artifact path is the ONLY outcome for those).
    const topicHint = dedupedAttributedSeeds(input.slate)
      .map((seed) => seed.text)
      .join("; ")
      .trim()
      .slice(0, 2000);
    const resolver = input.resolveWorkspace ?? resolveOrCreateWorkspace;
    const resolved = await resolver({
      cwd: input.cwd,
      topicHint: topicHint.length > 0 ? topicHint : "Untitled session wrap-up",
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.modelTurn !== undefined ? { modelTurn: input.modelTurn } : {}),
      ...(input.modelTurnTimeoutMs !== undefined ? { modelTurnTimeoutMs: input.modelTurnTimeoutMs } : {}),
    });
    if (!resolved.ok) {
      return unboundDegrade();
    }
    workspaceId = resolved.workspaceId;
    // Bind the resolved workspace to the slate so future wrap-ups reuse it
    // instead of re-resolving every close (best-effort, never fatal).
    const boundWorkspaceId = resolved.workspaceId;
    try {
      await writeSlate(input.dir, (prev) => ({
        anchors: prev?.anchors ?? { root: "", touched: [] },
        course: prev?.course ?? {},
        seeds: prev?.seeds ?? [],
        workspaceId: boundWorkspaceId,
      }));
    } catch {
      // ignored — proposal evidence does not depend on the slate write
    }
  }

  const groups = await Promise.all(
    nonEmptyKinds.map((kind) =>
      proposeOneGroup({
        cwd: input.cwd,
        workspaceId,
        slate: input.slate,
        kind,
        now,
        ...(input.wrapUpSource !== undefined ? { wrapUpSource: input.wrapUpSource } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
        ...(input.modelTurn !== undefined ? { modelTurn: input.modelTurn } : {}),
        ...(input.modelTurnTimeoutMs !== undefined ? { modelTurnTimeoutMs: input.modelTurnTimeoutMs } : {}),
      }),
    ),
  );
  await writeWrapUpOutcomeArtifact(input.cwd, input.dir, input.trigger, now, groups);
  return { groups };
}
