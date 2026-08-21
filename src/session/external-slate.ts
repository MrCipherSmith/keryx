// Storage + lifecycle for an external-hand's own private Slate (SLATE-22..26,
// flow 182 T3, `docs/requirements/slate/specification.md`'s v3 addendum).
//
// An external MCP caller (Claude Code, Codex, any other MCP-connected agent
// harness) has no `sessionDir()` — no keryx session exists for it — so its
// slate cannot live as a sibling of `summary.json`/`context.jsonl` the way a
// keryx-native slate does (`src/session/slate.ts`). It lives instead in a
// project-scoped, non-`.metaproject/`, non-git-tracked namespace:
// `<project>/.keryx/external-slates/<externalSessionId>.json` — one file per
// `externalSessionId`, written under the SAME `withFileLock` primitive
// `slate.ts` already uses (no new lock mechanism). No index/list file spans
// multiple ids — that is AC-40's structural enforcement of "never shared
// between clients", not a policy check layered on top of a shared store.
//
// Unlike `slate.ts`, this module DOES depend on `../sac/machine-wrap-up`
// (`runWrapUp`) for its close/idle-TTL-reclaim lifecycle (SLATE-25/26):
// `slate.ts`'s own "no src/sac/*, no src/harness/*" note describes ITS OWN
// layering choice (a keryx-native session's harness owns wrap-up dispatch
// separately, via `commands/agent.ts`) — not a project-wide rule this new,
// self-contained external-hand module must also follow. Keeping the small
// close/reclaim orchestration here (rather than inventing a third file, or
// duplicating `runWrapUp`'s propose/unbound-candidate logic) is what "reuse
// the existing SLATE-1/SLATE-10 unbound-candidate path, no parallel
// mechanism" (plan.md step 5) actually means in practice.

import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_LOCK_STALE_MS, isNotFound, withFileLock, writeFileAtomic } from "../lib/fs";
import type { Slate, SlateSeed } from "./slate";
import { runWrapUp, type WrapUpTrigger } from "../sac/machine-wrap-up";

/**
 * SLATE-23: an external hand's own self-reported Anchors — deliberately a
 * NARROWER shape than `SlateAnchors` (`./slate.ts`): no `tree`/`runtime`/
 * `fence`, since those are keryx-native, harness-computed fields this path
 * must never populate (AC-36 — "no harness-side tree-walk, worktree-resolve,
 * or runtime-probing code path ever writes into an `ExternalSlate.anchors`
 * field"). `note` is the one field with no `SlateAnchors` equivalent — an
 * external hand's own free-text self-report, distinct from keryx-native
 * Anchors, not a relaxed version of it.
 */
export type ExternalSlateAnchors = {
  root: string;
  touched?: string[];
  note?: string;
};

export type ExternalSlate = {
  externalSessionId: string;
  workspaceId?: string;
  anchors: ExternalSlateAnchors;
  seeds: SlateSeed[];
  /** SLATE-26 idle-TTL input — ISO timestamp of the most recent `slate.open`/`slate.writeSeed` write. */
  lastWriteAt: string;
  /**
   * Set once `closeExternalSlate` has dispatched this slate (explicit
   * `slate.close`, or an idle-TTL reclaim) — the on-disk record is kept
   * (never deleted: its own Seeds/Anchors stay inspectable, and a second
   * `closeExternalSlate`/reclaim call for the same id becomes a guarded
   * no-op rather than a duplicate propose/unbound-candidate dispatch), but a
   * slate carrying this field is no longer "open" for `slate.writeSeed`/a
   * fresh idempotent `slate.open`.
   */
  closedAt?: string;
};

export function externalSlatesDir(cwd: string): string {
  return path.join(cwd, ".keryx", "external-slates");
}

