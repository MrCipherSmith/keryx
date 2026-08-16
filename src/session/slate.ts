// Lock-protected storage skeleton for a session-local Slate (SLATE-1).
//
// Phase 1 builds and tests the storage primitive only — wiring it into the
// harness's open/close lifecycle (a real session dir, a real attemptId,
// populating anchors/course/seeds with real content) is Phase 2 (SLATE-5)
// and later. See docs/requirements/slate/specification.md's "Data contracts"
// section for the full shape this mirrors.
//
// `slate.json` lives as a sibling file inside the session dir produced by
// `sessionDir()` (src/session/paths.ts) — this module itself takes an
// already-resolved `dir: string` and never re-derives a session path. A
// prior unclosed `slate.json` is archived (never silently overwritten) to
// `slate-archive/<attemptId>.json` before a fresh attempt's first write.
//
// Pure storage over `withFileLock`/`writeFileAtomic` (src/lib/fs.ts) —
// deliberately no dependency on src/sac/* or src/harness/*.

import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { isNotFound, withFileLock, writeFileAtomic } from "../lib/fs";
import { assembleContext, type ContextCandidate } from "../ctx/assembly";
import { estimateTokens } from "../gdgraph/repomap";
import { redactSensitiveText } from "../security/redact";

/**
 * Mirrors `ProposalKind` from `src/sac/proposal-lifecycle.ts`. Duplicated
 * here rather than imported: this module intentionally has no dependency on
 * `src/sac/*`.
 */
export type SlateSeedKind = "decision" | "wiki-update" | "memory-entry" | "follow-up" | "contract-change" | "risk";

export type SlateAnchors = {
  root: string;
  tree?: string;
  runtime?: { provider: string; model: string };
  touched: string[];
  fence?: string[];
};

export type SlateCourse = {
  flowRef?: string;
};

export type SlateSeed = {
  id: string;
  text: string;
  ts: string;
  kind?: SlateSeedKind;
};

export type SlateChildDispatch = {
  anchors: SlateAnchors;
  course: SlateCourse;
  seeds: SlateSeed[];
  status: "completed" | "incomplete";
};

/**
 * Informal, non-normative Slate data contract — see
 * docs/requirements/slate/specification.md's "Data contracts" section.
 * Full shape is present even though only storage is exercised this phase.
 */
export type Slate = {
  workspaceId?: string;
  anchors: SlateAnchors;
  course: SlateCourse;
  seeds: SlateSeed[];
  childDispatches?: Record<string, SlateChildDispatch>;
};

function slatePath(dir: string): string {
  return path.join(dir, "slate.json");
}

function slateLockPath(dir: string): string {
  return `${slatePath(dir)}.lock`;
}

