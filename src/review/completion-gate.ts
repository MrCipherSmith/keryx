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

const REVIEW_PACKAGE_PATH = /((?:[A-Za-z]:)?[^\s"'`<>|;&()]*?)\.metaproject[\\/]reviews[\\/]([^\\/\s"'`<>|;&()]+)/g;

/**
 * Project roots (the directory holding `.metaproject`) this session's tool calls and results named
 * through a review package path, e.g. the path `review start` printed. A relative path resolves
 * against `cwd`, so a review nested under a subdirectory is found as well as one at `cwd`.
 */
export function sessionReviewRoots(
  history: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ arguments: string }> | undefined; content?: unknown }>,
  cwd: string,
): string[] {
  const roots = new Set<string>();
  const scan = (text: string): void => {
    for (const match of text.matchAll(REVIEW_PACKAGE_PATH)) {
      const prefix = match[1] ?? "";
      roots.add(path.resolve(cwd, prefix === "" ? "." : prefix));
    }
  };
  for (const message of history) {
    if (typeof message.content === "string") scan(message.content);
    for (const call of message.toolCalls ?? []) scan(call.arguments);
  }
  roots.delete(path.resolve(cwd));
  return [...roots];
}

async function scanRoot(root: string, since: number): Promise<{ open: PackageCandidate[]; closedAt: number }> {
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
      // An open package whose manifest predates the session is another run's (a checkout carries old drafts); `ingest --review-id` flips the run's own package to mode ingest, which this covers too.
      if (info.mtimeMs < since) continue;
      open.push({ dir, mtime: info.mtimeMs, id: manifest.reviewId ?? name, root });
    } catch {
      continue;
    }
  }
  return { open, closedAt };
}

/**
 * The state `keryx review complete` is waiting on. `null` when a review-flow package was closed since
 * `since` (the run is done). Otherwise the package this session is reviewing: the active-review pointer
 * first, then the newest package opened since `since` under `cwd` or under a project root the session's
 * own tool calls named (`extraRoots`). Before `review start` has opened one, a placeholder whose blocker
 * is exactly that: a run that built scope and slices but never opened a package is not finished either.
 * An open package older than `since` is never named.
 */
export async function findReviewGateState(
  cwd: string,
  since: number,
  extraRoots: readonly string[] = [],
): Promise<OpenManagedReview | null> {
  const roots = [cwd, ...extraRoots.filter((r) => path.resolve(r) !== path.resolve(cwd))];
  const candidates: PackageCandidate[] = [];
  let closedAt = 0;
  for (const root of roots) {
    const scanned = await scanRoot(root, since);
    candidates.push(...scanned.open);
    closedAt = Math.max(closedAt, scanned.closedAt);
  }
  let best: PackageCandidate | null = null;
  for (const root of roots) {
    const pointer = await resolveActiveReview(root);
    if (pointer === undefined || Date.parse(pointer.startedAt) < since) continue;
    const manifestPath = path.join(pointer.dir, "manifest.json");
    const manifest = await readFile(manifestPath, "utf8").then((t) => JSON.parse(t) as { reviewId?: string }).catch((): { reviewId?: string } => ({}));
    const mtime = await stat(manifestPath).then((i) => i.mtimeMs).catch(() => 0);
    best = { dir: pointer.dir, mtime, id: manifest.reviewId ?? pointer.id, root };
    break;
  }
  if (best === null) {
    for (const candidate of candidates) if (best === null || candidate.mtime > best.mtime) best = candidate;
  }
  if (closedAt > 0 && (best === null || best.mtime < closedAt)) return null;
  const workingRoot = best?.root ?? cwd;
  const working = await dirSignature(path.join(workingRoot, ".metaproject", "data", "review"));
  if (best === null) {
    return {
      reviewId: "(no package yet)",
      packageDir: "",
      blockers: ["no review package exists: `keryx review start` has not opened one"],
      signature: `none#${working}`,
    };
  }
  const blockers = await reviewCompletionBlockers(best.dir);
  return {
    reviewId: best.id,
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
    return "Next: `keryx review start --pr <n> --report <path>` opens the package; then dispatch the reviewers per slice, save each result, `keryx review ledger build <input-dir> --package <review-dir>`, `keryx review ingest ... --research <review-dir>/research.json`, then `keryx review complete`.";
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

export function describeBlockers(open: OpenManagedReview): string {
  return open.blockers.length > 0
    ? open.blockers.map((b) => `- ${b}`).join("\n")
    : "- none listed; run `keryx review complete` to close the package";
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