/**
 * `externalSessionId` is caller-supplied, untrusted MCP tool-call input used
 * directly to build filesystem paths below. Left unvalidated, an id like
 * `"../../../../etc/passwd"` would let a caller read/write files far outside
 * `.keryx/external-slates/` — not just another `externalSessionId`'s file,
 * arbitrary paths on disk — defeating AC-34/AC-40's cross-hand isolation
 * guarantee (flow 182 T4 finding, CRITICAL). Every path-building function
 * below calls this FIRST, and only here — one choke point, not one guard
 * duplicated per MCP handler in `src/mcp/tools.ts`, so no current or future
 * caller/call site can bypass it by constructing a path a different way.
 */
const EXTERNAL_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function assertValidExternalSessionId(externalSessionId: string): void {
  if (!EXTERNAL_SESSION_ID_PATTERN.test(externalSessionId)) {
    throw new Error(
      `invalid externalSessionId ${JSON.stringify(externalSessionId)} — must match ${EXTERNAL_SESSION_ID_PATTERN.source} (letters, digits, "-", "_", 1-128 chars, no path separators)`,
    );
  }
}

export function externalSlatePath(cwd: string, externalSessionId: string): string {
  assertValidExternalSessionId(externalSessionId);
  return path.join(externalSlatesDir(cwd), `${externalSessionId}.json`);
}

function externalSlateLockPath(cwd: string, externalSessionId: string): string {
  return `${externalSlatePath(cwd, externalSessionId)}.lock`;
}

/**
 * Where ONE external slate's own wrap-up evidence (an `unbound-candidate`
 * artifact, a `wrap-up-outcome` artifact — both `runWrapUp`'s existing
 * `slate-archive/` convention) lives. Deliberately a DIRECTORY sibling of,
 * never the same path as, `<id>.json` itself — `external-slates/<id>/` next
 * to the file `external-slates/<id>.json` cannot collide, and stays scoped
 * per-id like everything else here (AC-34 cross-hand isolation). There is no
 * `sessionDir()` for an external hand to hang this off (the spec's own
 * words); this is T3's chosen stand-in path — left to this module's
 * judgment, since neither `specification.md` nor the frozen tests pin an
 * exact one (only that the artifact must exist and be findable under
 * `.keryx/`, never silently discarded).
 */
function externalSlateEvidenceDir(cwd: string, externalSessionId: string): string {
  assertValidExternalSessionId(externalSessionId);
  return path.join(externalSlatesDir(cwd), externalSessionId);
}

