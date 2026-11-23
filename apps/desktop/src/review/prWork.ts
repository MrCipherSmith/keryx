import { boundSessionIndex, boundSessions, sessionFlags, subjectKey, type SessionInfo, type SessionSubject } from "../acp/types";
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

/** A PR URL as compared: no trailing slash, no case. */
const prUrlKey = (url: string) => url.replace(/\/$/, "").toLowerCase();

/** The Flows of a PR found through a prebuilt index of the project's Flows; see `prFlows`. */
export type PrFlowLookup = (card: Pick<ReviewCard, "url">, bound: readonly SessionInfo[]) => FlowCard[];

/**
 * The one rule for "which Flows belong to this PR", indexed once per Flow list: a Flow whose `prUrl` is the
 * PR (no trailing slash, no case), or the Flow of a session bound to it. Newest first.
 */
export function prFlowIndex(flows: readonly FlowCard[]): PrFlowLookup {
  const byUrl = new Map<string, FlowCard[]>();
  const byDir = new Map<string, FlowCard>();
  for (const flow of flows) {
    if (!byDir.has(flow.dir)) byDir.set(flow.dir, flow);
    if (!flow.prUrl) continue;
    const key = prUrlKey(flow.prUrl);
    const named = byUrl.get(key);
    if (named) named.push(flow);
    else byUrl.set(key, [flow]);
  }
  return (card, bound) => {
    const found = new Set(byUrl.get(prUrlKey(card.url)));
    for (const session of bound) {
      const dir = sessionFlags(session).flow;
      const flow = dir === undefined ? undefined : byDir.get(dir);
      if (flow) found.add(flow);
    }
    return [...found].sort(byUpdatedDesc);
  };
}

/** The Flows of a PR: a Flow whose `prUrl` is the PR, or the Flow of a session bound to it. Newest first. */
export function prFlows(card: Pick<ReviewCard, "url">, flows: readonly FlowCard[], bound: readonly SessionInfo[]): FlowCard[] {
  return prFlowIndex(flows)(card, bound);
}

/** What the PR work rows look up, built once per sessions and Flows change instead of once per card. */
export interface PrWorkIndex {
  /** `boundSessions(sessions, subject)`. */
  sessions: (subject: SessionSubject) => readonly SessionInfo[];
  /** `prFlows(card, flows, bound)`. */
  flows: PrFlowLookup;
}

export function prWorkIndex(flows: readonly FlowCard[], sessions: readonly SessionInfo[]): PrWorkIndex {
  return { sessions: boundSessionIndex(sessions), flows: prFlowIndex(flows) };
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

/**
 * How long a "Create Flow" request waits for its package: 15 minutes from the press. The prompt is only
 * prefilled, so the window covers sending it and the orchestrator creating the package early in its turn;
 * a package that appears later (another window, the CLI, the Issues board) is not linked.
 */
export const FLOW_LINK_WINDOW_MS = 15 * 60_000;

/** "Create Flow" waiting for its package: the session that was asked, the packages that existed then, and when it expires. */
export interface PendingFlowLink {
  sessionId: string;
  knownDirs: ReadonlySet<string>;
  /** Epoch ms; at or after it the request is dropped unlinked. */
  expiresAt: number;
}

/** One pass over the pending requests: those still waiting, and the links to write. */
export interface FlowLinkPass {
  pending: PendingFlowLink[];
  links: Array<{ sessionId: string; dir: string }>;
}

/**
 * What to do with the pending "Create Flow" requests once the flow list changes. A package is linked only
 * when exactly one request is pending and exactly one package appeared since it was recorded: which package
 * belongs to which request cannot be told otherwise, so several new packages or several pending requests
 * link none and end every request. An expired request, or one whose session already has a Flow, ends
 * unlinked. A package in `claimed` (already linked to a request) is never a candidate again.
 */
export function resolveFlowLinks(pending: readonly PendingFlowLink[], dirs: readonly string[],
  sessionFlow: (sessionId: string) => string | undefined, claimed: ReadonlySet<string>, now: number): FlowLinkPass {
  const live = pending.filter(entry => entry.expiresAt > now && !sessionFlow(entry.sessionId));
  const candidates = [...new Set(dirs)].filter(dir => !claimed.has(dir));
  const freshFor = (entry: PendingFlowLink) => candidates.filter(dir => !entry.knownDirs.has(dir));
  if (!live.some(entry => freshFor(entry).length)) return { pending: live, links: [] };
  const only = live.length === 1 ? live[0] : undefined;
  const fresh = only ? freshFor(only) : [];
  return { pending: [], links: only && fresh.length === 1 && fresh[0] ? [{ sessionId: only.sessionId, dir: fresh[0] }] : [] };
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

/**
 * `openSubjectSession` with one open per Subject at a time: a repeat call for the same Subject while an
 * open is in flight (a second press before `session/new` answers) gets that open's promise, whatever its
 * target or prompt, so it cannot start a second bound session.
 */
export function subjectOpener(): typeof openSubjectSession {
  const inFlight = new Map<string, Promise<string | null>>();
  return (deps, subject, target, prompt, prefillExisting = false) => {
    const key = subjectKey(subject);
    const running = inFlight.get(key);
    if (running) return running;
    const open = openSubjectSession(deps, subject, target, prompt, prefillExisting).finally(() => inFlight.delete(key));
    inFlight.set(key, open);
    return open;
  };
}
