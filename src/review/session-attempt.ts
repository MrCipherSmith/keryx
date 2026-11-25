// Flow 521 (spec "Единый реестр"): a review package an agent made in a session for a pull request becomes an Attempt
// with source `session` in the Desktop review store, so the Reviews tab lists it, `desk-publish` can publish it, and
// both publish paths share one receipt and one duplicate marker.
//
// The Attempt holds a copy of the package (`<attempt>/package`): Desktop reads a package only through real files inside
// the attempt directory, never through a link. The package records the Attempt it was registered as in
// `desk-attempt.json`, which `keryx review publish` reads to use the Attempt's receipt and marker.

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { withFileLock, writeFileAtomic } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { knownFindingList } from "./autonomous-summary";
import { isPrBound } from "./complete-head-gate";
import { DeskRunStore, deskRunRoot } from "./desk-run-store";
import { readPublicationReceipt, receiptPath } from "./publication-guard";
import { DESK_RUN_SCOPE, type DeskRun, type DeskRunKey } from "./desk-run-types";
import { computeReadiness, failingItems, type ReadinessOptions } from "./readiness";
import { readRoundNumber } from "./round-record";
import { pullRequestPath } from "./session-publish-github";
import { newerRoundOf } from "./update-round";
import type { ManagedReviewManifest } from "./types";
import { ingestedFindingCounts } from "./verdict";

export const SESSION_ATTEMPT_FILE = "desk-attempt.json";
const FULL_SHA = /^[0-9a-f]{40}$/i;

export type SessionAttemptRecord = { attemptId: string; repositoryId: string; viewer: string; number: number };

/** The Attempt id of one round of one session package for one account: the same package registers as the same Attempt. */
export function sessionAttemptId(key: DeskRunKey, reviewId: string, round: number): string {
  const digest = createHash("sha256").update(JSON.stringify(["session", key.repositoryId, key.viewer.toLowerCase(), key.number, reviewId, round]))
    .digest("hex").slice(0, 32);
  // A version-4-shaped UUID: Desktop accepts only UUIDs as attempt ids.
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Directories Desktop publication never reads; copying them made every registration move tens of megabytes. */
const NOT_COPIED = new Set([SESSION_ATTEMPT_FILE, "publication.lock", "publication-receipt.json", "layers", "payloads"]);

/**
 * The Attempt a package was registered as, or undefined when it never was. The file sits in the package, so its id is
 * accepted only in the shape keryx writes (a UUID: it becomes a store path and a marker) and only for the package's own
 * pull request.
 */
export async function readSessionAttempt(packageDir: string): Promise<SessionAttemptRecord | undefined> {
  const value = await readJsonFileOr<Partial<SessionAttemptRecord> | undefined>(path.join(packageDir, SESSION_ATTEMPT_FILE), undefined);
  if (!value || typeof value.attemptId !== "string" || !ATTEMPT_ID.test(value.attemptId) || typeof value.repositoryId !== "string" ||
      typeof value.viewer !== "string" || typeof value.number !== "number") return undefined;
  const manifest = await readJsonFileOr<ManagedReviewManifest | undefined>(path.join(packageDir, "manifest.json"), undefined);
  const pr = manifest === undefined ? undefined : pullRequestPath(manifest.target.ref);
  return pr !== undefined && pr.number === value.number ? value as SessionAttemptRecord : undefined;
}

export type RegisterSessionInput = {
  cwd: string;
  packageDir: string;
  /**
   * Resolves the store key of the package's pull request (the selected GitHub account and the repository's id) and the
   * pull request's base commit, used when the package recorded its base as a branch name.
   */
  resolveKey: (repo: string, number: number) => Promise<DeskRunKey & { baseRefOid?: string | undefined }>;
  readiness?: ReadinessOptions | undefined;
  store?: DeskRunStore | undefined;
  now?: (() => Date) | undefined;
  /** ACP session that opened the package; absent for ordinary publication registration. */
  sessionId?: string | undefined;
  sessionOwner?: import("../lib/hub-machine/process-identity").ProcessIdentity | undefined;
  taskToken?: string | undefined;
};

/**
 * Register (or refresh) a PR-bound session package as a `session` Attempt. Returns the record, or the reason it was not
 * registered: a package for another kind of target, without a full head, or without a report has nothing a Desktop
 * Review can show.
 */
export async function registerSessionPackage(input: RegisterSessionInput): Promise<{ record: SessionAttemptRecord } | { skipped: string }> {
  const manifest = await readJsonFileOr<ManagedReviewManifest | undefined>(path.join(input.packageDir, "manifest.json"), undefined);
  if (manifest === undefined) return { skipped: "the package has no readable manifest.json" };
  if (!isPrBound(manifest.target)) return { skipped: "the package is not bound to a pull request" };
  const pr = pullRequestPath(manifest.target.ref);
  if (pr === undefined) return { skipped: `the package target is not a GitHub pull request URL (${manifest.target.ref})` };
  const headSha = manifest.target.head ?? "";
  if (!FULL_SHA.test(headSha)) return { skipped: "the package does not record the full head commit it reviewed" };
  const report = await readFile(path.join(input.packageDir, "report.md"), "utf8").catch(() => "");
  if ((report.trim() === "" || report.includes("No reviewer findings recorded yet.")) && input.sessionId === undefined) return { skipped: "the package has no report.md" };
  if (input.sessionId !== undefined && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.sessionId)) return { skipped: "invalid session id" };

  const store = input.store ?? new DeskRunStore();
  try {
    return await register(input, store, manifest, pr, headSha, report);
  } finally {
    if (input.store === undefined) store.close();
  }
}

