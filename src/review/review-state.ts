// Desktop Review v3, stage 1 (docs/requirements/keryx-desktop-review-v3/specification.md, «Хранение», «Схема review.json»,
// «Состояние Review», «Состояние раунда», «Правило номера раунда (R5)»): the durable review.json of one pull request's
// review and the only code that writes it. Every write holds the review directory's file lock, replaces review.json
// atomically, sets updatedAt and appends exactly one line to journal.md beside it.
import { appendFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isPathInside, toPosix, withFileLock, writeFileAtomic } from "../lib/fs";
import { REVIEW_STATE_DIR, REVIEW_STATE_FILE, REVIEW_STATE_JOURNAL, reviewStateId, reviewStateRelativeDir } from "./review-state-id";

export const REVIEW_SCHEMA = "keryx.review";
export const REVIEW_SCHEMA_VERSION = 1;

export type Verdict = "approve" | "comment" | "request-changes";
export type ReviewLifecycle = "draft" | "reviewing" | "ready" | "published" | "stale" | "closed";
export type RoundState = "planning" | "dispatching" | "reconciling" | "ready" | "paused";
export type OnHeadMove = "ask" | "follow" | "ignore";
export type ReviewSource = "desktop" | "session" | "scheduled";
export type ReviewerState = "running" | "done" | "failed";

export const VERDICTS: readonly Verdict[] = ["approve", "comment", "request-changes"];
export const ROUND_STATES: readonly RoundState[] = ["planning", "dispatching", "reconciling", "ready", "paused"];
export const ON_HEAD_MOVE: readonly OnHeadMove[] = ["ask", "follow", "ignore"];
export const REVIEW_SOURCES: readonly ReviewSource[] = ["desktop", "session", "scheduled"];
export const REVIEWER_STATES: readonly ReviewerState[] = ["running", "done", "failed"];

export interface RoundPlan { slices: number; waves: number; assignments: { done: number; total: number } }
export interface RoundReviewer { role: string; state: ReviewerState; findings?: number }
export interface RoundUsage { tokens: number; costUsd: number | null }
export interface RoundFindings { blocker: number; major: number; minor: number; info: number; carried: number; rechecked: number }
export interface RoundSession { id: string; openedAt: string; reason: "start" | "restart" }

export interface ReviewRound {
  number: number;
  baseSha: string;
  headSha: string;
  settingsKey: string | null;
  state: RoundState;
  previousRound: number | null;
  package: string | null;
  sessionId: string | null;
  sessions: RoundSession[];
  plan: RoundPlan | null;
  reviewers: RoundReviewer[];
  usage: RoundUsage;
  findings: RoundFindings | null;
  verdict: Verdict | null;
  openedAt: string;
  updatedAt: string;
}

export interface ReviewPublication { round: number; headSha: string; verdict: Verdict; url?: string; at: string }

export interface ReviewRecord {
  schema: typeof REVIEW_SCHEMA;
  version: typeof REVIEW_SCHEMA_VERSION;
  id: string;
  pr: { repo: string; number: number; url: string; repositoryId?: string };
  viewer: string | null;
  state: ReviewLifecycle;
  onHeadMove: OnHeadMove;
  source: ReviewSource;
  createdAt: string;
  updatedAt: string;
  rounds: ReviewRound[];
  publications: ReviewPublication[];
  migratedFrom?: { store: "runs.sqlite"; reviewId: string; runIds: string[] };
}

/**
 * Why a review.json call failed. `refused`, `not-found` and `invalid` are answers (the CLI exits 1); `foreign` (another
 * schema or version, never rewritten) and `unreadable` (not JSON, or not a review) mean the store cannot tell (exit 2).
 */
export type ReviewStateErrorCode = "refused" | "not-found" | "invalid" | "foreign" | "unreadable";

export class ReviewStateError extends Error {
  constructor(readonly code: ReviewStateErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReviewStateError";
  }
}

export interface ReviewStateOptions { now?: () => Date }

const SHA = /^[0-9a-f]{40}$/;

function iso(options: ReviewStateOptions | undefined): string {
  return (options?.now?.() ?? new Date()).toISOString();
}

function fullSha(value: string, what: string): string {
  const sha = value.trim().toLowerCase();
  if (!SHA.test(sha)) throw new ReviewStateError("invalid", `${what} must be a full 40-character SHA, got "${value}"`);
  return sha;
}

function reviewDir(projectRoot: string, id: string): string {
  return path.join(projectRoot, reviewStateRelativeDir(id));
}

