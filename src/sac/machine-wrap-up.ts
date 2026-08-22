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
//   3. `now`/`env`/`providerFactory`/`modelTurnTimeoutMs` are extra,
//      all-optional testability seams (mirroring `runModelTurn`'s own
//      injected-non-determinism pattern in single-turn.ts).
//   4. `runWrapUp` takes BOTH `cwd` (project root — git diff, the SAC
//      workspace tree) AND `dir` (the session dir where `slate.json`/
//      `slate-archive/` actually live) — two different filesystem
//      locations, mirroring `openSlate`'s/`ensureSlateOpened`'s existing
//      `{ dir, cwd }` convention in `../session/slate-lifecycle.ts`.

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { writeFileAtomic } from "../lib/fs";
import { dedupeSeeds, type Slate, type SlateChildDispatch, type SlateSeed, type SlateSeedKind, writeSlate } from "../session/slate";
import { readCourse, type CourseProjection } from "../session/slate-course";
import { createTrustedWrapUpAuthority, type TrustedWrapUpResolution, type WrapUpEvidence, type WrapUpSource } from "./trusted-wrap-up";
import { createHarnessProposalLifecycleService, ProposalLifecycleError } from "./proposal-lifecycle";
import { resolveOrCreateWorkspace } from "./workspace-resolve";
import type { ProviderFactory, ModelTurnResult } from "../harness/provider/single-turn";
import { runModelTurn } from "../harness/provider/single-turn";

const execFileAsync = promisify(execFile);

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
  providerFactory?: ProviderFactory;
  modelTurnTimeoutMs?: number;
};

export type MachineWrapUpResolution =
  | { ok: true; resolution: TrustedWrapUpResolution }
  | { ok: false; code: "no_credential" };

/** A Seed together with which slate it actually came from — a child's Seed is
 * NEVER laundered as the parent's own (spec: "attributed, not merged"). Exported
 * (SLATE-21): `session-wrap-up.ts` reuses this SAME attribution shape for the
 * "session" wrap-up source, so a proposal's evidence taxonomy (diff/flow/seeds)
 * looks identical regardless of which of the two wrap-up sources produced it. */
export type AttributedSeed = { text: string; kind: SlateSeedKind; source: "parent" | { childDispatchId: string } };

export function describeSource(source: AttributedSeed["source"]): string {
  return source === "parent" ? "parent" : `child:${source.childDispatchId}`;
}

