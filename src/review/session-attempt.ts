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
import { writeFileAtomic } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { knownFindingList } from "./autonomous-summary";
import { isPrBound } from "./complete-head-gate";
import { DeskRunStore, deskRunRoot } from "./desk-run-store";
import { DESK_RUN_SCOPE, type DeskRun, type DeskRunKey } from "./desk-run-types";
import { computeReadiness, failingItems, type ReadinessOptions } from "./readiness";
import { readRoundNumber } from "./round-record";
import { pullRequestPath } from "./session-publish-github";
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

/** The Attempt a package was registered as, or undefined when it never was. */
export async function readSessionAttempt(packageDir: string): Promise<SessionAttemptRecord | undefined> {
  const value = await readJsonFileOr<Partial<SessionAttemptRecord> | undefined>(path.join(packageDir, SESSION_ATTEMPT_FILE), undefined);
  return value && typeof value.attemptId === "string" && typeof value.repositoryId === "string" &&
    typeof value.viewer === "string" && typeof value.number === "number" ? value as SessionAttemptRecord : undefined;
}

export type RegisterSessionInput = {
  cwd: string;
  packageDir: string;
  /** Resolves the store key of the package's pull request: the selected GitHub account and the repository's id. */
  resolveKey: (repo: string, number: number) => Promise<DeskRunKey>;
  readiness?: ReadinessOptions | undefined;
  store?: DeskRunStore | undefined;
  now?: (() => Date) | undefined;
};

/**
 * Register (or refresh) a PR-bound session package as a `session` Attempt. Returns the record, or a reason it was not
 * registered: a package for another kind of target, without a full base and head, or without a report has nothing a
 * Desktop Review can show.
 */
export async function registerSessionPackage(input: RegisterSessionInput): Promise<{ record: SessionAttemptRecord } | { skipped: string }> {
  const manifest = await readJsonFileOr<ManagedReviewManifest | undefined>(path.join(input.packageDir, "manifest.json"), undefined);
  if (manifest === undefined) return { skipped: "the package has no readable manifest.json" };
  if (!isPrBound(manifest.target)) return { skipped: "the package is not bound to a pull request" };
  const pr = pullRequestPath(manifest.target.ref);
  if (pr === undefined) return { skipped: `the package target is not a GitHub pull request URL (${manifest.target.ref})` };
  const baseSha = manifest.target.base ?? "";
  const headSha = manifest.target.head ?? "";
  if (!FULL_SHA.test(baseSha) || !FULL_SHA.test(headSha)) return { skipped: "the package does not record the full base and head commits it reviewed" };
  const report = await readFile(path.join(input.packageDir, "report.md"), "utf8").catch(() => "");
  if (report.trim() === "") return { skipped: "the package has no report.md" };

  const store = input.store ?? new DeskRunStore();
  try {
    return await register(input, store, manifest, pr, baseSha, headSha, report);
  } finally {
    if (input.store === undefined) store.close();
  }
}

async function register(input: RegisterSessionInput, store: DeskRunStore, manifest: ManagedReviewManifest, pr: { repo: string; number: number },
  baseSha: string, headSha: string, report: string): Promise<{ record: SessionAttemptRecord } | { skipped: string }> {
  // A Desktop worker's own package lives in the store already: it is that worker's Attempt, not a session's.
  const storeRoot = await realpath(store.root).catch(() => path.resolve(store.root));
  const own = await realpath(input.packageDir);
  if (own === storeRoot || own.startsWith(`${storeRoot}${path.sep}`)) return { skipped: "the package belongs to a Desktop review attempt" };
  const key = await input.resolveKey(pr.repo, pr.number);
  const round = readRoundNumber(input.packageDir) ?? 1;
  const id = sessionAttemptId(key, manifest.reviewId, round);
  const readiness = await computeReadiness(input.packageDir, input.readiness ?? {});
  const complete = failingItems(readiness).length === 0;
  const findingsFile: unknown = await readJsonFileOr<unknown>(path.join(input.packageDir, "findings.json"), undefined);
  const findingsKnown = knownFindingList(findingsFile);
  const at = (input.now?.() ?? new Date()).toISOString();
  const run: DeskRun = {
    id,
    source: "session",
    scope: DESK_RUN_SCOPE,
    baseSha: baseSha.toLowerCase(),
    headSha: headSha.toLowerCase(),
    state: complete ? "completed" : "partial",
    phase: "Session review",
    reason: complete ? "Reviewed in an agent session." : "Reviewed in an agent session; its readiness checklist did not pass.",
    createdAt: typeof manifest.createdAt === "string" ? manifest.createdAt : at,
    startedAt: typeof manifest.createdAt === "string" ? manifest.createdAt : null,
    finishedAt: at,
    result: {
      reviewed: { baseSha: baseSha.toLowerCase(), headSha: headSha.toLowerCase() },
      // Desktop derives the publication verdict from the package itself; the session package carries none.
      verdict: null,
      coverage: complete ? "complete" : "partial",
      findingsKnown,
      findings: findingsKnown ? ingestedFindingCounts(findingsFile as Record<string, unknown>[]) : { blocker: 0, major: 0, minor: 0, info: 0 },
      report,
    },
  };
  // The copy is refreshed in place: the attempt directory keeps Desktop's own files (receipt, draft) beside it.
  const directory = store.directory(id);
  const target = path.join(directory, "package");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await rm(target, { recursive: true, force: true });
  await cp(own, target, { recursive: true, dereference: false, verbatimSymlinks: true,
    filter: (source) => path.basename(source) !== SESSION_ATTEMPT_FILE && path.basename(source) !== "publication.lock" &&
      path.basename(source) !== "publication-receipt.json" });
  store.atomic(() => store.recordSession(input.cwd, key, run));
  const record: SessionAttemptRecord = { attemptId: id, repositoryId: key.repositoryId, viewer: key.viewer, number: key.number };
  await writeFileAtomic(path.join(input.packageDir, SESSION_ATTEMPT_FILE), `${JSON.stringify(record, null, 2)}\n`);
  return { record };
}

/** Registers a package against the project's selected GitHub account, as Desktop reads it. */
export async function registerSessionPackageForProject(cwd: string, packageDir: string, readiness?: ReadinessOptions): Promise<SessionAttemptRecord | undefined> {
  const result = await registerSessionPackage({
    cwd, packageDir, readiness,
    resolveKey: async (repo, number) => {
      const { projectGithubConnection } = await import("./board-github");
      const { resolveDeskSubject } = await import("./desk-run-service");
      return (await resolveDeskSubject(cwd, repo, number, await projectGithubConnection(cwd))).key;
    },
  });
  return "record" in result ? result.record : undefined;
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
