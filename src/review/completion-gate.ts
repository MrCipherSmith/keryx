// Completion gate for a managed review run in the shell. The shell's model ends
// a turn at the first friction ("this is not the final report") and the harness
// used to accept it; a review is finished when `keryx review complete` accepts
// the package, not when the model stops writing. Deterministic: no model judges.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveActiveReview } from "./active-review";
import { reviewCompletionBlockers, reviewsRoot } from "./managed";

export const MAX_REVIEW_GATE_CONTINUES = 20;
export const MAX_REVIEW_GATE_STALLS = 3;

export type OpenManagedReview = {
  reviewId: string;
  packageDir: string;
  blockers: string[];
  /** Changes whenever the package or the working data under it gains or changes an artifact. */
  signature: string;
};

async function dirSignature(dir: string): Promise<string> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const parts: string[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      const content = entry.isDirectory()
        ? await dirSignature(file)
        : await readFile(file).then((body) => createHash("sha256").update(body).digest("hex")).catch(() => "unreadable");
      parts.push(`${entry.name}:${content}`);
    }
    return parts.join(",");
  } catch {
    return "";
  }
}

type PackageCandidate = { dir: string; mtime: number; id: string; root: string };

const METAPROJECT = ".metaproject";
const REVIEWS = "reviews";
/** A package path's prefix ends at whitespace, a quote, a shell operator or `=` (`--package=dir`). */
const PREFIX_DELIMITERS = new Set([..."\"'`<>|;&()="]);
/** The longest prefix walked back from `.metaproject`: a longer one is not a package path the session named. */
const MAX_PREFIX_CHARS = 1024;
const MAX_NAME_CHARS = 255;
/** The most recent project roots the gate scans: each one costs directory reads on every stop. */
export const MAX_SESSION_REVIEW_ROOTS = 8;
const MAX_SESSION_REVIEW_PACKAGES = 32;
const MAX_SESSION_REVIEW_COMMANDS = 64;
/** A review id fit to quote in a harness nudge or to match as a token. */
const SAFE_REVIEW_ID = /^[A-Za-z0-9._:-]{1,120}$/;

const isPathDelimiter = (ch: string): boolean => PREFIX_DELIMITERS.has(ch) || /\s/.test(ch);
const isSeparator = (ch: string | undefined): boolean => ch === "/" || ch === "\\";

/**
 * Every `<prefix>.metaproject/reviews/<name>` in `text`, in linear time: each occurrence of the literal is found
 * with indexOf, the prefix is walked back to the nearest delimiter (never past the previous match and never more
 * than {@link MAX_PREFIX_CHARS}), and the name is walked forward. No regex runs over the whole text.
 */
export function reviewPackagePaths(text: string): Array<{ prefix: string; name: string }> {
  const found: Array<{ prefix: string; name: string }> = [];
  let from = 0;
  let floor = 0;
  for (;;) {
    const at = text.indexOf(METAPROJECT, from);
    if (at < 0) return found;
    const sep = at + METAPROJECT.length;
    from = sep;
    if (!isSeparator(text[sep]) || !text.startsWith(REVIEWS, sep + 1) || !isSeparator(text[sep + 1 + REVIEWS.length])) continue;
    const nameStart = sep + REVIEWS.length + 2;
    let end = nameStart;
    while (end < text.length && end - nameStart < MAX_NAME_CHARS && !isSeparator(text[end]) && !isPathDelimiter(text[end]!)) end += 1;
    if (end === nameStart) continue;
    let start = at;
    while (start > floor && at - start < MAX_PREFIX_CHARS && !isPathDelimiter(text[start - 1]!)) start -= 1;
    found.push({ prefix: text.slice(start, at), name: text.slice(nameStart, end) });
    from = end;
    floor = end;
  }
}

