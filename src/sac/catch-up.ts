// SLATE-10 (flow 165, Slate Phase 5, Track B item 7): catch-up classifier.
//
// A pull-based, cwd-scoped, read-only discovery surface for a human coming
// back after one or more unattended/one-shot runs: pending proposals
// (including archived-workspace ones, WSL-2/AC1), sessions that hit
// `ask_user`/budget exhaustion unattended ("blocked", backed by Track A's
// `writeTerminalState` persistence), unbound-candidate wrap-up artifacts
// nobody has triaged yet (Phase 4's `machine-wrap-up.ts`), and sessions
// whose fate is genuinely unknown. New module — mirrors `machine-wrap-up.ts`'s
// own "new module, `commands/workspace.ts` composes it" placement rather than
// living inside `proposal-lifecycle.ts`/`workspace.ts` itself.
//
// Four categories are ALWAYS separate array fields on `CatchUpReport` (AC2),
// never merged/interleaved. The three session-derived categories (blocked /
// unbound-candidate / unknown) are mutually exclusive per session, decided in
// this priority order (first match wins):
//   1. `isLockHeld(slateLockPath(dir))` is true -> excluded from every
//      category entirely (still running; AC5) — checked FIRST (flow 165
//      review fix, F-002): a session that hit `ask_user`/budget-exhaustion
//      once, was later resumed, and is now actively running (fresh lock
//      held) must never be shown as "blocked" just because a stale
//      `terminal-state.json` from before the resume is still on disk.
//   2. `terminal-state.json` exists and parses -> "blocked".
//   3. `slate-archive/*-unbound-candidate.json` exists (newest wins) -> "unbound-candidate".
//   4. Otherwise -> "unknown".
// An ordinary session that never touched Slate at all (no `slate.json` ever,
// no `slate-archive/`, no `terminal-state.json`) is silently excluded from
// every category — never surfaced as "unknown" noise.
//
// `openSlateAtomic` (`src/session/slate.ts`) clears `terminal-state.json` on
// a fresh slate (re-)open, so a resumed-and-since-completed session's stale
// "blocked" record does not linger forever either — this classifier's
// lock-first check is the belt to that clearing step's suspenders (a session
// can be actively running, lock held, before its next `openSlateAtomic` call
// has had a chance to clear an old `terminal-state.json`).

import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { isLockHeld, pathExists } from "../lib/fs";
import { readConfigFile } from "../lib/config-dir";
import { sessionDir } from "../session/paths";
import { readSlate, slateLockPath, type Slate } from "../session/slate";
import type { TerminalState } from "../session/slate-terminal-state";
import { listSessions, type SessionSummary } from "../session/store";
import type { WrapUpGroupOutcome, WrapUpTrigger } from "./machine-wrap-up";
import { createLocalProposalLifecycleService, type ProposalLifecycleService } from "./proposal-lifecycle";
import { localWorkspaceAuthorizationServer } from "./workspace-service";
import { computeLifecycleFlags, type LifecycleFlag } from "./lifecycle-flag";
import { readSidecarNote } from "./proposal-evidence";

// `Proposal` is not exported from `proposal-lifecycle.ts` (it is that
// module's own private record shape) — derived structurally from the public
// method's own return type instead of widening that module's export surface
// just for this file.
type VisibleProposalGroup = Awaited<ReturnType<ProposalLifecycleService["listVisibleProposedProposals"]>>[number];
type Proposal = VisibleProposalGroup["proposals"][number];