/** Plain read of `slate.json`; `undefined` when it does not exist yet. */
export async function readSlate(dir: string): Promise<Slate | undefined> {
  try {
    const raw = await readFile(slatePath(dir), "utf8");
    return JSON.parse(raw) as Slate;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * Read-modify-write under a single `withFileLock` hold: the read of the
 * current value and the write of `update`'s result happen inside the same
 * lock hold, so a second same-turn writer's `update` always runs against the
 * first writer's already-committed value, never a stale pre-lock read. This
 * is what makes two overlapping `writeSlate` calls against the same session
 * dir never lose data to a read-modify-write race — a plain `write(dir,
 * value)` API without an in-lock read cannot satisfy that.
 */
export async function writeSlate(dir: string, update: (prev: Slate | undefined) => Slate): Promise<Slate> {
  await mkdir(dir, { recursive: true });
  return withFileLock(slateLockPath(dir), async () => {
    const prev = await readSlate(dir);
    const next = update(prev);
    await writeFileAtomic(slatePath(dir), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

/**
 * Archive-on-close primitive: under the same lock, if `slate.json` exists,
 * move its content to `slate-archive/<attemptId>.json` (mkdir the archive
 * dir first, `writeFileAtomic` the archive copy, then `rm` the live file so
 * a mid-crash never leaves both files claiming to be current) — never a
 * silent overwrite. No-op (not an error) when no `slate.json` exists yet.
 *
 * `attemptId` must be a safe filename token (`[A-Za-z0-9._-]+`) — an invalid
 * value is a caller bug (programmer error), not a runtime condition to
 * swallow, so it throws rather than silently no-oping or continuing.
 */
export async function archiveSlate(dir: string, attemptId: string): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(attemptId)) throw new Error(`invalid attemptId: ${JSON.stringify(attemptId)}`);
  await mkdir(dir, { recursive: true });
  return withFileLock(slateLockPath(dir), () => archiveIfExistsLocked(dir, attemptId));
}

/**
 * Same "archive whatever is live, if anything" behavior as `archiveSlate`,
 * but assumes the caller already holds `slateLockPath(dir)`'s lock (used by
 * `openSlateAtomic` below to fold archive-then-write into one lock hold).
 * Not exported: re-entering `withFileLock` on the same lock path from inside
 * itself would deadlock (the lock is a non-reentrant `mkdir`-based mutex),
 * so this must only ever run already-inside a hold, never acquire its own.
 */
async function archiveIfExistsLocked(dir: string, attemptId: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(slatePath(dir), "utf8");
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  const archiveDir = path.join(dir, "slate-archive");
  await mkdir(archiveDir, { recursive: true });
  await writeFileAtomic(path.join(archiveDir, `${attemptId}.json`), raw);
  await rm(slatePath(dir), { force: true });
}

/**
 * Atomic "archive an unclosed prior slate, then write a fresh one" primitive
 * for `openSlate` (`slate-lifecycle.ts`), fixing a concurrency bug (F-001):
 * `openSlate` used to be three SEPARATE lock holds — an unlocked `readSlate`,
 * then a separately-locked `archiveSlate`, then a separately-locked
 * `writeSlate` whose update callback ignored `prev` entirely. Between the
 * archive lock's release and the write lock's re-acquire there was a real
 * window where two concurrent `openSlate` calls against the same session dir
 * could interleave: the second caller's own freshly-archived-and-written
 * slate could be silently clobbered by the first caller's later write, with
 * no archive step ever having seen the discarded state.
 *
 * Folding the "is there an unclosed prior slate?" check, the conditional
 * archive, and the fresh write into ONE `withFileLock` hold closes that
 * window — a second concurrent caller blocks on lock acquisition until the
 * first caller's archive+write has fully committed, then sees the first
 * caller's just-written slate as the "existing" slate it must itself archive
 * (never silently overwrite).
 *
 * `mintAttemptId` is still invoked only when an existing slate is actually
 * found on disk (never speculatively), matching
 * `OpenSlateOptions.mintAttemptId`'s existing contract — `build` is called
 * unconditionally to produce the fresh slate to persist.
 */
export async function openSlateAtomic(dir: string, mintAttemptId: () => string, build: () => Slate): Promise<Slate> {
  await mkdir(dir, { recursive: true });
  return withFileLock(slateLockPath(dir), async () => {
    const existing = await readSlate(dir);
    if (existing !== undefined) {
      await archiveIfExistsLocked(dir, mintAttemptId());
    }
    const next = build();
    await writeFileAtomic(slatePath(dir), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

/**
 * Append-only Seed write (SLATE-4) on top of `writeSlate`'s already-locked
 * read-modify-write. `seed` is a fully-formed `SlateSeed` — this module has
 * no clock/RNG dependency of its own (see the module doc comment), so id/ts
 * minting is the caller's responsibility, not this helper's.
 *
 * Requires an already-open slate: appending a Seed to a session dir with no
 * live `slate.json` is a caller bug (the lifecycle layer must open a slate
 * before any Seed can be written), so this throws rather than silently
 * fabricating a slate with placeholder Anchors.
 */
export async function appendSeed(dir: string, seed: SlateSeed): Promise<Slate> {
  return writeSlate(dir, (prev) => {
    if (!prev) throw new Error(`appendSeed: no open slate in ${dir}`);
    return { ...prev, seeds: [...prev.seeds, seed] };
  });
}

/**
 * Pure Seed dedup for the wrap-up composer (SLATE-4, spec AC-23): two Seeds
 * are duplicates only when their `text` fields are identical after
 * `.trim()` — no similarity/embedding model in v1. Keeps the first
 * occurrence of each distinct trimmed text; does not mutate `seeds`.
 */
export function dedupeSeeds(seeds: SlateSeed[]): SlateSeed[] {
  const seen = new Set<string>();
  const result: SlateSeed[] = [];
  for (const seed of seeds) {
    const key = seed.text.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(seed);
  }
  return result;
}

/**
 * Default token budget for {@link renderAnchorsBlock} when the caller passes no
 * `opts.maxTokens` — generous enough that a normal session's Anchors (root +
 * tree + runtime + a modest `touched` list) always renders in full, while
 * still bounding a pathologically long-running session's `touched` array
 * (spec requirement: on-disk storage stays unbounded/append-only, but the
 * RENDERED view injected into `history` must never grow without limit).
 */
const DEFAULT_RENDER_MAX_TOKENS = 2000;

/**
 * Shared touched-array redaction + token-bounding core (review finding 1 /
 * finding 7). `renderAnchorsBlock` (below) and `slate-terminal-state.ts`'s
 * `boundedRedactedAnchorsSnapshot` both need to turn a raw, append-only
 * `SlateAnchors.touched` array into a redacted, budget-bounded, readable-order
 * subset — this is the ONE shared implementation of that logic, extracted so
 * the two never again drift the way they did before this fix: review finding
 * 1 found that `renderAnchorsBlock` never redacted `touched` at all, while a
 * near-identical inline copy of this same algorithm in
 * `slate-terminal-state.ts` DID redact — because the two were separately
 * hand-maintained copies with no shared source of truth.
 *
 * Every `touched` entry is redacted via `redactSensitiveText`
 * (`src/security/redact.ts`) BEFORE token estimation or selection — so a raw
 * secret's true length never buys it a bigger token cost than what actually
 * survives into the render, and a dropped-for-budget entry was never
 * un-redacted in the first place. Selection is most-recent-first (index 0 of
 * the reversed array is `touched`'s LAST/newest entry) via `assembleContext`,
 * so a tight `budget` drops the OLDEST entries, never the newest; survivors
 * are then restored to chronological (oldest-survivor-first) order for
 * readability. `budget` is entirely the caller's own concern — each of the
 * two call sites computes its own touched-only token budget differently (see
 * each one's own doc comment), this helper only owns what happens to
 * `touched` once a budget is known.
 */
export function redactAndBoundTouched(
  touched: readonly string[],
  budget: number,
  ctx: { traceRef: string; configurationRevision: string; policyRef: string; policyRevision: string },
): string[] {
  // Most-recent-first: index 0 here is `touched`'s LAST (newest) entry.
  const recentFirstRedacted = [...touched].reverse().map((entry) => redactSensitiveText(entry));
  const candidates: ContextCandidate[] = recentFirstRedacted.map((text, i) => ({
    id: `touched:${i}`,
    required: false,
    tokens: estimateTokens(text),
  }));

  const assembly = assembleContext({
    candidates,
    maxItems: candidates.length,
    maxTokens: Math.max(0, budget),
    ...ctx,
  });
  // No candidate above is `required`, so `assembleContext` never returns the
  // `context_overflow` shape for this call — it only ever omits optionally.
  const selectedIds = new Set("code" in assembly ? [] : assembly.selected);

  return recentFirstRedacted
    .map((text, i) => ({ id: `touched:${i}`, text }))
    .filter((entry) => selectedIds.has(entry.id))
    .reverse() // restore oldest-survivor-first order among the survivors
    .map((entry) => entry.text);
}

/**
 * SLATE-2a (Anchors auto-inject, AC4/AC5): render `anchors.root`/`tree`/
 * `runtime`/`touched` as a plain-text block suitable for a harness-written
 * `{role:"user", provenance:"project"}` history message. Bounded via the
 * existing `assembleContext` (`src/ctx/assembly.ts`) — the PURE bounding
 * function, never `assembleAndRecordContext` (that wrapper also writes a
 * `.metaproject/context-operations/traces/*.json` record per call; the spec
 * cites `assembleContext` specifically, and this function runs once per
 * qualifying tool call — a trace file per call would spam the workspace).
 *
 * `root` is always a REQUIRED `ContextCandidate` (`assembleContext` never
 * drops a required candidate for a non-required one; when even `root`'s own
 * token cost cannot fit `opts.maxTokens`, `assembleContext` returns a
 * `context_overflow` shape instead of a normal assembly — that case is
 * handled by forcing `root` into the render directly, since "root always
 * survives" is this function's own contract, not something a caller should
 * have to special-case).
 *
 * `root`/`tree`/`runtime` are assembled FIRST, in their own `assembleContext`
 * call (root required, tree/runtime optional) — exactly the same greedy,
 * in-order selection `assembleContext` would perform if they were mixed into
 * one call with `touched` (each candidate's fit check only ever depends on
 * cumulative tokens consumed by candidates BEFORE it in the list, so
 * splitting "head" candidates from `touched` into two sequential calls is
 * behaviorally identical to one combined call, provided `touched` is always
 * considered after root/tree/runtime — which it always was). What remains of
 * `maxTokens` after the head is selected becomes `touched`'s own budget,
 * handed to the shared {@link redactAndBoundTouched} helper (review finding
 * 1 / finding 7), which redacts every `touched` entry via
 * `redactSensitiveText` (`src/security/redact.ts`) BEFORE any selection
 * happens — this function previously never redacted `touched` at all before
 * pushing it into shared, provider-bound `history`.
 *
 * Defensive structural guard for AC5 ("Course/Seeds content is reachable
 * only through slate_read/slate_write_seed, never silently injected"): this
 * function's concerns are strictly `anchors.*` — it must NEVER read
 * `Slate.course`/`Slate.seeds`, and its rendered output must never contain
 * the literal words "course"/"seeds" (case-insensitive), so a reviewer or a
 * cheap grep-based test can confirm the two concerns stayed genuinely
 * separate code paths, not just conventionally separate.
 */
export function renderAnchorsBlock(anchors: SlateAnchors, opts?: { maxTokens?: number }): string {
  const maxTokens = opts?.maxTokens ?? DEFAULT_RENDER_MAX_TOKENS;

  const rootLine = `root: ${anchors.root}`;
  const treeLine = anchors.tree !== undefined ? `tree: ${anchors.tree}` : undefined;
  const runtimeLine =
    anchors.runtime !== undefined ? `runtime: ${anchors.runtime.provider}/${anchors.runtime.model}` : undefined;

  type Entry = { id: string; text: string; required: boolean };
  const headEntries: Entry[] = [{ id: "root", text: rootLine, required: true }];
  if (treeLine !== undefined) headEntries.push({ id: "tree", text: treeLine, required: false });
  if (runtimeLine !== undefined) headEntries.push({ id: "runtime", text: runtimeLine, required: false });

  const headCandidates: ContextCandidate[] = headEntries.map((entry) => ({
    id: entry.id,
    required: entry.required,
    tokens: estimateTokens(entry.text),
  }));

  const headAssembly = assembleContext({
    candidates: headCandidates,
    maxItems: headCandidates.length,
    maxTokens,
    traceRef: "slate-anchors",
    configurationRevision: "slate-anchors-v1",
    policyRef: "slate-anchors",
    policyRevision: "v1",
  });

  // `assembleContext` returning a `context_overflow` shape (via `"code" in
  // assembly`) means even `root` alone did not fit `maxTokens` — force it in
  // anyway (required candidates always survive per this function's own
  // contract), drop tree/runtime, and leave no budget for `touched`.
  const headSelectedIds = "code" in headAssembly ? new Set<string>(["root"]) : new Set(headAssembly.selected);
  const headTokensUsed =
    "code" in headAssembly
      ? 0
      : headCandidates.filter((c) => headSelectedIds.has(c.id)).reduce((sum, c) => sum + c.tokens, 0);
  const touchedBudget = "code" in headAssembly ? 0 : Math.max(0, maxTokens - headTokensUsed);

  const touchedLines = redactAndBoundTouched(anchors.touched, touchedBudget, {
    traceRef: "slate-anchors-touched",
    configurationRevision: "slate-anchors-v1",
    policyRef: "slate-anchors",
    policyRevision: "v1",
  }).map((text) => `- ${text}`);

  const lines: string[] = ["Anchors:", rootLine];
  if (treeLine !== undefined && headSelectedIds.has("tree")) lines.push(treeLine);
  if (runtimeLine !== undefined && headSelectedIds.has("runtime")) lines.push(runtimeLine);
  if (touchedLines.length > 0) {
    lines.push("touched:", ...touchedLines);
  }

  return lines.join("\n");
}
