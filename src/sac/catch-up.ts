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
import { readdir, stat } from "node:fs/promises";
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
import { externalSlatesDir, readExternalSlate } from "../session/external-slate";
import { collectPages } from "../wiki/collect";
import { collectEntries } from "../memory/store";

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
export type CatchUpUnboundCandidateItem = {
  type: "unbound-candidate";
  sessionId?: string;
  externalSessionId?: string;
  evidencePath: string;
  summary: string;
};
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
/**
 * Flow 194 / issue #391 (SAC CLI bypass backstop): a session during whose
 * time window an SAC-owned path (wiki/memory/skill) picked up durable,
 * "reviewed"-looking content on disk with NO corresponding SAC receipt for
 * that exact path — i.e. it did not get there via an accepted proposal's
 * guarded owner-writer (`wiki-owner-writer.ts` / `memory-owner-writer.ts` /
 * `skill-owner-writer.ts`). `keryx wiki enrich`'s old default (fixed in this
 * same flow) was one concrete way to produce this; this category is the
 * general, standing backstop for any OTHER present or future SAC-owned CLI
 * subcommand with the same structural gap — distinct and separately named
 * (never folded into `unknown`) precisely because "some CLI command bypassed
 * review" is a different, more actionable finding than "nothing is known
 * about this session at all."
 */