export type CatchUpProposalItem = {
  type: "proposal";
  workspaceId: string;
  proposalId: string;
  fresh: boolean;
  kind: Proposal["kind"];
  author: string;
  createdAt: string;
  /**
   * The caller's own free-text gist from `keryx workspace propose --note`
   * (proposal-evidence.ts's sidecar file), when one was given. NOT
   * `Proposal.summary` — that field is a fixed placeholder
   * ("trusted wrap-up reference"): the trusted wrap-up capability only
   * carries a digest of the real summary, never the text itself (by design,
   * so a caller can't forge it), so there is nothing meaningful to show from
   * it. `note` is the only real, human-authored description of what was
   * proposed that exists on disk before acceptance.
   */
  note: string | undefined;
};
export type CatchUpBlockedItem = { type: "blocked"; sessionId: string; workspaceId?: string; terminalState: TerminalState };
export type CatchUpUnboundCandidateItem = { type: "unbound-candidate"; sessionId: string; evidencePath: string; summary: string };
export type CatchUpUnknownItem = {
  type: "unknown";
  sessionId: string;
  workspaceId?: string;
  lastSeenAt: string;
  // flow 173 (SAC durable wrap-up dispatch outcome recording): populated when
  // a `runWrapUp` dispatch attempt for this session left behind a durable
  // `*-wrap-up-outcome.json` artifact whose every group is a failure outcome
  // (see `isFailureOutcome`/`readNewestWrapUpOutcome` below) — lets the
  // Review UI distinguish "wrap-up genuinely failed" from "wrap-up never
  // triggered at all," both of which otherwise collapse into the same
  // opaque `unknown` item. Absent (the common case) for a session with no
  // such artifact, same as before this change.
  wrapUpOutcome?: { trigger: WrapUpTrigger; generatedAt: string; groups: WrapUpGroupOutcome[] };
};
export type CatchUpItem = CatchUpProposalItem | CatchUpBlockedItem | CatchUpUnboundCandidateItem | CatchUpUnknownItem;

export type CatchUpReport = {
  proposals: CatchUpProposalItem[];
  blocked: CatchUpBlockedItem[];
  unboundCandidates: CatchUpUnboundCandidateItem[];
  unknown: CatchUpUnknownItem[];
  // RP-13 FR3+FR4 (flow 168, Phase 2): a SEPARATE, additive category — a
  // workspace can appear here AND in `proposals[]` at the same time (a
  // pending proposal and a lifecycle flag are independent facts about the
  // same workspace); this never suppresses or replaces the other
  // categories. Always populated, never gated inside the report builder
  // itself — the CLI layer decides whether to DISPLAY the section
  // (`--include-lifecycle-flags`, default shown).
  lifecycleFlags: LifecycleFlag[];
};

/**
 * Builds the full catch-up report for `input.cwd`. Strictly `cwd`-scoped
 * (AC4) — every lookup below is either derived from `input.cwd` (sessions)
 * or from a `ProposalLifecycleService`/`WorkspaceService` rooted at it
 * (proposals), so nothing from a sibling project can ever surface here.
 *
 * `input.workspaceId`, when given, scopes the `proposals[]` section to that
 * one workspace only — never expanding beyond what `listVisibleProposedProposals`
 * already ACL-filtered. An invisible/invalid workspace id yields an EMPTY
 * `proposals[]`, never an error (never leaking whether the id exists).
 */
export async function buildCatchUp(input: { cwd: string; workspaceId?: string }): Promise<CatchUpReport> {
  const [proposals, sessionCategories, lifecycleFlagsAll] = await Promise.all([
    collectProposals(input.cwd, input.workspaceId),
    collectSessionCategories(input.cwd),
    computeLifecycleFlags(input.cwd),
  ]);
  // Same `input.workspaceId` scoping `collectProposals` already applies —
  // never expanding beyond what the caller asked to see.
  const lifecycleFlags = input.workspaceId === undefined
    ? lifecycleFlagsAll
    : lifecycleFlagsAll.filter((flag) => flag.kind !== "workspace" || flag.ref === input.workspaceId);
  return { proposals, ...sessionCategories, lifecycleFlags };
}

