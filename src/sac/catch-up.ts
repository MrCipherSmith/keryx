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
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isLockHeld, pathExists } from "../lib/fs";
import { sessionDir } from "../session/paths";
import { readSlate, slateLockPath } from "../session/slate";
import type { TerminalState } from "../session/slate-terminal-state";
import { listSessions } from "../session/store";
import { createLocalProposalLifecycleService, type ProposalLifecycleService } from "./proposal-lifecycle";
import { localWorkspaceAuthorizationServer } from "./workspace-service";

// `Proposal` is not exported from `proposal-lifecycle.ts` (it is that
// module's own private record shape) — derived structurally from the public
// method's own return type instead of widening that module's export surface
// just for this file.
type VisibleProposalGroup = Awaited<ReturnType<ProposalLifecycleService["listVisibleProposedProposals"]>>[number];
type Proposal = VisibleProposalGroup["proposals"][number];

export type CatchUpProposalItem = { type: "proposal"; workspaceId: string; proposalId: string; fresh: boolean };
export type CatchUpBlockedItem = { type: "blocked"; sessionId: string; workspaceId?: string; terminalState: TerminalState };
export type CatchUpUnboundCandidateItem = { type: "unbound-candidate"; sessionId: string; evidencePath: string; summary: string };
export type CatchUpUnknownItem = { type: "unknown"; sessionId: string; workspaceId?: string; lastSeenAt: string };
export type CatchUpItem = CatchUpProposalItem | CatchUpBlockedItem | CatchUpUnboundCandidateItem | CatchUpUnknownItem;

export type CatchUpReport = {
  proposals: CatchUpProposalItem[];
  blocked: CatchUpBlockedItem[];
  unboundCandidates: CatchUpUnboundCandidateItem[];
  unknown: CatchUpUnknownItem[];
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
  const [proposals, sessionCategories] = await Promise.all([
    collectProposals(input.cwd, input.workspaceId),
    collectSessionCategories(input.cwd),
  ]);
  return { proposals, ...sessionCategories };
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

  const items: CatchUpProposalItem[] = [];
  for (const group of scoped) {
    for (const proposal of group.proposals) {
      // Re-checked HERE, per item, right before display (AC3) — never a
      // cached/creation-time value.
      const fresh = await proposalService.isEvidenceFresh(proposal, actor);
      items.push({ type: "proposal", workspaceId: group.workspace.id, proposalId: proposal.id, fresh });
    }
  }
  return items;
}

type SessionCategories = {
  blocked: CatchUpBlockedItem[];
  unboundCandidates: CatchUpUnboundCandidateItem[];
  unknown: CatchUpUnknownItem[];
};

async function collectSessionCategories(cwd: string): Promise<SessionCategories> {
  const blocked: CatchUpBlockedItem[] = [];
  const unboundCandidates: CatchUpUnboundCandidateItem[] = [];
  const unknown: CatchUpUnknownItem[] = [];

  // `listSessions` is already `cwd`-scoped by construction (AC4).
  for (const session of listSessions(cwd)) {
    const dir = sessionDir(session.projectPath, session.id);

    // Still-running: excluded from every category entirely (AC5), checked
    // FIRST (flow 165 review fix, F-002) — a fresh lock held means this
    // session is actively running RIGHT NOW, regardless of what else is on
    // disk (in particular, a stale `terminal-state.json` predating a resume
    // must never still classify a running session as "blocked").
    if (await isLockHeld(slateLockPath(dir))) continue;

    const terminalState = await readTerminalState(dir);
    if (terminalState !== undefined) {
      // Best-effort: a blocked session's `slate.json` is typically still
      // unclosed (writeTerminalState never archives/removes it), so its
      // `workspaceId`, if ever bound, is readable straight off it. `undefined`
      // (no slate.json, or no workspaceId ever bound) is a valid outcome.
      const workspaceId = (await readSlate(dir))?.workspaceId;
      blocked.push({ type: "blocked", sessionId: session.id, ...(workspaceId !== undefined ? { workspaceId } : {}), terminalState });
      continue;
    }

    const unboundCandidate = await readNewestUnboundCandidate(dir);
    if (unboundCandidate !== undefined) {
      unboundCandidates.push({
        type: "unbound-candidate",
        sessionId: session.id,
        evidencePath: unboundCandidate.evidencePath,
        summary: unboundCandidate.summary,
      });
      continue;
    }

    // Neither signal fired. Only a session that shows SOME slate engagement
    // is considered further — an ordinary session that never opened a slate
    // at all is silently excluded, never surfaced as "unknown" noise.
    if (!(await isSlateEngaged(dir))) continue;

    const workspaceId = (await readSlate(dir))?.workspaceId;
    unknown.push({ type: "unknown", sessionId: session.id, ...(workspaceId !== undefined ? { workspaceId } : {}), lastSeenAt: session.updatedAt });
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

async function readTerminalState(dir: string): Promise<TerminalState | undefined> {
  try {
    const raw = await readFile(path.join(dir, "terminal-state.json"), "utf8");
    return JSON.parse(raw) as TerminalState;
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
    try {
      const parsed = JSON.parse(await readFile(evidencePath, "utf8")) as UnboundCandidateContent;
      if (parsed.recordType !== "unbound-candidate") continue;
      return { evidencePath, summary: summarizeUnboundCandidate(parsed.groups) };
    } catch {
      continue; // malformed/partial entry — try the next-newest, never throw
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