/** What this session's own `keryx review` commands named. The gate looks only here, never at arbitrary tool output. */
export type SessionReviewNames = {
  /** Project roots (the directory holding `.metaproject`) inside `cwd`, other than `cwd`: the newest {@link MAX_SESSION_REVIEW_ROOTS}. */
  roots: readonly string[];
  /** Absolute package directories named by path. */
  packageDirs: readonly string[];
  /** Review ids keryx itself printed in reply to this session's commands (`# managed review: <id>`). */
  reviewIds: readonly string[];
  /** The arguments of this session's `keryx review` tool calls, newest last: a review id named there counts as named. */
  commands: readonly string[];
};

type HistoryMessage = {
  role?: string | undefined;
  content?: unknown;
  toolCallId?: string | undefined;
  toolCalls?: ReadonlyArray<{ id?: string | undefined; arguments: string }> | undefined;
};

const KERYX_REVIEW_COMMAND = /\bkeryx review\b/;
/** The lines `keryx review start|attach|ingest` prints about the package it opened. */
const OWN_OUTPUT_LINE = /^(# managed review|path): (\S.*)$/;

function remember<T>(items: Map<T, true>, item: T, cap: number): void {
  items.delete(item);
  items.set(item, true);
  if (items.size > cap) items.delete(items.keys().next().value as T);
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel.split(/[\\/]/)[0] !== ".." && !path.isAbsolute(rel));
}

/**
 * Collects {@link SessionReviewNames} from a history incrementally: `update` scans only the messages added since
 * the last call, and starts over when the history was rewritten (compacted or cleared).
 */
export class SessionReviewTracker {
  private cursor = 0;
  private last: unknown;
  private readonly pendingCalls = new Set<string>();
  private readonly roots = new Map<string, true>();
  private readonly packageDirs = new Map<string, true>();
  private readonly reviewIds = new Map<string, true>();
  private readonly commands = new Map<string, true>();

  constructor(readonly cwd: string) {}

  update(history: ReadonlyArray<HistoryMessage>): SessionReviewNames {
    if (history.length < this.cursor || (this.cursor > 0 && history[this.cursor - 1] !== this.last)) this.reset();
    for (; this.cursor < history.length; this.cursor += 1) this.scan(history[this.cursor]!);
    this.last = history[this.cursor - 1];
    return {
      roots: [...this.roots.keys()],
      packageDirs: [...this.packageDirs.keys()],
      reviewIds: [...this.reviewIds.keys()],
      commands: [...this.commands.keys()],
    };
  }

  private reset(): void {
    this.cursor = 0;
    this.last = undefined;
    this.pendingCalls.clear();
    this.roots.clear();
    this.packageDirs.clear();
    this.reviewIds.clear();
    this.commands.clear();
  }

  private scan(message: HistoryMessage): void {
    for (const call of message.toolCalls ?? []) {
      if (!KERYX_REVIEW_COMMAND.test(call.arguments)) continue;
      remember(this.commands, call.arguments, MAX_SESSION_REVIEW_COMMANDS);
      if (call.id !== undefined) this.pendingCalls.add(call.id);
      this.namePaths(call.arguments);
    }
    if (message.role !== "tool" || message.toolCallId === undefined || !this.pendingCalls.delete(message.toolCallId)) return;
    if (typeof message.content !== "string" || !message.content.includes("# managed review: ")) return;
    for (const line of message.content.split("\n")) {
      const own = OWN_OUTPUT_LINE.exec(line.trimEnd());
      if (own === null) continue;
      if (own[1] === "path") this.namePaths(own[2]!);
      else if (SAFE_REVIEW_ID.test(own[2]!)) remember(this.reviewIds, own[2]!, MAX_SESSION_REVIEW_PACKAGES);
    }
  }

  private namePaths(text: string): void {
    const cwd = path.resolve(this.cwd);
    for (const { prefix, name } of reviewPackagePaths(text)) {
      const root = path.resolve(cwd, prefix === "" ? "." : prefix);
      if (!inside(cwd, root)) continue;
      remember(this.packageDirs, path.join(root, METAPROJECT, REVIEWS, name), MAX_SESSION_REVIEW_PACKAGES);
      if (root !== cwd) remember(this.roots, root, MAX_SESSION_REVIEW_ROOTS);
    }
  }
}