async function collectProposals(cwd: string, workspaceId: string | undefined): Promise<CatchUpProposalItem[]> {
  // Same local CLI composition every other read-only `workspace` subcommand
  // uses (`localWorkspaceAuthorizationServer()`) — deterministic per-process
  // subject, so this actor has the same identity as whichever local actor
  // created/owns the workspaces it is about to enumerate.
  const authorizationServer = localWorkspaceAuthorizationServer();
  const actor = await authorizationServer.actorContextFor(undefined, randomUUID());
  if (!actor) throw new Error("trusted ActorContext is required for catch-up");

  const proposalService = createLocalProposalLifecycleService(cwd);
  const groups = await proposalService.listVisibleProposedProposals(actor);
  const scoped = workspaceId === undefined ? groups : groups.filter((group) => group.workspace.id === workspaceId);

  // Flattened once, up front, so the per-proposal freshness re-check below can
  // run concurrently via `Promise.all` (flow 165 fix, cheap performance
  // improvement) — independent per-item I/O, order preserved by `flatMap`'s
  // own group/proposal iteration order, so this is behavior-preserving, not a
  // classification change.
  const flattened = scoped.flatMap((group) => group.proposals.map((proposal) => ({ group, proposal })));
  return Promise.all(
    flattened.map(async ({ group, proposal }) => {
      // Re-checked HERE, per item, right before display (AC3) — never a
      // cached/creation-time value.
      const [fresh, note] = await Promise.all([
        proposalService.isEvidenceFresh(proposal, actor),
        readSidecarNote(cwd, group.workspace.id, proposal.id),
      ]);
      return {
        type: "proposal" as const,
        workspaceId: group.workspace.id,
        proposalId: proposal.id,
        fresh,
        kind: proposal.kind,
        author: proposal.author,
        createdAt: proposal.createdAt,
        note,
      };
    }),
  );
}

type SessionCategories = {
  blocked: CatchUpBlockedItem[];
  unboundCandidates: CatchUpUnboundCandidateItem[];
  unknown: CatchUpUnknownItem[];
};

type ClassifiedSession =
  | { kind: "blocked"; item: CatchUpBlockedItem }
  | { kind: "unbound-candidate"; item: CatchUpUnboundCandidateItem }
  | { kind: "unknown"; item: CatchUpUnknownItem }
  | undefined;

/**
 * Classifies exactly one session into (at most) one of the three
 * session-derived categories, same priority order and semantics the previous
 * sequential loop body used — extracted so `collectSessionCategories` can run
 * every session's independent I/O concurrently via `Promise.all` (flow 165
 * fix, cheap performance improvement; classification outcome unchanged).
 */
async function classifySession(session: SessionSummary): Promise<ClassifiedSession> {
  const dir = sessionDir(session.projectPath, session.id);

  // Still-running: excluded from every category entirely (AC5), checked
  // FIRST (flow 165 review fix, F-002) — a fresh lock held means this
  // session is actively running RIGHT NOW, regardless of what else is on
  // disk (in particular, a stale `terminal-state.json` predating a resume
  // must never still classify a running session as "blocked").
  if (await isLockHeld(slateLockPath(dir))) return undefined;

  const terminalState = await readTerminalState(dir);
  if (terminalState !== undefined) {
    // Best-effort: a blocked session's `slate.json` is typically still
    // unclosed (writeTerminalState never archives/removes it), so its
    // `workspaceId`, if ever bound, is readable straight off it. `undefined`
    // (no slate.json, or no workspaceId ever bound) is a valid outcome.
    const workspaceId = (await safeReadSlate(dir))?.workspaceId;
    return { kind: "blocked", item: { type: "blocked", sessionId: session.id, ...(workspaceId !== undefined ? { workspaceId } : {}), terminalState } };
  }

  const unboundCandidate = await readNewestUnboundCandidate(dir);
  if (unboundCandidate !== undefined) {
    return {
      kind: "unbound-candidate",
      item: { type: "unbound-candidate", sessionId: session.id, evidencePath: unboundCandidate.evidencePath, summary: unboundCandidate.summary },
    };
  }

  // flow 173: a wrap-up dispatch attempt that left behind a durable
  // outcome artifact where EVERY group failed ("error"/"no_credential"/
  // "conflict") is more informative than the generic "unknown" fallback
  // below — surface it as an `unknown` item WITH the real trigger/
  // timestamp/per-group failure reason attached. Checked AFTER the
  // unbound-candidate check above (that check already wins if both exist,
  // since an unbound-candidate artifact is itself evidence of a completed
  // dispatch and already fully informative on its own) and BEFORE the
  // `isSlateEngaged`/`unknown` fallback below (never reordered ahead of
  // `terminal-state.json`/unbound-candidate — a stale failure record must
  // never override a session that has since resolved normally).
  const wrapUpOutcome = await readNewestWrapUpOutcome(dir);
  if (wrapUpOutcome !== undefined && wrapUpOutcome.groups.every(isFailureOutcome)) {
    const workspaceId = (await safeReadSlate(dir))?.workspaceId;
    return {
      kind: "unknown",
      item: {
        type: "unknown",
        sessionId: session.id,
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        lastSeenAt: session.updatedAt,
        wrapUpOutcome: { trigger: wrapUpOutcome.trigger, generatedAt: wrapUpOutcome.generatedAt, groups: wrapUpOutcome.groups },
      },
    };
  }

  // Neither signal fired. Only a session that shows SOME slate engagement
  // is considered further — an ordinary session that never opened a slate
  // at all is silently excluded, never surfaced as "unknown" noise.
  if (!(await isSlateEngaged(dir))) return undefined;

  const workspaceId = (await safeReadSlate(dir))?.workspaceId;
  return { kind: "unknown", item: { type: "unknown", sessionId: session.id, ...(workspaceId !== undefined ? { workspaceId } : {}), lastSeenAt: session.updatedAt } };
}

