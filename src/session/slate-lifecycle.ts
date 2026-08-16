// Anchors computation + open/close lifecycle wiring (SLATE-2, SLATE-5).
//
// Phase 1 (`./slate.ts`) shipped the storage skeleton only, deliberately with
// no dependency on the harness's open/close lifecycle — its own doc comment
// says wiring that up "is Phase 2 and later". This module is that wiring: it
// is the first real caller of `readSlate`/`writeSlate`/`archiveSlate` outside
// tests, and it is the only place in `src/session/*` allowed to depend on
// `resolveProjectRoot()` (`./paths.ts`) and shell out to `git` — `slate.ts`
// itself must stay a pure storage primitive.
//
// Anchors semantics (docs/requirements/slate/specification.md, "Anchors /
// Course / Seeds semantics"): "Valid only for the life of the slate; always
// rebuilt (not restored) on crash/resume from live repo state." Every
// function here that produces `SlateAnchors` recomputes from the live
// filesystem/git state every call — nothing is cached, and nothing reads a
// prior slate's anchors as a starting point.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { archiveSlate, openSlateAtomic, readSlate, type Slate, type SlateAnchors } from "./slate";
import { resolveProjectRoot } from "./paths";
import { courseFromSlate, type CourseProjection } from "./slate-course";

const execFileAsync = promisify(execFile);

/**
 * Best-effort branch/ref resolution for `Anchors.tree`, distinguishing WHICH
 * tree `Anchors.root` (a filesystem path) is checked out to — genuinely
 * useful once several worktrees of the same project can each hold a live
 * slate. No existing helper does this: `src/lib/contained-path.ts`'s own
 * `resolveProjectRoot` answers a different question (nearest `.metaproject`/
 * `.git` ancestor for path-containment checks, not "which branch"), and
 * `src/harness/child/worktree.ts` (`resolveChildCwd`/`planWorktrees`) is the
 * Phase-4 subagent ISOLATION-worktree planner — a deliberately pure planner
 * assigning throwaway git worktrees to dispatched mutator subagents, with no
 * relationship to the current session's own checkout. Neither is
 * repurposable here, so this is new, narrowly-scoped code: a single
 * `git rev-parse --abbrev-ref HEAD` in `root`, swallowing any failure (not a
 * git repo, `git` unavailable, detached-HEAD edge cases that still resolve
 * to `"HEAD"`) to `undefined` — `tree` is optional in `SlateAnchors` and
 * never an authorization input (per spec), so a best-effort miss is fine.
 */
async function resolveTree(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
    const branch = stdout.trim();
    return branch.length > 0 ? branch : undefined;
  } catch {
    return undefined;
  }
}

export interface ComputeAnchorsOptions {
  /** The session's project cwd — NOT necessarily `Anchors.root` itself. */
  cwd: string;
  runtime?: { provider: string; model: string };
}

/**
 * Fresh `SlateAnchors` from live repo state. `root` via `resolveProjectRoot()`
 * (`./paths.ts:52-68` — walks up to the nearest `.git`, dir or gitfile, so a
 * linked worktree checkout resolves to ITS OWN root, not the main worktree's).
 * `touched` always starts empty here — it is append-only WITHIN a slate's
 * life (spec), so a fresh Anchors computation (a fresh open) never carries a
 * prior attempt's `touched` list forward; only the harness's own
 * tool-execution wiring (Phase 3+, out of this Flow's scope) appends to it
 * after this point.
 */
export async function computeAnchors(opts: ComputeAnchorsOptions): Promise<SlateAnchors> {
  const root = resolveProjectRoot(opts.cwd);
  const tree = await resolveTree(root);
  const anchors: SlateAnchors = { root, touched: [] };
  if (tree !== undefined) {
    anchors.tree = tree;
  }
  if (opts.runtime !== undefined) {
    anchors.runtime = opts.runtime;
  }
  return anchors;
}