const trackers = new WeakMap<object, SessionReviewTracker>();

/**
 * {@link SessionReviewNames} for `history`, cached per history array so each stop scans only the new messages.
 * Taken only from the arguments of this session's `keryx review` tool calls and from the `path:` and
 * `# managed review:` lines keryx printed in reply to them, and only for paths inside `cwd`.
 */
export function sessionReviewNames(history: ReadonlyArray<HistoryMessage>, cwd: string): SessionReviewNames {
  let tracker = trackers.get(history);
  if (tracker === undefined || tracker.cwd !== cwd) {
    tracker = new SessionReviewTracker(cwd);
    trackers.set(history, tracker);
  }
  return tracker.update(history);
}

function namesToken(text: string, token: string): boolean {
  const boundary = (ch: string | undefined): boolean => ch === undefined || !/[A-Za-z0-9._:-]/.test(ch);
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
    if (boundary(text[at - 1]) && boundary(text[at + token.length])) return true;
  }
  return false;
}

/** True when this session's own commands named the package by its path or its review id. */
function namedBySession(named: Partial<SessionReviewNames>, dir: string, ids: ReadonlyArray<string | undefined>): boolean {
  const target = path.resolve(dir);
  if ((named.packageDirs ?? []).some((p) => path.resolve(p) === target)) return true;
  for (const id of ids) {
    if (id === undefined || !SAFE_REVIEW_ID.test(id)) continue;
    if ((named.reviewIds ?? []).includes(id)) return true;
    if ((named.commands ?? []).some((command) => namesToken(command, id))) return true;
  }
  return false;
}