export type CatchUpUnreviewedPathItem = {
  type: "unreviewed-sac-path";
  sessionId: string;
  workspaceId?: string;
  owner: "wiki" | "memory" | "skill";
  /** Workspace-relative path under `.metaproject/`, e.g. `wiki/components/foo.md`. */
  path: string;
  /** The frontmatter Status value found (wiki/memory only — skill has none). */
  status?: string;
  /** The file's on-disk mtime (ISO) — how this got attributed to `sessionId`. */
  changedAt: string;
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
  // Flow 194 / issue #391: ALSO a separate, additive category, same posture
  // as `lifecycleFlags` above — a session can appear here AND in `unknown`
  // (or AND in `proposals[]`) at once; this is an independent fact about
  // what changed on disk, not a replacement classification for the session
  // as a whole. Always populated; never folded into `unknown`.
  unreviewedPaths: CatchUpUnreviewedPathItem[];
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
  const [proposals, sessionCategories, lifecycleFlagsAll, unreviewedPathsAll] = await Promise.all([
    collectProposals(input.cwd, input.workspaceId),
    collectSessionCategories(input.cwd),
    computeLifecycleFlags(input.cwd),
    detectUnreviewedSacPathChanges(input.cwd, listSessions(input.cwd)),
  ]);
  // Same `input.workspaceId` scoping `collectProposals` already applies —
  // never expanding beyond what the caller asked to see.
  const lifecycleFlags = input.workspaceId === undefined
    ? lifecycleFlagsAll
    : lifecycleFlagsAll.filter((flag) => flag.kind !== "workspace" || flag.ref === input.workspaceId);
  const unreviewedPaths = input.workspaceId === undefined
    ? unreviewedPathsAll
    : unreviewedPathsAll.filter((item) => item.workspaceId === input.workspaceId);
  return { proposals, ...sessionCategories, lifecycleFlags, unreviewedPaths };
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

/**
 * Scans `.keryx/external-slates/` for closed, never-bound external MCP slates.
 * Reports them as unbound candidates in the same shape as internal sessions.
 * An external slate is "bound" if it has a `workspaceId`; "closed" if it has
 * a `closedAt` field (set by `closeExternalSlate` after `runWrapUp` completes).
 *
 * For each closed+unbound external slate, looks for an unbound-candidate
 * artifact in `.keryx/external-slates/<id>/` (written by `runWrapUp` when
 * closing a slate with no workspaceId). Falls back to a minimal summary from
 * the seeds in the external slate file itself if the artifact is missing.
 */
async function readExternalUnboundCandidates(cwd: string): Promise<CatchUpUnboundCandidateItem[]> {
  const extDir = externalSlatesDir(cwd);
  let externalIds: string[];
  try {
    const entries = await readdir(extDir);
    externalIds = entries.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
  } catch {
    return []; // external-slates directory doesn't exist yet
  }

  const candidates: CatchUpUnboundCandidateItem[] = [];
  for (const id of externalIds) {
    const slate = await readExternalSlate(cwd, id);
    if (!slate) continue; // skip unreadable files

    // Only include slates that are BOTH closed AND never bound to a workspace
    if (slate.closedAt === undefined || slate.workspaceId !== undefined) continue;

    // Look for the newest unbound-candidate artifact in the external slate's evidence dir
    const unbound = await readNewestUnboundCandidateForExternal(cwd, id);
    if (unbound) {
      candidates.push({
        type: "unbound-candidate",
        externalSessionId: id,
        evidencePath: unbound.evidencePath,
        summary: unbound.summary,
      });
    } else {
      // Fallback: generate a minimal summary from the seeds in the slate itself
      const summary = summarizeUnboundCandidate(
        (slate.seeds ?? []).reduce((groups, seed) => {
          const kind = seed.kind ?? "follow-up";
          const existing = groups.find((g) => g.kind === kind);
          if (existing) {
            existing.seeds = (existing.seeds ?? []).concat([{ text: seed.text }]);
          } else {
            groups.push({ kind, seeds: [{ text: seed.text }] });
          }
          return groups;
        }, [] as Array<{ kind: string; seeds?: Array<{ text?: string }> }>),
      );
      candidates.push({
        type: "unbound-candidate",
        externalSessionId: id,
        evidencePath: path.join(extDir, `${id}.json`),
        summary,
      });
    }
  }
  return candidates;
}

/**
 * Looks for the newest unbound-candidate artifact in an external slate's
 * evidence directory (`.keryx/external-slates/<id>/`). Mirrors
 * `readNewestUnboundCandidate`'s scanning logic but scoped to external-slate
 * evidence, not session `slate-archive/`.
 */
async function readNewestUnboundCandidateForExternal(
  cwd: string,
  externalSessionId: string,
): Promise<{ evidencePath: string; summary: string } | undefined> {
  const evidenceDir = path.join(externalSlatesDir(cwd), externalSessionId);
  let entries: string[];
  try {
    entries = (await readdir(evidenceDir)).filter((name) => name.endsWith("-unbound-candidate.json"));
  } catch {
    return undefined; // evidence dir doesn't exist yet
  }

  // Filenames are `<iso-ts-with-":"/"."-as-"-">-unbound-candidate.json`
  // — sorting lexically visits newest-first (same pattern as internal sessions)
  entries.sort();
  for (let i = entries.length - 1; i >= 0; i--) {
    const evidencePath = path.join(evidenceDir, entries[i]!);
    const result = readConfigFile(evidencePath);
    if (!result.ok) {
      continue; // malformed/partial/oversized entry — try the next-newest
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

async function collectSessionCategories(cwd: string): Promise<SessionCategories> {
  // Collect internal session categories and external unbound candidates in parallel
  const [classified, externalUnboundCandidates] = await Promise.all([
    Promise.all(listSessions(cwd).map((session) => classifySession(session))),
    readExternalUnboundCandidates(cwd),
  ]);

  const blocked: CatchUpBlockedItem[] = [];
  const unboundCandidates: CatchUpUnboundCandidateItem[] = [];
  const unknown: CatchUpUnknownItem[] = [];
  for (const category of classified) {
    if (category === undefined) continue;
    if (category.kind === "blocked") blocked.push(category.item);
    else if (category.kind === "unbound-candidate") unboundCandidates.push(category.item);
    else unknown.push(category.item);
  }
  // Add external unbound candidates to the same list (both internal and external are reported together)
  unboundCandidates.push(...externalUnboundCandidates);
  return { blocked, unboundCandidates, unknown };
}

// ============================================================================
// Flow 194 / issue #391 backstop: SAC-owned paths (wiki/memory/skill) that
// picked up durable content with no SAC receipt behind it — see
// `CatchUpUnreviewedPathItem`'s doc comment above for the full rationale.
// ============================================================================

/** How long after a session's last-seen timestamp a file mtime still counts
 * as "during this session" — covers the write flushing to disk shortly after
 * the session's last recorded activity, not a meaningfully different window. */
const SESSION_ATTRIBUTION_SLACK_MS = 5 * 60_000;

type OwnerReceiptLike = { targetRef?: unknown };

/**
 * Every `<owner>-write-receipts/*.json` file across every workspace under
 * `cwd`, as the set of `targetRef`s (workspace-relative under `.metaproject/`,
 * e.g. `wiki/decisions/sac-abc.md`) a real accepted SAC proposal already
 * legitimately wrote — the SAME receipts `wiki-owner-writer.ts` /
 * `memory-owner-writer.ts` / `skill-owner-writer.ts` write via `persist()`.
 * A path in this set is proven reviewed; anything else this scan finds is not.
 */
async function collectReceiptTargets(cwd: string, owner: "wiki" | "memory" | "skill"): Promise<Set<string>> {
  const targets = new Set<string>();
  const workspacesDir = path.join(cwd, ".metaproject", "workspaces");
  let workspaceIds: string[];
  try {
    workspaceIds = (await readdir(workspacesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return targets; // no workspaces dir yet — nothing has ever been reviewed
  }
  for (const workspaceId of workspaceIds) {
    const receiptsDir = path.join(workspacesDir, workspaceId, `${owner}-write-receipts`);
    let files: string[];
    try {
      files = (await readdir(receiptsDir)).filter((name) => name.endsWith(".json"));
    } catch {
      continue; // this workspace never had this owner write anything
    }
    for (const file of files) {
      const result = readConfigFile(path.join(receiptsDir, file));
      if (!result.ok) continue; // malformed/oversized — never block the scan
      try {
        const receipt = JSON.parse(result.text) as OwnerReceiptLike;
        if (typeof receipt.targetRef === "string") {
          targets.add(receipt.targetRef.replace(/^\.\//, ""));
        }
      } catch {
        continue;
      }
    }
  }
  return targets;
}

/** Best-effort: which of `sessions` (already `cwd`-scoped, newest-first) was
 * active when `absolutePath` last changed. `undefined` when no session's
 * window covers the mtime (e.g. content that predates session tracking, or a
 * stat failure) — such items are never reported, so this backstop only ever
 * flags a change it can actually attribute to a real session (AC2's "a
 * session where..."), never every pre-existing accepted page in the repo. */
async function attributeToSession(
  absolutePath: string,
  sessionsNewestFirst: readonly SessionSummary[],
): Promise<{ sessionId: string; workspaceId: string | undefined; changedAt: string } | undefined> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(absolutePath)).mtimeMs;
  } catch {
    return undefined;
  }
  for (const session of sessionsNewestFirst) {
    const start = Date.parse(session.createdAt);
    const end = Date.parse(session.updatedAt);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    if (mtimeMs >= start && mtimeMs <= end + SESSION_ATTRIBUTION_SLACK_MS) {
      const workspaceId = (await safeReadSlate(sessionDir(session.projectPath, session.id)))?.workspaceId;
      return { sessionId: session.id, workspaceId, changedAt: new Date(mtimeMs).toISOString() };
    }
  }
  return undefined;
}

/** Recursively finds every `SKILL.md` under `dir` (small, bounded trees —
 * `.metaproject/project-skills/sac/`, not the whole repo). */
async function findSkillFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findSkillFiles(full)));
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      found.push(full);
    }
  }
  return found;
}