export interface OpenSlateOptions {
  /** Session dir (`sessionDir()` — already resolved by the caller). */
  dir: string;
  cwd: string;
  /**
   * Mints a safe-filename attemptId (`[A-Za-z0-9._-]+`) for `archiveSlate`,
   * called ONLY when a prior unclosed slate is actually found (never
   * speculatively). Injected rather than hardcoded so the caller controls
   * the source of non-determinism: `runAgentTurn` (agent.ts) — documented as
   * deterministic, using ONLY `deps.idSeq()`, never `Date.now`/`Math.random`
   * — passes `() => deps.idSeq()`; `runAgentRepl`'s real-clock REPL loop
   * (shell.ts) passes a timestamp-based minter. This is a deliberate
   * deviation from the plan's suggested single hardcoded
   * `new Date().toISOString()` minter: baking `Date.now()` into THIS module
   * would leak non-determinism into `runAgentTurn`'s open-trigger call site,
   * which the module's own doc comment states must use ONLY `deps.idSeq`.
   */
  mintAttemptId: () => string;
  runtime?: { provider: string; model: string };
}

/**
 * Open (or re-open) a slate at `dir`: if a `slate.json` already exists it is,
 * by construction, an unclosed prior attempt (a proper close always
 * archives+clears — see `closeSlate`), so it is archived first — this is
 * AC3's mechanism. Either way, a brand-new `Slate` with freshly-computed
 * Anchors, an empty `course`, and no seeds is then written and returned.
 * Anchors are NEVER read off the existing/archived slate — always a fresh
 * `computeAnchors()` call (AC1).
 *
 * The existing-check, conditional archive, and fresh write all happen inside
 * `slate.ts`'s `openSlateAtomic` — a SINGLE lock hold (F-001 fix) rather than
 * three separate ones, so two concurrent `openSlate` calls against the same
 * `dir` can never interleave a clobber past the archive step.
 */
export async function openSlate(opts: OpenSlateOptions): Promise<Slate> {
  const anchors = await computeAnchors({
    cwd: opts.cwd,
    ...(opts.runtime !== undefined ? { runtime: opts.runtime } : {}),
  });
  return openSlateAtomic(opts.dir, opts.mintAttemptId, () => ({ anchors, course: {}, seeds: [] }));
}

/**
 * Close (archive-and-clear) the live slate at `dir`, if any — a no-op when
 * none exists (`archiveSlate`'s own contract). After this, the next
 * `openSlate` at the same `dir` sees no unclosed prior slate.
 */
export async function closeSlate(dir: string, mintAttemptId: () => string): Promise<void> {
  await archiveSlate(dir, mintAttemptId());
}

/**
 * Caller-owned, mutable per-running-process marker of whether a slate has
 * already been opened for THIS session dir during THIS attempt (this running
 * process). Deliberately NOT tracked inside `slate.ts`/`slate-lifecycle.ts`
 * itself as module-level state — that would leak across unrelated
 * sessions/tests and, more importantly, would not reset on a crash the way a
 * fresh process's own fresh `SlateSessionRef` does.
 *
 * Why this exists at all: SLATE-5's open trigger fires on EVERY
 * action-oriented user turn, not just the first. Without an `opened` guard,
 * `ensureSlateOpened` would re-archive-and-recreate the slate (wiping
 * `touched`/Seeds accumulated so far) on every subsequent action-intent
 * within the SAME running attempt — AC3 only requires archiving an UNCLOSED
 * PRIOR attempt's slate, not a slate this same process itself is actively
 * building. A fresh `{ opened: false }` is exactly what a new process
 * (crash/resume) naturally starts with, which is what correctly re-triggers
 * the archive-on-reopen path for a genuinely stale `slate.json` left behind
 * by the crashed attempt.
 */
export interface SlateSessionRef {
  dir: string;
  cwd: string;
  opened: boolean;
}

/**
 * Open exactly once per `ref` (see {@link SlateSessionRef}); a no-op after
 * the first call — UNLESS the on-disk slate has diverged from `ref.opened`
 * since (F-002 fix). `ref.opened` is a per-process, in-memory flag with no
 * cross-process reconciliation: if a SECOND process (e.g. a `keryx shell`
 * session and a `keryx harness run` sharing the same session dir) closes
 * (archives) the same session's slate, this process's `ref.opened === true`
 * would otherwise stay stale forever and permanently skip re-opening. A
 * cheap `readSlate` check confirms a live slate genuinely still exists on
 * disk before trusting `ref.opened`'s "already open" claim — only the
 * open-WRITE itself is skipped when truly redundant, never this check. This
 * runs on every action-classified turn, so it is deliberately a single plain
 * `readSlate` call, not an additional lock hold.
 */