async function scanRoot(
  root: string,
  since: number,
  named: Partial<SessionReviewNames>,
): Promise<{ open: PackageCandidate[]; closedAt: number }> {
  let names: string[];
  try {
    names = (await readdir(reviewsRoot(root), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    names = [];
  }
  const open: PackageCandidate[] = [];
  let closedAt = 0;
  for (const name of names) {
    const dir = path.join(reviewsRoot(root), name);
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as {
        mode?: string;
        status?: string;
        reviewId?: string;
      };
      if (manifest.mode !== "review-flow" && manifest.mode !== "ingest") continue;
      const info = await stat(path.join(dir, "manifest.json"));
      if (manifest.status === "closed") {
        if (info.mtimeMs >= since) closedAt = Math.max(closedAt, info.mtimeMs);
        continue;
      }
      // An open package whose manifest predates the session is another run's (a checkout carries old drafts), unless
      // this session's own commands name it: then the session is continuing it. `ingest --review-id` flips the run's
      // own package to mode ingest, which this covers too.
      if (info.mtimeMs < since && !namedBySession(named, dir, [manifest.reviewId, name])) continue;
      open.push({ dir, mtime: info.mtimeMs, id: manifest.reviewId ?? name, root });
    } catch {
      continue;
    }
  }
  return { open, closedAt };
}

/**
 * The package this session is reviewing: the first active-review pointer that was written this session or names a
 * package this session's commands named, else the newest open candidate. An older pointer alone never wins: an
 * earlier session's pointer to another PR is how the nudge was misdirected before (flow 460 C).
 */
async function pickPackage(
  roots: readonly string[],
  candidates: readonly PackageCandidate[],
  since: number,
  named: Partial<SessionReviewNames>,
): Promise<PackageCandidate | null> {
  for (const root of roots) {
    const pointer = await resolveActiveReview(root);
    if (pointer === undefined) continue;
    const manifestPath = path.join(pointer.dir, "manifest.json");
    const manifest = await readFile(manifestPath, "utf8")
      .then((t) => JSON.parse(t) as { reviewId?: string })
      .catch((): { reviewId?: string } => ({}));
    const fresh = Date.parse(pointer.startedAt) >= since;
    if (!fresh && !namedBySession(named, pointer.dir, [pointer.id, manifest.reviewId])) continue;
    const mtime = await stat(manifestPath).then((i) => i.mtimeMs).catch(() => 0);
    return { dir: pointer.dir, mtime, id: manifest.reviewId ?? pointer.id, root };
  }
  let best: PackageCandidate | null = null;
  for (const candidate of candidates) if (best === null || candidate.mtime > best.mtime) best = candidate;
  return best;
}

/** The review id as quoted in a harness nudge: an id that is not a plain token is replaced, never rendered raw. */
function displayId(id: string, dir: string): string {
  if (SAFE_REVIEW_ID.test(id)) return id;
  const base = path.basename(dir).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return base === "" ? "(unnamed package)" : base;
}

/** The placeholder blocker when this session neither opened nor named a package. It never claims none exists. */
export const NO_PACKAGE_BLOCKER =
  "no review package this session opened or named: `keryx review start` has not opened one, and no `keryx review` command in this session names an open package by its path or review id";

/**
 * The state `keryx review complete` is waiting on. `null` when a review-flow package under the chosen package's root
 * (any root, before one is chosen) was closed since `since`: the run is done. Otherwise the package this session is
 * reviewing (see {@link pickPackage}), searched under `cwd` and the project roots this session's own `keryx review`
 * commands named. An open package older than `since` is named only when this session's commands name its path or
 * review id. With none, a placeholder that says so: a run that built scope and slices but never opened a package is
 * not finished either.
 */
export async function findReviewGateState(
  cwd: string,
  since: number,
  named: Partial<SessionReviewNames> = {},
): Promise<OpenManagedReview | null> {
  const roots = [...new Set([cwd, ...(named.roots ?? [])].map((r) => path.resolve(r)))];
  const candidates: PackageCandidate[] = [];
  const closedAtByRoot = new Map<string, number>();
  for (const root of roots) {
    const scanned = await scanRoot(root, since, named);
    candidates.push(...scanned.open);
    closedAtByRoot.set(root, scanned.closedAt);
  }
  const best = await pickPackage(roots, candidates, since, named);
  // A closed package releases the gate only under the root of the package this session is on: one closed elsewhere
  // cannot end the gate for this one.
  const closedAt = best === null ? Math.max(0, ...closedAtByRoot.values()) : (closedAtByRoot.get(best.root) ?? 0);
  if (closedAt > 0 && (best === null || best.mtime < closedAt)) return null;
  const workingRoot = best?.root ?? cwd;
  const working = await dirSignature(path.join(workingRoot, ".metaproject", "data", "review"));
  if (best === null) {
    return {
      reviewId: "(no package yet)",
      packageDir: "",
      blockers: [NO_PACKAGE_BLOCKER],
      signature: `none#${working}`,
    };
  }
  const blockers = await reviewCompletionBlockers(best.dir);
  return {
    reviewId: displayId(best.id, best.dir),
    packageDir: best.dir,
    blockers,
    signature: [blockers.join("|"), await dirSignature(best.dir), working].join("#"),
  };
}

/** True when the transcript shows the review skill was loaded or a `keryx review` command was run in this session. */
export function reviewRunSeenInHistory(
  history: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ name: string; arguments: string }> | undefined }>,
): boolean {
  for (const message of history) {
    for (const call of message.toolCalls ?? []) {
      if (call.name === "skill_load" && call.arguments.includes("review-orchestrator")) return true;
      if (/keryx review (start|scope|slice|ingest|complete)/.test(call.arguments)) return true;
    }
  }
  return false;
}

/** The earliest message timestamp in the transcript: packages closed before it are not this run's. */
export function sessionStartedAt(history: ReadonlyArray<{ ts?: string | undefined }>): number {
  for (const message of history) {
    const at = message.ts === undefined ? Number.NaN : Date.parse(message.ts);
    if (!Number.isNaN(at)) return at;
  }
  return Date.now();
}