async function register(input: RegisterSessionInput, store: DeskRunStore, manifest: ManagedReviewManifest, pr: { repo: string; number: number },
  headSha: string, report: string): Promise<{ record: SessionAttemptRecord } | { skipped: string }> {
  // A Desktop worker's own package lives in the store already: it is that worker's Attempt, not a session's.
  const storeRoot = await realpath(store.root).catch(() => path.resolve(store.root));
  const own = await realpath(input.packageDir);
  if (own === storeRoot || own.startsWith(`${storeRoot}${path.sep}`)) return { skipped: "the package belongs to a Desktop review attempt" };
  const { baseRefOid, ...key } = await input.resolveKey(pr.repo, pr.number);
  const bound = await readSessionAttempt(input.packageDir);
  if (bound && (bound.repositoryId !== key.repositoryId || bound.viewer.toLowerCase() !== key.viewer.toLowerCase())) {
    return { skipped: "the package belongs to a different GitHub account or repository" };
  }
  const round = readRoundNumber(input.packageDir) ?? 1;
  const id = sessionAttemptId(key, manifest.reviewId, round);
  // `review start --target <pr>` without --base records the base branch (`origin/main`): the PR's base commit at the first
  // registration stands in, and later registrations keep it, so a retargeted PR never re-pins a base nobody reviewed.
  const recorded = manifest.target.base ?? "";
  const registeredBase = store.byId(id)?.run.baseSha;
  const baseSha = FULL_SHA.test(recorded) ? recorded : registeredBase ?? baseRefOid ?? "";
  if (!FULL_SHA.test(baseSha)) return { skipped: "neither the package nor the pull request gives the full base commit it was reviewed against" };
  const record: SessionAttemptRecord = { attemptId: id, repositoryId: key.repositoryId, viewer: key.viewer, number: key.number };
  const directory = store.directory(id);
  // An attempt the operator decided on (completed, closed, archived, deleted) keeps the evidence it was decided on.
  if (store.byId(id)?.run.decision) {
    await writeFileAtomic(path.join(input.packageDir, SESSION_ATTEMPT_FILE), `${JSON.stringify(record, null, 2)}\n`);
    return { record };
  }
  const readiness = await computeReadiness(input.packageDir, input.readiness ?? {});
  const hasReport = input.sessionId === undefined && report.trim() !== "" && !report.includes("No reviewer findings recorded yet.");
  const complete = hasReport && failingItems(readiness).length === 0;
  const findingsFile: unknown = await readJsonFileOr<unknown>(path.join(input.packageDir, "findings.json"), undefined);
  const findingsKnown = knownFindingList(findingsFile);
  const at = (input.now?.() ?? new Date()).toISOString();
  const base = baseSha.toLowerCase();
  const head = headSha.toLowerCase();
  const sessionId = input.sessionId ?? store.byId(id)?.run.sessionId;
  const run: DeskRun = {
    id,
    source: "session",
    ...(sessionId === undefined ? {} : { sessionId }),
    scope: DESK_RUN_SCOPE,
    baseSha: base,
    headSha: head,
    state: hasReport ? (complete ? "completed" : "partial") : "running",
    phase: hasReport ? "Session review" : "Session review in progress",
    reason: hasReport ? (complete ? "Reviewed in an agent session." : "Reviewed in an agent session; its readiness checklist did not pass.") : "Review started in an agent session.",
    createdAt: typeof manifest.createdAt === "string" ? manifest.createdAt : at,
    startedAt: typeof manifest.createdAt === "string" ? manifest.createdAt : null,
    finishedAt: hasReport ? at : null,
    result: hasReport ? {
      reviewed: { baseSha: base, headSha: head },
      // Desktop derives the publication verdict from the package itself; the session package carries none.
      verdict: null,
      coverage: complete ? "complete" : "partial",
      findingsKnown,
      findings: findingsKnown ? ingestedFindingCounts(findingsFile as Record<string, unknown>[]) : { blocker: 0, major: 0, minor: 0, info: 0 },
      report,
    } : null,
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Under the lock Desktop's save, skip and submit hold, so none of them reads a half-copied package (a preview reads
  // without the lock and may fail once while a copy runs; it is read again on refresh).
  await withFileLock(path.join(directory, "publication.lock"), async () => {
    // Decided while this registration read the package: the decision stands and the copy stays.
    if (store.byId(id)?.run.decision) return;
    // The copy is refreshed in place: the attempt directory keeps Desktop's own files (receipt, draft) beside it.
    const target = path.join(directory, "package");
    await rm(target, { recursive: true, force: true });
    await cp(own, target, { recursive: true, dereference: false, verbatimSymlinks: true,
      filter: (source) => source === own || !NOT_COPIED.has(path.basename(source)) });
    // Desktop accepts a package only for the range it was registered on: a base recorded as a branch name is pinned in
    // the copy to the commit the Attempt uses. The session's own package is left as it is.
    if (manifest.target.base !== base || manifest.target.head !== head) {
      await writeFileAtomic(path.join(target, "manifest.json"), `${JSON.stringify({ ...manifest, target: { ...manifest.target, base, head } }, null, 2)}\n`);
    }
    // A package published before it was registered carries its receipt here, so Desktop sees it as published.
    const earlier = await readPublicationReceipt(own);
    if (earlier !== undefined && await readPublicationReceipt(directory) === undefined) {
      await writeFileAtomic(receiptPath(directory), JSON.stringify(earlier), { mode: 0o600 });
    }
    store.atomic(() => store.recordSession(input.cwd, key, run, input.sessionOwner ?? store.byId(id)?.workerIdentity, input.taskToken ?? store.byId(id)?.taskToken));
  });
  await writeFileAtomic(path.join(input.packageDir, SESSION_ATTEMPT_FILE), `${JSON.stringify(record, null, 2)}\n`);
  return { record };
}

async function gitCommonDir(dir: string): Promise<string | undefined> {
  const { execFile } = await import("node:child_process");
  const out = await new Promise<string | undefined>((resolve) => {
    execFile("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 5000 }, (error, stdout) =>
      resolve(error ? undefined : stdout.trim()));
  });
  if (!out) return undefined;
  return realpath(out).catch(() => undefined);
}

/**
 * The project a review command belongs to when an ACP session's shell runs it: the session's project root, when `cwd`
 * is that root or a checkout of the same repository (a linked git worktree, where an agent reviews a pull request
 * beside the project). Undefined outside a session, or in an unrelated directory.
 *
 * A Desktop session and the Reviews board list attempts by the project's root. An attempt registered under the
 * worktree's own path is in the store and on neither of them, so every registration from such a shell uses this root.
 */
export async function sessionProjectRoot(cwd: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<string | undefined> {
  const root = env["KERYX_REVIEW_SESSION_PROJECT_ROOT"];
  if (!env["KERYX_REVIEW_SESSION_ID"] || !root) return undefined;
  const [project, here] = await Promise.all([realpath(root).catch(() => ""), realpath(cwd).catch(() => "")]);
  if (project === "" || here === "") return undefined;
  if (project === here) return root;
  const [projectGit, hereGit] = await Promise.all([gitCommonDir(project), gitCommonDir(here)]);
  return projectGit !== undefined && projectGit === hereGit ? root : undefined;
}

/**
 * Registers a package against the project's selected GitHub account, as Desktop reads it. Throws with the reason when it
 * was not registered, so the caller can say so.
 */
export async function registerSessionPackageForProject(cwd: string, packageDir: string, readiness?: ReadinessOptions, sessionId?: string, sessionOwner?: import("../lib/hub-machine/process-identity").ProcessIdentity, taskToken?: string): Promise<SessionAttemptRecord | undefined> {
  const result = await registerSessionPackage({
    cwd, packageDir, readiness, sessionId, sessionOwner, taskToken,
    resolveKey: async (repo, number) => {
      const { projectGithubConnection } = await import("./board-github");
      const { resolveDeskSubject } = await import("./desk-run-service");
      const subject = await resolveDeskSubject(cwd, repo, number, await projectGithubConnection(cwd));
      return { ...subject.key, baseRefOid: subject.pr.baseRefOid };
    },
  });
  if ("record" in result) return result.record;
  // A package that is not a pull request review has nothing to register: no warning for it.
  if (/not bound to a pull request/.test(result.skipped)) return undefined;
  throw new Error(result.skipped);
}

export type SessionRegistrar = (packageDir: string) => Promise<SessionAttemptRecord | undefined>;

/**
 * Where `keryx review publish` keeps the receipt and which marker it writes: the package's Attempt, registered (or
 * refreshed) now, else the one it was registered as before. A registration that fails is a warning, not a refusal: the
 * package then publishes with its own receipt, as before flow 521.
 */
export async function sessionPublication(packageDir: string, register: SessionRegistrar | undefined, warn: (text: string) => void,
  root: string = deskRunRoot()): Promise<{ directory: string; id: string } | undefined> {
  let record: SessionAttemptRecord | undefined;
  if (register !== undefined) {
    try {
      record = await register(packageDir);
    } catch (error) {
      warn(`not registered as a Desktop review attempt: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  record ??= await readSessionAttempt(packageDir);
  return record === undefined ? undefined : { directory: path.join(root, "attempts", record.attemptId), id: record.attemptId };
}

/** The round of the same Review that follows the Attempt `attemptId`, read from the Desktop store; undefined when none does. */
export function laterRoundOf(attemptId: string, root: string = deskRunRoot()): number | undefined {
  let store: DeskRunStore;
  try {
    store = new DeskRunStore(root, true);
  } catch {
    return undefined; // No store yet: nothing can follow.
  }
  try {
    const attempt = store.byId(attemptId);
    return attempt === undefined ? undefined : newerRoundOf(store.history(attempt.key).runs, attempt.run)?.round;
  } finally {
    store.close();
  }
}