/** Plain read; `undefined` when no external slate is open for this id yet. */
export async function readExternalSlate(cwd: string, externalSessionId: string): Promise<ExternalSlate | undefined> {
  try {
    const raw = await readFile(externalSlatePath(cwd, externalSessionId), "utf8");
    return JSON.parse(raw) as ExternalSlate;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * Read-modify-write under a single `withFileLock` hold — mirrors
 * `slate.ts`'s `writeSlate` exactly (same in-lock-read rationale: a second
 * same-turn writer's `update` always runs against the first writer's
 * already-committed value, never a stale pre-lock read).
 */
export async function writeExternalSlate(
  cwd: string,
  externalSessionId: string,
  update: (prev: ExternalSlate | undefined) => ExternalSlate,
): Promise<ExternalSlate> {
  await mkdir(externalSlatesDir(cwd), { recursive: true });
  return withFileLock(externalSlateLockPath(cwd, externalSessionId), async () => {
    const prev = await readExternalSlate(cwd, externalSessionId);
    const next = update(prev);
    await writeFileAtomic(externalSlatePath(cwd, externalSessionId), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

async function listExternalSlateIds(cwd: string): Promise<string[]> {
  try {
    const entries = await readdir(externalSlatesDir(cwd));
    return entries.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

/**
 * SLATE-26: `lastWriteAt` past the SAME `withFileLock` stale-lock threshold
 * `src/lib/fs.ts` already defines (`DEFAULT_LOCK_STALE_MS`) — no new,
 * duplicated threshold constant invented for this.
 */
export function isExternalSlateStale(slate: ExternalSlate, now: () => Date = () => new Date()): boolean {
  const lastWriteMs = new Date(slate.lastWriteAt).getTime();
  if (!Number.isFinite(lastWriteMs)) return true;
  return now().getTime() - lastWriteMs > DEFAULT_LOCK_STALE_MS;
}

/**
 * SLATE-25: closes ONE external slate. Dispatches into the existing SAC
 * propose pipeline (`runWrapUp`, `../sac/machine-wrap-up.ts`, mirroring
 * SLATE-18's autonomous `workspace_propose` call shape — same composer,
 * `wrapUpSource: "external-slate"`) when a `workspaceId` was bound earlier
 * in this slate's life (explicit `slate.open` param, or a future SLATE-16
 * bind); absent that, `runWrapUp`'s own existing unbound-candidate branch
 * preserves the Seeds as a local artifact — never a guessed/default
 * `workspaceId`, never silently discarded (AC-38).
 *
 * The external slate's own storage is removed only AFTER `runWrapUp`
 * returns: "closed" means gone from the live-open set, its content now live
 * only in whatever `runWrapUp` produced (a proposal, or the
 * unbound-candidate artifact) — never a second, competing copy of the same
 * Seeds left lying around as still "open".
 *
 * Finding 1 fix (flow 182 T7, MAJOR logic review finding): the read of
 * `external`, the `closedAt === undefined` check, AND the `runWrapUp` call
 * itself all now run INSIDE the SAME `withFileLock` hold as the final
 * "mark closed" write — not just that final write, as before this fix. Two
 * concurrent `slate.*` calls (different `externalSessionId`s, e.g. both
 * via `reclaimStaleExternalSlates`) that both land on the SAME third, stale,
 * unrelated slate used to both pass the `closedAt === undefined` check
 * before either had written anything (that check, and `runWrapUp`'s real
 * I/O, ran completely outside any lock), so both then called `runWrapUp`,
 * producing two separate `unbound-candidate` artifacts (that path's
 * artifact filename is timestamp-based, not content-hash-deduped like the
 * bound-workspace `propose` path already correctly is via its deterministic
 * `proposalId`) — reproduced directly in `slate-tools.test.ts`'s "Finding 1"
 * describe block (confirmed RED via two deterministic, distinct-millisecond
 * `now` injections before this fix; GREEN after). Mirrors `slate.ts`'s own
 * `openSlateAtomic` fix for the identical shape of bug (its own F-001 — see
 * that function's doc comment): fold "read the current value, check it, do
 * the side-effecting work, persist the result" into ONE lock hold, so a
 * second concurrent caller blocks on lock acquisition until the first
 * caller's read-check-act-write has fully committed, then sees the first
 * caller's already-`closedAt`-marked slate and returns early (the existing
 * `if (!external || external.closedAt !== undefined) return;` guard, now
 * lock-protected) rather than racing it.
 *
 * The final write is a raw `writeFileAtomic` (not `writeExternalSlate`,
 * which acquires this SAME lock internally) — `withFileLock`'s lock is a
 * non-reentrant `mkdir`-based mutex (see `slate.ts`'s own
 * `archiveIfExistsLocked` doc comment for the identical constraint), so
 * calling `writeExternalSlate` from inside an already-held
 * `externalSlateLockPath` hold would deadlock.
 *
 * `now` (flow 182 T7 testability seam, mirrors `resolveMachineWrapUp`/
 * `runWrapUp`'s own already-established optional `now` param): defaults to
 * the real clock for every production call site; threaded through to
 * `runWrapUp` (so `writeUnboundCandidateArtifact`'s timestamp-based evidence
 * filename uses it too) and into the `closedAt` timestamp below, purely so a
 * test can deterministically prove the race with two distinct, non-real-time
 * `now` functions rather than depending on real-wall-clock timing luck.
 */
export async function closeExternalSlate(
  cwd: string,
  externalSessionId: string,
  trigger: WrapUpTrigger,
  now: () => Date = () => new Date(),
): Promise<void> {
  await mkdir(externalSlatesDir(cwd), { recursive: true });
  return withFileLock(externalSlateLockPath(cwd, externalSessionId), async () => {
    const external = await readExternalSlate(cwd, externalSessionId);
    // Nothing to do: never opened, or already closed by an earlier explicit
    // `slate.close`/idle-TTL reclaim — guards against a duplicate propose/
    // unbound-candidate dispatch for the same already-closed Seeds. Now
    // evaluated under the SAME lock hold as the write below, so a
    // concurrent racer can never observe this as still-open once the first
    // caller's close has committed.
    if (!external || external.closedAt !== undefined) return;

    const shimSlate: Slate = {
      ...(external.workspaceId !== undefined ? { workspaceId: external.workspaceId } : {}),
      // `runWrapUp`/`resolveMachineWrapUp` only ever read `anchors.root`/
      // `.touched` (never `.tree`/`.runtime`/`.fence`) off a `Slate` for
      // evidence purposes — the narrower `ExternalSlateAnchors` shape (SLATE-23,
      // no tree/runtime/fence at all) maps onto it losslessly for that purpose.
      anchors: { root: external.anchors.root, touched: external.anchors.touched ?? [] },
      // No Flow binding exists (or is meaningful) for an external hand's
      // task-local slate — `readCourse`'s own contract already degrades a
      // `flowRef`-less Course to a harmless `{ state: "unbound" }`.
      course: {},
      seeds: external.seeds,
    };

    await runWrapUp({
      cwd,
      dir: externalSlateEvidenceDir(cwd, externalSessionId),
      slate: shimSlate,
      trigger,
      wrapUpSource: "external-slate",
      now,
    });

    // Mark closed rather than delete: the record (and its Seeds/Anchors)
    // stays readable on disk — AC-40's own non-goal check
    // (`slate-tools.test.ts`) reads a just-closed slate's file directly,
    // which a delete would defeat — while `closedAt` keeps it from ever
    // being dispatched a second time. Written directly (not via
    // `writeExternalSlate` — see this function's own doc comment on why).
    const next: ExternalSlate = { ...external, closedAt: now().toISOString() };
    await writeFileAtomic(externalSlatePath(cwd, externalSessionId), `${JSON.stringify(next, null, 2)}\n`);
  });
}

/**
 * SLATE-26: idle-TTL reclaim, no background timer/daemon — every `slate.*`
 * MCP handler (`src/mcp/tools.ts`) calls this FIRST, scoped to the calling
 * `cwd`, before its own requested operation proceeds. A non-stale external
 * slate is only ever read here (`readExternalSlate`, no lock, no write) —
 * left byte-for-byte untouched (never rewritten, mtime never bumped) by
 * another hand's call landing in the same `cwd`.
 */
export async function reclaimStaleExternalSlates(cwd: string, now: () => Date = () => new Date()): Promise<void> {
  const ids = await listExternalSlateIds(cwd);
  for (const id of ids) {
    // F-007 fix (flow 182 T7, MINOR security review finding): this loop used
    // to have no per-id error isolation at all — one malformed/invalid entry
    // (e.g. a manually-placed file with a bad name, or corrupted JSON) let
    // `readExternalSlate`/`closeExternalSlate` throw UNCAUGHT, aborting the
    // ENTIRE reclaim pass for every OTHER (perfectly valid) external slate
    // under this `cwd`. Since `reclaimStaleExternalSlates` runs at the top of
    // every `slate.*` MCP handler (before that handler's own requested
    // operation proceeds), one bad file broke all three tools project-wide.
    // Each iteration is now isolated: a thrown error for ONE id is caught and
    // skipped (never rethrown), letting the rest of the reclaim loop — and
    // the calling `slate.*` handler's own operation — continue normally.
    try {
      const slate = await readExternalSlate(cwd, id);
      if (slate && isExternalSlateStale(slate, now)) {
        await closeExternalSlate(cwd, id, "external-slate-idle-reclaim", now);
      }
    } catch {
      // Skip this one malformed/unreadable entry; every other id still gets
      // its own independent reclaim attempt below.
    }
  }
}
