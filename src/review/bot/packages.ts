// Reads managed review packages back off disk. `post` needs one package by id; `metrics` and the
// `/reviews` inspector need every pull-request package, wherever it was written.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ManagedReviewManifest, StructuredReviewFinding } from "../types";

export type ListedReview = {
  reviewId: string;
  dir: string;
  manifest: ManagedReviewManifest;
  findings: StructuredReviewFinding[];
  repo: string | null;
  number: number | null;
};

async function subdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function pullFromTarget(target: { ref: string; repository?: string | undefined }): { repo: string; number: number } | null {
  const url = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(target.ref);
  if (url?.[1] !== undefined && url[2] !== undefined) return { repo: url[1], number: Number(url[2]) };
  const short = /^([^/\s#]+\/[^/\s#]+)#(\d+)$/.exec(target.ref);
  if (short?.[1] !== undefined && short[2] !== undefined) return { repo: short[1], number: Number(short[2]) };
  const bare = /^#?(\d+)$/.exec(target.ref);
  if (bare?.[1] !== undefined && target.repository !== undefined) return { repo: target.repository, number: Number(bare[1]) };
  return null;
}

async function readPackage(dir: string): Promise<ListedReview | null> {
  try {
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as ManagedReviewManifest;
    if (manifest.target?.kind !== "pr") return null;
    let findings: StructuredReviewFinding[] = [];
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, "findings.json"), "utf8")) as unknown;
      if (Array.isArray(parsed)) findings = parsed as StructuredReviewFinding[];
    } catch {
      findings = [];
    }
    const pull = pullFromTarget(manifest.target);
    return { reviewId: manifest.reviewId, dir, manifest, findings, repo: pull?.repo ?? null, number: pull?.number ?? null };
  } catch {
    return null;
  }
}

function candidateDirs(cwd: string): Promise<string[]> {
  return (async () => {
    const dirs: string[] = [];
    const reviews = path.join(cwd, ".metaproject", "reviews");
    for (const name of await subdirectories(reviews)) {
      if (name !== "bot") dirs.push(path.join(reviews, name));
    }
    const flows = path.join(cwd, ".metaproject", "flows");
    for (const flow of await subdirectories(flows)) {
      const nested = path.join(flows, flow, "reviews");
      for (const name of await subdirectories(nested)) dirs.push(path.join(nested, name));
    }
    return dirs;
  })();
}

/** Every pull-request review package under `cwd`, newest first. */
export async function listReviewPackages(cwd: string): Promise<ListedReview[]> {
  const found: ListedReview[] = [];
  for (const dir of await candidateDirs(cwd)) {
    const listed = await readPackage(dir);
    if (listed !== null) found.push(listed);
  }
  const stamp = (review: ListedReview): string => review.manifest.updatedAt ?? review.manifest.createdAt ?? "";
  return found.sort((a, b) => stamp(b).localeCompare(stamp(a)) || b.reviewId.localeCompare(a.reviewId));
}

export async function loadReviewPackage(cwd: string, reviewId: string): Promise<ListedReview | null> {
  for (const dir of await candidateDirs(cwd)) {
    if (path.basename(dir) !== reviewId) continue;
    const listed = await readPackage(dir);
    if (listed !== null && listed.reviewId === reviewId) return listed;
  }
  return null;
}