export function reviewStatePath(projectRoot: string, id: string): string {
  return path.join(reviewDir(projectRoot, id), REVIEW_STATE_FILE);
}

export function reviewJournalPath(projectRoot: string, id: string): string {
  return path.join(reviewDir(projectRoot, id), REVIEW_STATE_JOURNAL);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse review.json text. A foreign schema/version and a non-review are errors, so nothing downstream rewrites them. */
function parseRecord(text: string, file: string): ReviewRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ReviewStateError("unreadable", `${file} is not valid JSON`, { cause: error });
  }
  if (!isObject(value)) throw new ReviewStateError("unreadable", `${file} is not a review record`);
  if (value.schema !== REVIEW_SCHEMA || value.version !== REVIEW_SCHEMA_VERSION) {
    throw new ReviewStateError(
      "foreign",
      `${file} has schema ${JSON.stringify(value.schema)} version ${JSON.stringify(value.version)}; this keryx reads ${REVIEW_SCHEMA} version ${REVIEW_SCHEMA_VERSION} and leaves it unchanged`,
    );
  }
  if (typeof value.id !== "string" || !isObject(value.pr) || !Array.isArray(value.rounds) || !Array.isArray(value.publications)) {
    throw new ReviewStateError("unreadable", `${file} is missing id, pr, rounds or publications`);
  }
  return value as unknown as ReviewRecord;
}

async function readRecordFile(file: string): Promise<ReviewRecord | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ReviewStateError("unreadable", `cannot read ${file}`, { cause: error });
  }
  return parseRecord(text, file);
}

/** The review, or `null` when it has no review.json. A foreign schema/version or a broken file throws ReviewStateError. */
export async function readReviewState(projectRoot: string, id: string): Promise<ReviewRecord | null> {
  return readRecordFile(reviewStatePath(projectRoot, id));
}