/**
 * The backstop itself (AC2): scans wiki + memory for `Status: accepted`
 * content, and the SAC-reserved `project-skills/sac/` module for any skill at
 * all, each cross-checked against that owner's real SAC receipts
 * (`collectReceiptTargets`). Anything both "looks durable/reviewed" and
 * "has no receipt" is attributed to whichever `cwd`-scoped session was active
 * when it last changed (`attributeToSession`) and reported.
 *
 * Skill is intentionally narrower than wiki/memory: a normal `keryx skills
 * create` (any module) is common, everyday, non-SAC activity — scanning it
 * broadly the way wiki/memory are scanned would flood this report with
 * routine noise. `project-skills/sac/` is different: `skill-owner-writer.ts`
 * says outright that "every SAC-derived skill lands under the fixed `sac`
 * module so it is always distinguishable from a skill a person created via
 * `keryx skills create` directly" — so ANYTHING under that specific module
 * with no matching receipt is, by that module's own stated purpose, exactly
 * this bug's shape: something impersonating (or bypassing) an SAC-reviewed
 * skill. Wiki/memory have no such reserved-namespace convention to lean on,
 * so they get the broader "any accepted content, no receipt" check instead —
 * the one that would have caught the original `wiki enrich` repro directly.
 */
async function detectUnreviewedSacPathChanges(
  cwd: string,
  sessions: readonly SessionSummary[],
): Promise<CatchUpUnreviewedPathItem[]> {
  const scoped = [...sessions]
    .filter((session) => session.projectPath === cwd)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  if (scoped.length === 0) return [];

  const [wikiReceipts, memoryReceipts, skillReceipts] = await Promise.all([
    collectReceiptTargets(cwd, "wiki"),
    collectReceiptTargets(cwd, "memory"),
    collectReceiptTargets(cwd, "skill"),
  ]);

  const items: CatchUpUnreviewedPathItem[] = [];

  const wikiPages = await collectPages(cwd).catch(() => []);
  for (const page of wikiPages) {
    if ((page.status ?? "").toLowerCase() !== "accepted") continue;
    const targetRef = `wiki/${page.relativePath}`;
    if (wikiReceipts.has(targetRef)) continue;
    const attribution = await attributeToSession(page.absolutePath, scoped);
    if (attribution === undefined) continue;
    items.push({
      type: "unreviewed-sac-path",
      sessionId: attribution.sessionId,
      ...(attribution.workspaceId !== undefined ? { workspaceId: attribution.workspaceId } : {}),
      owner: "wiki",
      path: targetRef,
      ...(page.status !== null ? { status: page.status } : {}),
      changedAt: attribution.changedAt,
    });
  }

  const memoryEntries = await collectEntries(cwd).catch(() => []);
  for (const entry of memoryEntries) {
    if (entry.status !== "accepted") continue;
    const targetRef = `memory/${entry.relativePath}`;
    if (memoryReceipts.has(targetRef)) continue;
    const attribution = await attributeToSession(entry.absolutePath, scoped);
    if (attribution === undefined) continue;
    items.push({
      type: "unreviewed-sac-path",
      sessionId: attribution.sessionId,
      ...(attribution.workspaceId !== undefined ? { workspaceId: attribution.workspaceId } : {}),
      owner: "memory",
      path: targetRef,
      status: entry.status,
      changedAt: attribution.changedAt,
    });
  }

  const sacSkillsDir = path.join(cwd, ".metaproject", "project-skills", "sac");
  const skillFiles = await findSkillFiles(sacSkillsDir);
  for (const absolutePath of skillFiles) {
    const targetRef = path
      .relative(path.join(cwd, ".metaproject"), absolutePath)
      .split(path.sep)
      .join("/");
    if (skillReceipts.has(targetRef)) continue;
    const attribution = await attributeToSession(absolutePath, scoped);
    if (attribution === undefined) continue;
    items.push({
      type: "unreviewed-sac-path",
      sessionId: attribution.sessionId,
      ...(attribution.workspaceId !== undefined ? { workspaceId: attribution.workspaceId } : {}),
      owner: "skill",
      path: targetRef,
      changedAt: attribution.changedAt,
    });
  }

  return items;
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