/**
 * Deduped (SLATE-4's `dedupeSeeds`, applied per-source THEN globally —
 * mirrors `runWrapUp`'s own step 1) Seeds from `slate.seeds` (tagged
 * `"parent"`) plus every `slate.childDispatches[*].seeds` (tagged with that
 * dispatch's id) — a child's Seeds are folded in for grouping/evidence
 * purposes but never presented as the parent's own (AC2/AC3 of Track A are
 * about the LIVE slate structure; this is the read-side analog for wrap-up).
 * Untagged Seeds default to `"follow-up"` (AC7) — never an invented kind.
 */
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
  const childDispatches: Record<string, SlateChildDispatch> = slate.childDispatches ?? {};
  for (const [dispatchId, dispatch] of Object.entries(childDispatches)) {
    take(dispatch.seeds, { childDispatchId: dispatchId });
  }
  return result;
}

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
export async function gitDiff(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["diff"], { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch {
    return "";
  }
}

export function diffStatLine(diffText: string): string {
  if (diffText.trim().length === 0) return "no working-tree changes";
  const added = (diffText.match(/^\+(?!\+\+)/gm) ?? []).length;
  const removed = (diffText.match(/^-(?!--)/gm) ?? []).length;
  return `working-tree diff: +${added}/-${removed} line(s)`;
}

export function courseStatusLine(course: CourseProjection): string {
  if (course.state !== "bound") return "flow: unbound";
  return `flow ${course.flowRef.uri} snapshot=${course.flowRef.snapshot} completed=${course.completed.length} next=${course.next.length} blocked=${course.blocked.length}`;
}

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

  // 2. A deterministic content hash. Baking it into the evidence file NAMES
  //    below (step 4) is what lets AC4's two near-simultaneous racers safely
  //    "collide" onto the SAME bytes when their evidence is genuinely
  //    identical (the common case this AC targets), while two racers that
  //    legitimately observe DIFFERENT evidence (a real flow-snapshot change
  //    mid-race — plan.md's own Risks section calls this out) never
  //    overwrite each other's evidence file, since their hashes — and so
  //    their filenames — differ. It is also what `proposeOneGroup` (below)
  //    folds into the deterministic PROPOSAL id (AC4's actual dedup
  //    mechanism, via `ProposalLifecycleService.create()`'s existing
  //    same-path `"conflict"` rejection — no new lock invented here).
  const sourceRevision = sha256([diffText, flowSnapshotJson, seedsJson].join(" "));
  const shortHash = sourceRevision.slice(0, 16);

  // 3. Model summary, raced against a bounded timeout — mirrors
  //    spawn-subagent-tool.ts's own child-deadline `Promise.race` exactly,
  //    including safely ignoring the abandoned promise on timeout (`void
  //    turn.catch(...)`) rather than leaving an unhandled rejection.
  //    `runModelTurn` itself resolves as fast as any other call
  //    (immediately, with `credentialAvailable: false` and empty text) when
  //    no credential/factory is available, so the fail-closed path below
  //    never actually waits out the timeout.
  const system =
    "Summarize ONLY the machine evidence provided below — a git diff, a Flow snapshot, and the Seeds captured " +
    "this session for one proposal kind. Never invent facts that are not present in the evidence.";
  const user =
    `--- git diff ---\n${diffText.length > 0 ? diffText : "(no working-tree changes)"}\n\n` +
    `--- flow snapshot ---\n${flowSnapshotJson}\n` +
    `--- seeds (${input.kind}) ---\n${seedsJson}`;

  let modelResult: ModelTurnResult | undefined;
  const modelTurnTimeoutMs = input.modelTurnTimeoutMs ?? DEFAULT_MODEL_TURN_TIMEOUT_MS;
  const turn = runModelTurn({
    system,
    user,
    requestId: `machine-wrap-up-${shortHash}`,
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.providerFactory !== undefined ? { providerFactory: input.providerFactory } : {}),
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
    summary = mechanicalSummary(diffText, course);
  } else {
    const result = modelResult!;
    if (result.text.trim().length === 0 && !result.credentialAvailable) {
      // Fail-closed: `runModelTurn`'s own documented contract (no credential
      // AND no injected test factory produced any text) — never silently
      // proceed with an empty or fabricated summary.
      return { ok: false, code: "no_credential" };
    }
    summary = result.text.trim().length > 0 ? result.text.trim() : mechanicalSummary(diffText, course);
  }

  // 4. Only now — with a real summary in hand — persist evidence under the
  //    WORKSPACE's own tree (never the session dir; that's `runWrapUp`'s
  //    unbound-candidate path, below) and NEVER under `session-evidence/`
  //    (AC5 — that directory name is `session-wrap-up.ts`'s own full-archive
  //    dump, a structurally different evidence shape this module must never
  //    produce or reference).
  const evidenceDir = path.join(input.cwd, ".metaproject", "workspaces", input.workspaceId, "machine-evidence");
  await mkdir(evidenceDir, { recursive: true });
  const diffFile = `${input.kind}.${shortHash}.diff.txt`;
  const flowFile = `${input.kind}.${shortHash}.flow.json`;
  const seedsFile = `${input.kind}.${shortHash}.seeds.json`;
  await writeFileAtomic(path.join(evidenceDir, diffFile), diffText);
  await writeFileAtomic(path.join(evidenceDir, flowFile), flowSnapshotJson);
  await writeFileAtomic(path.join(evidenceDir, seedsFile), seedsJson);

  const observedAt = now().toISOString();
  const relBase = `./.metaproject/workspaces/${input.workspaceId}/machine-evidence`;
  const evidence: WrapUpEvidence[] = [
    { kind: "diff", uri: `${relBase}/${diffFile}`, revision: sha256(diffText), observedAt },
    { kind: "flow", uri: `${relBase}/${flowFile}`, revision: sha256(flowSnapshotJson), observedAt },
    { kind: "seeds", uri: `${relBase}/${seedsFile}`, revision: sha256(seedsJson), observedAt },
  ];

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
  providerFactory?: ProviderFactory;
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
    providerFactory?: ProviderFactory;
    modelTurnTimeoutMs?: number;
  }) => Promise<{ ok: true; workspaceId: string; action: "bound-existing" | "created" } | { ok: false; reason: string }>;
};