export async function ensureSlateOpened(
  ref: SlateSessionRef,
  mintAttemptId: () => string,
  runtime?: { provider: string; model: string },
): Promise<void> {
  if (ref.opened) {
    const live = await readSlate(ref.dir);
    if (live !== undefined) {
      return;
    }
    // Stale flag: another process archived this session's slate already.
  }
  await openSlate({
    dir: ref.dir,
    cwd: ref.cwd,
    mintAttemptId,
    ...(runtime !== undefined ? { runtime } : {}),
  });
  ref.opened = true;
}

/** Close and reset `ref.opened` so a later action-intent opens a genuinely fresh slate. Safe on `undefined`. */
export async function closeSlateSession(
  ref: SlateSessionRef | undefined,
  mintAttemptId: () => string,
): Promise<void> {
  if (ref === undefined) {
    return;
  }
  await closeSlate(ref.dir, mintAttemptId);
  ref.opened = false;
}

/**
 * True when Course's live Flow projection has reached `"done"`. Reuses
 * `courseFromSlate`/`readCourse` (`./slate-course.ts`) — this is the ONLY
 * flow-done check this Flow builds; no second flow-read path.
 */
export function isCourseDone(course: CourseProjection): boolean {
  return course.state === "bound" && course.flowRef.snapshot === "done";
}

/**
 * SLATE-5's "explicit close phrase" (frozen ACs / plan.md leave the exact
 * token to implementer discretion). Deliberately a small set of multi-word
 * CANONICAL phrases, matched as normalized substrings — NOT single-word
 * tokens the way `isActionRequest`'s open-side classifier works in
 * `commands/agent.ts`. Opening a slate on a false positive is at worst a
 * harmless re-anchor; closing one archives live Course/Seeds, so the bar for
 * a false positive must be higher — a lone word like "done" appearing
 * incidentally in an unrelated sentence ("let me know when the tests are
 * done") must not close the slate, so single-token matching (as
 * `isActionRequest` uses) is deliberately NOT reused here.
 */
const CLOSE_PHRASES: readonly string[] = [
  "close slate",
  "close the slate",
  "wrap up",
  "wrap-up",
  "wrapup",
  "task complete",
  "task is done",
  "task's done",
  "session complete",
  "i'm done",
  "im done",
  "we're done",
  "were done",
  "all done here",
];

/**
 * Words that, when they IMMEDIATELY follow a matched close phrase, mark it as
 * the start of a subordinate/conditional clause rather than a standalone
 * close declaration (F-007 fix). Without this, a substring match alone
 * false-positive-closes on sentences like "mark this task complete once
 * tests pass" — the model is being asked to do something LATER, contingent
 * on a condition, not declaring the session done right now. A phrase
 * followed by ordinary trailing words ("please", "now", "thanks", or
 * nothing) is still treated as a genuine close, matching the existing
 * "wrap up now" / "close the slate please" behavior this must not regress.
 */
const CLOSE_PHRASE_SUBORDINATING_FOLLOWERS: ReadonlySet<string> = new Set([
  "once",
  "when",
  "if",
  "after",
  "before",
  "until",
  "unless",
  "as",
]);

export function isClosePhrase(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  return CLOSE_PHRASES.some((phrase) => {
    const idx = normalized.indexOf(phrase);
    if (idx === -1) return false;
    const after = normalized.slice(idx + phrase.length);
    const nextWord = after.match(/[a-z']+/)?.[0];
    if (nextWord && CLOSE_PHRASE_SUBORDINATING_FOLLOWERS.has(nextWord)) return false;
    return true;
  });
}

/**
 * Timestamp-based attemptId minter for non-deterministic call sites (the
 * real REPL loop in `commands/shell.ts` — never `runAgentTurn`, which must
 * use `deps.idSeq()` instead, see {@link OpenSlateOptions.mintAttemptId}).
 * Sanitized to satisfy `archiveSlate`'s `[A-Za-z0-9._-]+` regex (colons
 * replaced; `.`/`-` are already allowed). A per-process monotonic counter is
 * appended so two mints within the same millisecond (plausible in tests, or
 * a `/new` immediately followed by an exit) never collide on the same
 * archive filename.
 */
let timestampMintCounter = 0;
export function mintTimestampAttemptId(now: Date = new Date()): string {
  timestampMintCounter += 1;
  return `${now.toISOString().replace(/:/g, "-")}-${timestampMintCounter}`;
}