function nextStep(open: OpenManagedReview): string {
  if (open.packageDir === "") {
    return "Next: to continue a review opened in an earlier session, name its package (`keryx review status <review-id-or-path>`); otherwise `keryx review start --pr <n> --report <path>` opens the package; then dispatch the reviewers per slice, save each result, `keryx review ledger build <input-dir> --package <review-dir>`, `keryx review ingest ... --research <review-dir>/research.json`, then `keryx review complete`.";
  }
  if (open.blockers.some((b) => /research|dispatch/.test(b))) {
    return "Next: dispatch the reviewers per slice, build the research ledger with `keryx review ledger build <input-dir> --package <review-dir>` (it names every gap), `keryx review ingest ... --research <review-dir>/research.json`, then `keryx review complete`.";
  }
  return "Next: write or ingest the missing artifacts (`keryx review ingest`), then `keryx review complete`.";
}

export type ReviewGateInput = {
  open: OpenManagedReview | null;
  runSeen: boolean;
  continues: number;
  stalls: number;
  lastSignature: string | undefined;
};

export type ReviewGateDecision =
  | { action: "accept" }
  | { action: "continue"; message: string; stalls: number; signature: string }
  | { action: "stop"; report: string };

const MAX_NUDGE_BLOCKERS = 20;
const MAX_NUDGE_BLOCKER_CHARS = 300;

/** One blocker as one bounded line: line breaks and control characters carried in from package text are flattened. */
function nudgeLine(blocker: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = blocker.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return flat.length > MAX_NUDGE_BLOCKER_CHARS ? `${flat.slice(0, MAX_NUDGE_BLOCKER_CHARS)}…` : flat;
}

export function describeBlockers(open: OpenManagedReview): string {
  if (open.blockers.length === 0) return "- none listed; run `keryx review complete` to close the package";
  const shown = open.blockers.slice(0, MAX_NUDGE_BLOCKERS).map((b) => `- ${nudgeLine(b)}`);
  const more = open.blockers.length - shown.length;
  return [...shown, ...(more > 0 ? [`- … and ${more} more (\`keryx review complete\` lists them all)`] : [])].join("\n");
}

export function decideReviewGate(input: ReviewGateInput): ReviewGateDecision {
  const { open } = input;
  if (open === null || !input.runSeen) return { action: "accept" };
  const stalls = input.lastSignature === open.signature ? input.stalls + 1 : 0;
  if (input.continues >= MAX_REVIEW_GATE_CONTINUES || stalls >= MAX_REVIEW_GATE_STALLS) {
    return {
      action: "stop",
      report:
        `Review ${open.reviewId} is not complete after ${input.continues} continue(s)` +
        `${stalls >= MAX_REVIEW_GATE_STALLS ? " and no new artifact in the last " + stalls : ""}. ` +
        `\`keryx review complete\` still refuses on:\n${describeBlockers(open)}`,
    };
  }
  return {
    action: "continue",
    stalls,
    signature: open.signature,
    message:
      `The managed review ${open.reviewId} is not finished: it is finished when \`keryx review complete\` accepts the package, not when you stop writing. ` +
      `It still refuses on:\n${describeBlockers(open)}\n` +
      `${nextStep(open)}\n` +
      "Do the next missing step now. Step 1 (Build Review Context Pack) has no CLI command; it is a prose step, so mark it done and move on. " +
      "A command that is refused is not a blocker: run `keryx review --help` for the accepted usage and retry with the right flags. " +
      "A plan item you marked blocked for such a reason is not blocked: mark it in_progress. " +
      "A tool loop guard or an empty child result is not a reason to ask the operator to resend the request or to continue: change the arguments, retry the failed pass on a smaller slice, and keep going. " +
      "Stop only after `review complete` succeeds, or report the one real blocker with its evidence.",
  };
}