async function requireReview(projectRoot: string, id: string): Promise<ReviewRecord> {
  const review = await readReviewState(projectRoot, id);
  if (!review) throw new ReviewStateError("not-found", `no review ${id} (${reviewStateRelativeDir(id)}/${REVIEW_STATE_FILE})`);
  return review;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Read-modify-write of one review under its lock: `change` returns the next record (or null for "write nothing to
 * review.json") and the journal summary. Exactly one journal line is appended per call.
 */
async function writeReview<T>(
  projectRoot: string,
  id: string,
  verb: string,
  options: ReviewStateOptions | undefined,
  change: (current: ReviewRecord | null, at: string) => { next: ReviewRecord | null; summary: string; result: T },
): Promise<T> {
  const dir = reviewDir(projectRoot, id);
  return withFileLock(path.join(dir, ".lock"), async () => {
    const current = await readReviewState(projectRoot, id);
    const at = iso(options);
    const { next, summary, result } = change(current, at);
    if (next) {
      next.updatedAt = at;
      await writeFileAtomic(path.join(dir, REVIEW_STATE_FILE), `${JSON.stringify(next, null, 2)}\n`);
    }
    // One append is one line: the journal stays readable when two processes write in turn.
    await appendFile(path.join(dir, REVIEW_STATE_JOURNAL), `- ${at} ${verb} ${oneLine(summary)}\n`, "utf8");
    return result;
  });
}

function currentRound(review: ReviewRecord): ReviewRound | undefined {
  return review.rounds[review.rounds.length - 1];
}

function isPublished(review: ReviewRecord, round: ReviewRound): boolean {
  return review.publications.some((publication) => publication.round === round.number && publication.headSha === round.headSha);
}

/** The state the rounds and publications imply, ignoring the out-of-round marks (stale, closed). */
function derivedState(review: ReviewRecord): ReviewLifecycle {
  const round = currentRound(review);
  if (!round) return "draft";
  if (isPublished(review, round)) return "published";
  return round.state === "ready" ? "ready" : "reviewing";
}

function settingsMatch(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

function addSession(round: ReviewRound, sessionId: string, at: string): void {
  round.sessions.push({ id: sessionId, openedAt: at, reason: round.sessions.length === 0 ? "start" : "restart" });
  round.sessionId = sessionId;
}

export interface OpenRoundInput {
  pr: { repo: string; number: number; url: string; repositoryId?: string };
  viewer?: string | null;
  baseSha: string;
  headSha: string;
  settingsKey?: string | null;
  sessionId?: string | null;
  source?: ReviewSource;
  onHeadMove?: OnHeadMove;
  reopen?: boolean;
}

export type OpenAction = "created" | "reused" | "advanced";
export interface OpenRoundResult { review: ReviewRecord; round: ReviewRound; action: OpenAction }

/**
 * `keryx review state open`: create the review on the first call and apply the round rule R5 against the LAST round
 * only (an older round with the same revision is not resurrected: going back to it is a new round).
 * - no rounds: round 1, `created`;
 * - last round has the same base and head and a matching settings key (null matches anything): `reused`, the round's
 *   state is untouched, and a session other than the current one is appended (`restart`) and becomes current;
 * - otherwise round N+1 with previousRound N, `advanced`, and the review goes back to `reviewing` (also out of stale).
 * A closed review is refused unless `reopen`. A reused round keeps the review's state, except that a reopened closed
 * review takes the state its rounds imply.
 */
export async function openReviewRound(projectRoot: string, input: OpenRoundInput, options?: ReviewStateOptions): Promise<OpenRoundResult> {
  const baseSha = fullSha(input.baseSha, "base");
  const headSha = fullSha(input.headSha, "head");
  const viewer = input.viewer?.trim() || null;
  const settingsKey = input.settingsKey?.trim() || null;
  const sessionId = input.sessionId?.trim() || null;
  const id = reviewStateId(input.pr.repo, input.pr.number, viewer);

  return writeReview<OpenRoundResult>(projectRoot, id, "open", options, (current, at) => {
    if (current?.state === "closed" && !input.reopen) {
      throw new ReviewStateError("refused", `review ${id} is closed; pass --reopen to open a round on it`);
    }
    const review: ReviewRecord = current ?? {
      schema: REVIEW_SCHEMA,
      version: REVIEW_SCHEMA_VERSION,
      id,
      pr: { ...input.pr },
      viewer,
      state: "draft",
      onHeadMove: input.onHeadMove ?? "ask",
      source: input.source ?? "session",
      createdAt: at,
      updatedAt: at,
      rounds: [],
      publications: [],
    };
    review.pr.url = input.pr.url;
    if (input.pr.repositoryId) review.pr.repositoryId = input.pr.repositoryId;
    // The source is who created the review and stays; the head-move policy is a setting a later open may change.
    if (current && input.onHeadMove) review.onHeadMove = input.onHeadMove;
    const reopened = current?.state === "closed";

    const last = currentRound(review);
    if (last && last.baseSha === baseSha && last.headSha === headSha && settingsMatch(last.settingsKey, settingsKey)) {
      if (last.settingsKey === null && settingsKey !== null) last.settingsKey = settingsKey;
      const restarted = sessionId !== null && sessionId !== last.sessionId;
      if (restarted) addSession(last, sessionId, at);
      last.updatedAt = at;
      if (reopened) review.state = derivedState(review);
      return {
        next: review,
        summary: `round ${last.number} reused (${last.state})${restarted ? `, session ${sessionId}` : ""}${reopened ? ", reopened" : ""}`,
        result: { review, round: last, action: "reused" },
      };
    }

    const round: ReviewRound = {
      number: last ? last.number + 1 : 1,
      baseSha,
      headSha,
      settingsKey,
      state: "planning",
      previousRound: last ? last.number : null,
      package: null,
      sessionId: null,
      sessions: [],
      plan: null,
      reviewers: [],
      usage: { tokens: 0, costUsd: null },
      findings: null,
      verdict: null,
      openedAt: at,
      updatedAt: at,
    };
    if (sessionId) addSession(round, sessionId, at);
    review.rounds.push(round);
    review.state = "reviewing";
    const action: OpenAction = last ? "advanced" : "created";
    return {
      next: review,
      summary: `round ${round.number} ${action} ${baseSha.slice(0, 12)}..${headSha.slice(0, 12)}${sessionId ? `, session ${sessionId}` : ""}${reopened ? ", reopened" : ""}`,
      result: { review, round, action },
    };
  });
}

export interface RoundPatch {
  round?: number;
  state?: RoundState;
  package?: string;
  sessionId?: string;
  plan?: RoundPlan;
  reviewers?: RoundReviewer[];
  usage?: RoundUsage;
  findings?: RoundFindings;
  verdict?: Verdict;
}

const FORWARD: readonly RoundState[] = ["planning", "dispatching", "reconciling", "ready"];

/**
 * The round transitions. Forward along planning → dispatching → reconciling → ready, skipping a step allowed (the spec:
 * a missed call is recovered by the next one); `paused` from any state but ready; out of `paused` only to planning,
 * dispatching or reconciling; nothing out of `ready`. Staying in the same state is a no-op, so a repeated call is safe.
 */
export function roundTransitionAllowed(from: RoundState, to: RoundState): boolean {
  if (from === to) return true;
  if (from === "ready") return false;
  if (to === "paused") return true;
  if (from === "paused") return to === "planning" || to === "dispatching" || to === "reconciling";
  return FORWARD.indexOf(to) > FORWARD.indexOf(from);
}

/** The fields a ready round still takes: what the final report and the bill say about it. */
const READY_ROUND_FIELDS: ReadonlySet<keyof RoundPatch> = new Set(["round", "verdict", "findings", "usage"]);

function projectRelativePackage(projectRoot: string, dir: string): string {
  const absolute = path.resolve(projectRoot, dir);
  if (!isPathInside(projectRoot, absolute) || path.resolve(projectRoot) === absolute) {
    throw new ReviewStateError("invalid", `package ${dir} is not a directory inside the project`);
  }
  return toPosix(path.relative(path.resolve(projectRoot), absolute));
}

function describePatch(patch: RoundPatch): string {
  const parts: string[] = [];
  if (patch.state) parts.push(`state ${patch.state}`);
  if (patch.package) parts.push(`package ${patch.package}`);
  if (patch.sessionId) parts.push(`session ${patch.sessionId}`);
  if (patch.plan) parts.push(`plan ${patch.plan.slices},${patch.plan.waves},${patch.plan.assignments.done}/${patch.plan.assignments.total}`);
  for (const reviewer of patch.reviewers ?? []) parts.push(`${reviewer.role}=${reviewer.state}${reviewer.findings === undefined ? "" : `:${reviewer.findings}`}`);
  if (patch.usage) parts.push(`usage ${patch.usage.tokens}${patch.usage.costUsd === null ? "" : `,${patch.usage.costUsd}`}`);
  if (patch.findings) {
    const f = patch.findings;
    parts.push(`findings ${f.blocker},${f.major},${f.minor},${f.info},${f.carried},${f.rechecked}`);
  }
  if (patch.verdict) parts.push(`verdict ${patch.verdict}`);
  return parts.join(", ") || "touched";
}

/**
 * `keryx review state round`: update one round (the current one by default). A ready round takes only verdict,
 * findings and usage (a repeated `--state ready` is a no-op). The review state follows its current round
 * (ready → ready, otherwise reviewing); stale, closed and published are marks this call leaves alone, and updating an
 * older round never moves the review.
 */
export async function updateReviewRound(projectRoot: string, id: string, patch: RoundPatch, options?: ReviewStateOptions): Promise<{ review: ReviewRecord; round: ReviewRound }> {
  const pkg = patch.package === undefined ? undefined : projectRelativePackage(projectRoot, patch.package);
  const normalized: RoundPatch = { ...patch, ...(pkg !== undefined && { package: pkg }) };
  return writeReview(projectRoot, id, "round", options, (current, at) => {
    if (!current) throw new ReviewStateError("not-found", `no review ${id}`);
    const round = patch.round === undefined ? currentRound(current) : current.rounds.find((r) => r.number === patch.round);
    if (!round) throw new ReviewStateError("not-found", patch.round === undefined ? `review ${id} has no round` : `review ${id} has no round ${patch.round}`);

    if (round.state === "ready") {
      const refused = (Object.keys(normalized) as (keyof RoundPatch)[])
        .filter((key) => normalized[key] !== undefined && !READY_ROUND_FIELDS.has(key) && !(key === "state" && normalized.state === "ready"));
      if (refused.length > 0) {
        throw new ReviewStateError("refused", `round ${round.number} of ${id} is ready; it takes only --verdict, --findings and --usage (refused: ${refused.join(", ")})`);
      }
    }
    if (normalized.state && !roundTransitionAllowed(round.state, normalized.state)) {
      throw new ReviewStateError("refused", `round ${round.number} of ${id} cannot go from ${round.state} to ${normalized.state}`);
    }

    if (normalized.state) round.state = normalized.state;
    if (normalized.package !== undefined) round.package = normalized.package;
    if (normalized.sessionId && normalized.sessionId !== round.sessionId) addSession(round, normalized.sessionId, at);
    if (normalized.plan) round.plan = normalized.plan;
    for (const reviewer of normalized.reviewers ?? []) {
      const index = round.reviewers.findIndex((r) => r.role === reviewer.role);
      if (index === -1) round.reviewers.push(reviewer);
      else round.reviewers[index] = reviewer;
    }
    if (normalized.usage) round.usage = normalized.usage;
    if (normalized.findings) round.findings = normalized.findings;
    if (normalized.verdict) round.verdict = normalized.verdict;
    round.updatedAt = at;

    if (round === currentRound(current) && (current.state === "draft" || current.state === "reviewing" || current.state === "ready")) {
      current.state = round.state === "ready" ? "ready" : "reviewing";
    }
    return { next: current, summary: `round ${round.number} ${describePatch(normalized)}`, result: { review: current, round } };
  });
}

/**
 * `keryx review state publish`: record a publication of a round (the current one by default) at its head. The review
 * becomes `published` when the round is the current one. A closed review is refused. The round need not be ready: a
 * missed `--state ready` call must not block recording a publication that happened.
 */
export async function recordPublication(
  projectRoot: string,
  id: string,
  input: { verdict: Verdict; url?: string; round?: number },
  options?: ReviewStateOptions,
): Promise<{ review: ReviewRecord; round: ReviewRound }> {
  return writeReview(projectRoot, id, "publish", options, (current, at) => {
    if (!current) throw new ReviewStateError("not-found", `no review ${id}`);
    if (current.state === "closed") throw new ReviewStateError("refused", `review ${id} is closed`);
    const round = input.round === undefined ? currentRound(current) : current.rounds.find((r) => r.number === input.round);
    if (!round) throw new ReviewStateError("not-found", input.round === undefined ? `review ${id} has no round` : `review ${id} has no round ${input.round}`);
    current.publications.push({ round: round.number, headSha: round.headSha, verdict: input.verdict, ...(input.url && { url: input.url }), at });
    if (round === currentRound(current)) current.state = "published";
    return { next: current, summary: `round ${round.number} ${input.verdict}${input.url ? ` ${input.url}` : ""}`, result: { review: current, round } };
  });
}

export type ReviewMark = "stale" | "closed" | "ready";
export const REVIEW_MARKS: readonly ReviewMark[] = ["stale", "closed", "ready"];

/**
 * `keryx review state mark`: the review's state outside a round. `closed` from anything; `stale` needs a round and an
 * open review; `ready` clears stale without a new round and takes the state the current round implies (published,
 * ready or reviewing). A closed review is reopened only by `open --reopen`.
 */
export async function markReview(projectRoot: string, id: string, mark: ReviewMark, options?: ReviewStateOptions): Promise<{ review: ReviewRecord }> {
  return writeReview(projectRoot, id, "mark", options, (current) => {
    if (!current) throw new ReviewStateError("not-found", `no review ${id}`);
    const from = current.state;
    if (mark === "closed") {
      current.state = "closed";
    } else {
      if (from === "closed") throw new ReviewStateError("refused", `review ${id} is closed; open a round with --reopen instead`);
      if (current.rounds.length === 0) throw new ReviewStateError("refused", `review ${id} has no round to mark ${mark}`);
      current.state = mark === "stale" ? "stale" : derivedState(current);
    }
    return { next: current, summary: `${from} -> ${current.state}`, result: { review: current } };
  });
}

/** `keryx review state note`: one journal line, review.json untouched. The review must exist and be readable. */
export async function appendNote(projectRoot: string, id: string, text: string, options?: ReviewStateOptions): Promise<{ review: ReviewRecord }> {
  const line = oneLine(text);
  if (!line) throw new ReviewStateError("invalid", "a note needs text");
  return writeReview(projectRoot, id, "note", options, (current) => {
    if (!current) throw new ReviewStateError("not-found", `no review ${id}`);
    return { next: null, summary: line, result: { review: current } };
  });
}

/** Read one review, refusing a missing one. */
export async function showReviewState(projectRoot: string, id: string): Promise<ReviewRecord> {
  return requireReview(projectRoot, id);
}

export interface ReviewStateListing {
  reviews: ReviewRecord[];
  /** Directories whose review.json is foreign or broken: reported, never rewritten. */
  unreadable: { id: string; code: ReviewStateErrorCode; reason: string }[];
}

/** Every review of the project, by id. A directory with no review.json is skipped. */
export async function listReviewStates(projectRoot: string): Promise<ReviewStateListing> {
  const root = path.join(projectRoot, REVIEW_STATE_DIR);
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { reviews: [], unreadable: [] };
    throw new ReviewStateError("unreadable", `cannot list ${REVIEW_STATE_DIR}`, { cause: error });
  }
  const listing: ReviewStateListing = { reviews: [], unreadable: [] };
  for (const id of entries.sort()) {
    try {
      const review = await readRecordFile(path.join(root, id, REVIEW_STATE_FILE));
      if (review) listing.reviews.push(review);
    } catch (error) {
      if (!(error instanceof ReviewStateError)) throw error;
      listing.unreadable.push({ id, code: error.code, reason: error.message });
    }
  }
  return listing;
}