async function collectSessionCategories(cwd: string): Promise<SessionCategories> {
  // `listSessions` is already `cwd`-scoped by construction (AC4).
  const classified = await Promise.all(listSessions(cwd).map((session) => classifySession(session)));

  const blocked: CatchUpBlockedItem[] = [];
  const unboundCandidates: CatchUpUnboundCandidateItem[] = [];
  const unknown: CatchUpUnknownItem[] = [];
  for (const category of classified) {
    if (category === undefined) continue;
    if (category.kind === "blocked") blocked.push(category.item);
    else if (category.kind === "unbound-candidate") unboundCandidates.push(category.item);
    else unknown.push(category.item);
  }
  return { blocked, unboundCandidates, unknown };
}

async function isSlateEngaged(dir: string): Promise<boolean> {
  if (await pathExists(path.join(dir, "slate.json"))) return true;
  if (await pathExists(path.join(dir, "terminal-state.json"))) return true;
  try {
    const entries = await readdir(path.join(dir, "slate-archive"));
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Flow 165 fix (finding B): `readSlate` rethrows any non-ENOENT error (e.g. a
 * `SyntaxError` from a corrupted `slate.json`), but this whole module is a
 * discovery/listing surface — every OTHER reader here (`readTerminalState`,
 * `readNewestUnboundCandidate`, the proposal `JSON.parse`) is deliberately
 * lenient and never throws. One session's corrupted `slate.json` must not
 * crash the entire `keryx workspace catch-up` command and hide every other
 * proposal/blocked/unbound-candidate/unknown item. `undefined` on any read
 * failure, same posture as `readSlate`'s own ENOENT case.
 */
async function safeReadSlate(dir: string): Promise<Slate | undefined> {
  try {
    return await readSlate(dir);
  } catch {
    return undefined;
  }
}

async function readTerminalState(dir: string): Promise<TerminalState | undefined> {
  // Review finding (CI guard): every reader of the shared config directory
  // must go through readConfigFile/readTranscriptFile — this file also
  // resolves paths via `sessionDir(...)` elsewhere, which is what put it in
  // config-dir.readers.test.ts's numerator once a raw read sat beside it.
  const result = readConfigFile(path.join(dir, "terminal-state.json"));
  if (!result.ok) {
    return undefined;
  }
  try {
    return JSON.parse(result.text) as TerminalState;
  } catch {
    return undefined;
  }
}

type UnboundCandidateContent = {
  recordType?: unknown;
  groups?: Array<{ kind?: unknown; seeds?: Array<{ text?: unknown }> }>;
};

async function readNewestUnboundCandidate(dir: string): Promise<{ evidencePath: string; summary: string } | undefined> {
  const archiveDir = path.join(dir, "slate-archive");
  let entries: string[];
  try {
    entries = (await readdir(archiveDir)).filter((name) => name.endsWith("-unbound-candidate.json"));
  } catch {
    return undefined;
  }
  // Filenames are `<iso-ts-with-":"/"."-as-"-">-unbound-candidate.json`
  // (machine-wrap-up.ts's `writeUnboundCandidateArtifact`) — a fixed-width
  // ISO-derived prefix sorts lexically in chronological order, so scanning
  // from the end of a plain sort visits newest-first.
  entries.sort();
  for (let i = entries.length - 1; i >= 0; i--) {
    const evidencePath = path.join(archiveDir, entries[i]!);
    const result = readConfigFile(evidencePath);
    if (!result.ok) {
      continue; // malformed/partial/oversized entry — try the next-newest, never throw
    }
    try {
      const parsed = JSON.parse(result.text) as UnboundCandidateContent;
      if (parsed.recordType !== "unbound-candidate") continue;
      return { evidencePath, summary: summarizeUnboundCandidate(parsed.groups) };
    } catch {
      continue;
    }
  }
  return undefined;
}

function summarizeUnboundCandidate(groups: UnboundCandidateContent["groups"]): string {
  const safeGroups = groups ?? [];
  if (safeGroups.length === 0) return "no seeds captured";
  const seedCount = safeGroups.reduce((sum, group) => sum + (group.seeds?.length ?? 0), 0);
  const kinds = safeGroups.map((group) => (typeof group.kind === "string" ? group.kind : "unknown")).join(", ");
  return `${seedCount} untriaged seed(s) across ${safeGroups.length} kind(s) (${kinds})`;
}

/** A group outcome that means the dispatch attempt for that Seed-kind group
 * genuinely failed — as opposed to `"proposed"`/`"unbound-candidate"`, both
 * of which mean a durable artifact for that success ALREADY exists and
 * already wins classification earlier in `classifySession` (the unbound-
 * candidate check above, or a real proposal record `collectProposals`
 * surfaces separately) — so by the time `classifySession` reaches the new
 * `wrapUpOutcome` check, `wrapUpOutcome.groups.every(isFailureOutcome)` is a
 * defensive completeness check, not the primary signal. */
function isFailureOutcome(g: WrapUpGroupOutcome): boolean {
  return g.outcome === "error" || g.outcome === "no_credential" || g.outcome === "conflict";
}

type WrapUpOutcomeContent = { recordType?: unknown; trigger?: unknown; generatedAt?: unknown; groups?: unknown };

/**
 * flow 173: mirrors `readNewestUnboundCandidate`'s exact scan-`slate-archive/`
 * -by-filename-suffix pattern (`*-wrap-up-outcome.json` instead of
 * `*-unbound-candidate.json`), and the same lenient "return undefined on any
 * read failure" posture this module's other readers already use (see
 * `safeReadSlate`'s doc comment for the stated module-wide policy: one
 * session's corrupted/missing artifact must never crash the whole catch-up
 * command or hide any other item).
 */
async function readNewestWrapUpOutcome(
  dir: string,
): Promise<{ trigger: WrapUpTrigger; generatedAt: string; groups: WrapUpGroupOutcome[] } | undefined> {
  const archiveDir = path.join(dir, "slate-archive");
  let entries: string[];
  try {
    entries = (await readdir(archiveDir)).filter((name) => name.endsWith("-wrap-up-outcome.json"));
  } catch {
    return undefined;
  }
  // Filenames are `<iso-ts-with-":"/"."-as-"-">-wrap-up-outcome.json`
  // (machine-wrap-up.ts's `writeWrapUpOutcomeArtifact`) — a fixed-width
  // ISO-derived prefix sorts lexically in chronological order, so scanning
  // from the end of a plain sort visits newest-first.
  entries.sort();
  for (let i = entries.length - 1; i >= 0; i--) {
    const evidencePath = path.join(archiveDir, entries[i]!);
    const result = readConfigFile(evidencePath);
    if (!result.ok) {
      continue; // malformed/partial/oversized entry — try the next-newest, never throw
    }
    try {
      const parsed = JSON.parse(result.text) as WrapUpOutcomeContent;
      if (parsed.recordType !== "wrap-up-outcome") continue;
      if (typeof parsed.trigger !== "string" || typeof parsed.generatedAt !== "string" || !Array.isArray(parsed.groups)) continue;
      return { trigger: parsed.trigger as WrapUpTrigger, generatedAt: parsed.generatedAt, groups: parsed.groups as WrapUpGroupOutcome[] };
    } catch {
      continue;
    }
  }
  return undefined;
}