/**
 * AC6: the unbound-candidate degrade — never a guessed/default workspaceId,
 * ever. Written under the SESSION dir's `slate-archive/` (NOT the workspace
 * tree, which does not exist to write into when there is no workspaceId at
 * all), one artifact per `runWrapUp` call covering every non-empty kind
 * group at once.
 */
async function writeUnboundCandidateArtifact(
  dir: string,
  trigger: WrapUpTrigger,
  now: () => Date,
  grouped: Map<SlateSeedKind, AttributedSeed[]>,
  nonEmptyKinds: SlateSeedKind[],
): Promise<void> {
  const archiveDir = path.join(dir, "slate-archive");
  await mkdir(archiveDir, { recursive: true });
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
  await writeFileAtomic(path.join(archiveDir, filename), `${JSON.stringify(content, null, 2)}\n`);
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
 */
async function writeWrapUpOutcomeArtifact(
  dir: string,
  trigger: WrapUpTrigger,
  now: () => Date,
  groups: WrapUpGroupOutcome[],
): Promise<void> {
  try {
    const archiveDir = path.join(dir, "slate-archive");
    await mkdir(archiveDir, { recursive: true });
    const nowIso = now().toISOString();
    const filename = `${nowIso.replace(/[:.]/g, "-")}-wrap-up-outcome.json`;
    const content = { recordType: "wrap-up-outcome", trigger, generatedAt: nowIso, groups };
    await writeFileAtomic(path.join(archiveDir, filename), `${JSON.stringify(content, null, 2)}\n`);
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
  providerFactory?: ProviderFactory;
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
      ...(params.providerFactory !== undefined ? { providerFactory: params.providerFactory } : {}),
      ...(params.modelTurnTimeoutMs !== undefined ? { modelTurnTimeoutMs: params.modelTurnTimeoutMs } : {}),
    });
    if (!resolved.ok) return { kind: params.kind, outcome: "no_credential" };

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

  let workspaceId = input.slate.workspaceId;
  if (workspaceId === undefined && input.wrapUpSource === "external-slate") {
    // AC-38 (flow 182): an EXTERNAL slate that never bound a workspaceId
    // must never have one created for it at close — the artifact path is
    // the ONLY outcome, unconditionally.
    await writeUnboundCandidateArtifact(input.dir, input.trigger, now, grouped, nonEmptyKinds);
    const groups = nonEmptyKinds.map((kind) => ({ kind, outcome: "unbound-candidate" as const }));
    await writeWrapUpOutcomeArtifact(input.dir, input.trigger, now, groups);
    return { groups };
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
      ...(input.providerFactory !== undefined ? { providerFactory: input.providerFactory } : {}),
      ...(input.modelTurnTimeoutMs !== undefined ? { modelTurnTimeoutMs: input.modelTurnTimeoutMs } : {}),
    });
    if (!resolved.ok) {
      await writeUnboundCandidateArtifact(input.dir, input.trigger, now, grouped, nonEmptyKinds);
      const groups = nonEmptyKinds.map((kind) => ({ kind, outcome: "unbound-candidate" as const }));
      await writeWrapUpOutcomeArtifact(input.dir, input.trigger, now, groups);
      return { groups };
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
        ...(input.providerFactory !== undefined ? { providerFactory: input.providerFactory } : {}),
        ...(input.modelTurnTimeoutMs !== undefined ? { modelTurnTimeoutMs: input.modelTurnTimeoutMs } : {}),
      }),
    ),
  );
  await writeWrapUpOutcomeArtifact(input.dir, input.trigger, now, groups);
  return { groups };
}
