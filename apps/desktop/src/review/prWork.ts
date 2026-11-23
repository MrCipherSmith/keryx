import { boundSessions, sessionFlags, type SessionInfo, type SessionSubject } from "../acp/types";
import { byUpdatedDesc, STATUS_LABEL } from "../flows/model";
import type { FlowCard } from "../platform/commands";
import type { ReviewCard } from "./types";

/** Where "Open in session" goes: the newest bound session, a new bound one, or the named session. */
export type SubjectSessionTarget = "latest" | "new" | string;

/** The Subject of a PR card on the board of `repo` (`owner/name`). */
export function prSubject(card: Pick<ReviewCard, "number" | "url">, repo: string, repositoryId?: string): SessionSubject {
  return { kind: "pr", repo, number: card.number, url: card.url, ...(repositoryId ? { repositoryId } : {}) };
}

export { boundSessions };

/**
 * The sessions Desktop shows: the stored list plus the bindings still waiting for keryx to store a new
 * session (it lists one only after its first save). A pending binding wins over a stored flag set
 * without a subject, so the card shows the session it just opened.
 */
export function withPendingSubjects(sessions: readonly SessionInfo[], pending: ReadonlyMap<string, SessionSubject>): SessionInfo[] {
  if (!pending.size) return [...sessions];
  const seen = new Set<string>();
  const merged = sessions.map(s => {
    seen.add(s.sessionId);
    const subject = pending.get(s.sessionId);
    if (!subject || sessionFlags(s).subject) return s;
    return { ...s, _meta: { ...s._meta, keryx: { ...sessionFlags(s), subject } } };
  });
  const fresh = [...pending].filter(([id]) => !seen.has(id))
    .map(([sessionId, subject]): SessionInfo => ({ sessionId, cwd: "", title: null, updatedAt: null, _meta: { keryx: { subject } } }));
  return [...fresh, ...merged];
}

const samePrUrl = (a: string | null | undefined, b: string) => !!a && a.replace(/\/$/, "").toLowerCase() === b.replace(/\/$/, "").toLowerCase();

/** The Flows of a PR: a Flow whose `prUrl` is the PR, or the Flow of a session bound to it. Newest first. */
export function prFlows(card: Pick<ReviewCard, "url">, flows: readonly FlowCard[], bound: readonly SessionInfo[]): FlowCard[] {
  const dirs = new Set(bound.map(s => sessionFlags(s).flow).filter((dir): dir is string => !!dir));
  return flows.filter(flow => samePrUrl(flow.prUrl, card.url) || dirs.has(flow.dir)).sort(byUpdatedDesc);
}

/** The Flow's stage as the Flows board names it. */
export function flowStage(flow: Pick<FlowCard, "status" | "blocked">): string {
  if (flow.blocked || flow.status === "blocked") return STATUS_LABEL.blocked ?? "Blocked";
  return STATUS_LABEL[flow.status] ?? flow.status;
}

/**
 * The state the review slot names, from the card's local review; null when it has none. Stage 1
 * shows the state only: no round number and no behind count.
 */
export function reviewSlotState(badge: ReviewCard["localReview"]): string | null {
  if (!badge) return null;
  if (badge.awaitingAnswer) return "needs your answer";
  if (badge.publicationPending) return "publication pending";
  switch (badge.runState) {
    case "queued": return "queued";
    case "running": case "cancelling": return "running";
    case "completed": case "budget": return "ready";
    case "partial": return "partial";
    case "failed": case "blocked": return "failed";
    case "cancelled": case "skipped": return "stopped";
    case "other-revision": return "outdated";
    default: break;
  }
  if (badge.active) return "running";
  if (badge.ready) return "ready";
  if (badge.outdated) return "outdated";
  return null;
}

/** The composer text "Create Flow" prefills: names the PR, never sent. */
export function flowPrompt(url: string): string {
  return `Create a Keryx flow for ${url} with flow-orchestrator.`;
}

/** The target `/review` opens with: the one typed, else the PR the session is bound to. */
export function reviewLaunchTarget(typed: string | undefined, subject: SessionSubject | undefined): string | undefined {
  if (typed?.trim()) return typed;
  return subject?.kind === "pr" ? subject.url : typed;
}

/** "Create Flow" waiting for its package: the session that was asked, and the packages that existed then. */
export interface PendingFlowLink {
  sessionId: string;
  knownDirs: ReadonlySet<string>;
}

export type FlowLinkStep = { action: "wait" } | { action: "link"; dir: string } | { action: "clear" };

/**
 * What to do with a pending "Create Flow" once the flow list changes: link the one new package; link
 * none when several appeared (which one is the session's cannot be told) or when the session already has a Flow.
 */
export function resolveFlowLink(pending: PendingFlowLink, dirs: readonly string[], sessionFlow: string | undefined): FlowLinkStep {
  if (sessionFlow) return { action: "clear" };
  const fresh = [...new Set(dirs)].filter(dir => !pending.knownDirs.has(dir));
  if (!fresh.length) return { action: "wait" };
  return fresh.length === 1 && fresh[0] ? { action: "link", dir: fresh[0] } : { action: "clear" };
}

/** What "Open in session" needs from the app; injected so it can be tested without keryx. */
export interface SubjectSessionDeps {
  /** The sessions as Desktop shows them now, pending bindings included. */
  sessions: () => readonly SessionInfo[];
  loadSession: (id: string) => Promise<void>;
  /** A new session, shown; null when none could be started. */
  newSession: () => Promise<string | null>;
  /** Bind the new session to the subject (pending until keryx stores it). */
  bind: (id: string, subject: SessionSubject) => void;
  /** Prefill the composer; never sends. */
  fill: (text: string) => void;
}

/**
 * Open the session for a Subject: the newest non-archived bound session for "latest", the named one, or a
 * new bound session for "new" or when none is bound. A new session gets `prompt` in its composer; an
 * existing one keeps its draft unless `prefillExisting` is set. Resolves the shown session, or null.
 */
export async function openSubjectSession(deps: SubjectSessionDeps, subject: SessionSubject, target: SubjectSessionTarget,
  prompt: string, prefillExisting = false): Promise<string | null> {
  const bound = boundSessions(deps.sessions(), subject);
  const existing = target === "latest" ? bound[0]?.sessionId : target === "new" ? undefined : bound.find(s => s.sessionId === target)?.sessionId;
  if (existing) {
    await deps.loadSession(existing);
    if (prefillExisting) deps.fill(prompt);
    return existing;
  }
  const id = await deps.newSession();
  if (!id) return null;
  deps.bind(id, subject);
  deps.fill(prompt);
  return id;
}
