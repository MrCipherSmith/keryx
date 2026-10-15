// The keryx shell refuses a direct GitHub review while a managed review package bound to that pull request is not READY:
// the checklist is only a gate if the other road to GitHub is shut. A text match, not a security boundary — a publisher
// outside the keryx shell (CI, another agent, a script file) is not stopped, which the docs name.

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readJsonFileOr } from "../lib/json";
import { splitSegments } from "../lib/shell-syntax";
import { isPrBound } from "./complete-head-gate";
import { reviewsRoot } from "./managed";
import { computeReadiness, failingItems } from "./readiness";
import type { ManagedReviewManifest } from "./types";

export type ReviewPublishAttempt = { kind: "gh-pr-review" | "gh-api-review"; number?: number; repo?: string };

const PR_REF = /(?:github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+))|^#?(\d+)$/;
const REVIEW_ENDPOINT = /(?:^|\/)repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews(?:\/\d+\/events)?\/?$/;
const PR_REVIEW_VALUE_FLAGS = new Set(["-R", "--repo", "-b", "--body", "-F", "--body-file"]);
const API_VALUE_FLAGS = new Set(["-X", "--method", "-H", "--header", "-q", "--jq", "-t", "--template", "--hostname", "--cache", "--input", "-f", "--raw-field", "-F", "--field", "-p", "--preview"]);
const API_FIELD_FLAGS = new Set(["-f", "--raw-field", "-F", "--field", "--input"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

function parseRef(value: string | undefined): { number?: number; repo?: string } {
  const match = value === undefined ? null : PR_REF.exec(value);
  if (match === null) return {};
  const number = Number(match[2] ?? match[3]);
  return { number, ...(match[1] === undefined ? {} : { repo: match[1] }) };
}

function repoFlag(args: readonly string[]): string | undefined {
  const at = args.findIndex((word) => word === "-R" || word === "--repo");
  if (at >= 0) return args[at + 1];
  return args.find((word) => word.startsWith("--repo="))?.slice("--repo=".length);
}

function attemptsInSegment(words: readonly string[]): ReviewPublishAttempt[] {
  const head = (words[0] ?? "").split("/").pop() ?? "";
  if (head !== "gh") return [];
  const args = words.slice(1);
  if (args[0] === "pr" && args[1] === "review") {
    const rest = args.slice(2);
    const positional = rest.find((word, index) => !word.startsWith("-") && !PR_REVIEW_VALUE_FLAGS.has(rest[index - 1] ?? ""));
    const ref = parseRef(positional);
    const repo = ref.repo ?? repoFlag(rest);
    return [{ kind: "gh-pr-review", ...(ref.number === undefined ? {} : { number: ref.number }), ...(repo === undefined ? {} : { repo }) }];
  }
  if (args[0] !== "api") return [];
  const rest = args.slice(1);
  const endpoint = rest.find((word, index) => !word.startsWith("-") && !API_VALUE_FLAGS.has(rest[index - 1] ?? ""));
  if (endpoint === undefined) return [];
  if (endpoint === "graphql") {
    return rest.some((word) => /addPullRequestReview|submitPullRequestReview/.test(word)) ? [{ kind: "gh-api-review" }] : [];
  }
  const match = REVIEW_ENDPOINT.exec(endpoint.split("?")[0]!);
  if (match === null) return [];
  const methodAt = rest.findIndex((word) => word === "-X" || word === "--method");
  const method = (
    methodAt >= 0
      ? rest[methodAt + 1]
      : (rest.find((word) => /^-X./.test(word))?.slice(2) ?? rest.find((word) => word.startsWith("--method="))?.slice("--method=".length))
  )?.toUpperCase();
  const implicitPost = rest.some((word) => API_FIELD_FLAGS.has(word) || word.startsWith("--field=") || word.startsWith("--raw-field=") || word.startsWith("--input="));
  const writes = method !== undefined ? method === "POST" || method === "PUT" : implicitPost;
  if (!writes) return [];
  const repo = match[1]!.includes("{") ? undefined : match[1]!;
  return [{ kind: "gh-api-review", number: Number(match[2]), ...(repo === undefined ? {} : { repo }) }];
}

/** Every direct GitHub review a command line would create. Pure; follows `bash -c '…'` and `eval` bodies a few levels deep. */
export function reviewPublishAttempts(command: string, depth = 0): ReviewPublishAttempt[] {
  const found: ReviewPublishAttempt[] = [];
  for (const segment of splitSegments(command.replace(/\\\r?\n/g, ""))) {
    found.push(...attemptsInSegment(segment.words));
    const head = (segment.words[0] ?? "").split("/").pop() ?? "";
    let body: string | undefined;
    if (SHELLS.has(head)) {
      const at = segment.words.indexOf("-c");
      body = at >= 0 ? segment.words[at + 1] : undefined;
    } else if (head === "eval") {
      body = segment.words.slice(1).join(" ");
    }
    if (body !== undefined && depth < 4) found.push(...reviewPublishAttempts(body, depth + 1));
  }
  return found;
}

type Bound = { dir: string; id: string; status: string; number: number | undefined; repo: string | undefined; mtime: number };

async function boundPackages(cwd: string): Promise<Bound[]> {
  let names: string[];
  try {
    names = (await readdir(reviewsRoot(cwd), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const found: Bound[] = [];
  for (const name of names) {
    const dir = path.join(reviewsRoot(cwd), name);
    const manifest = await readJsonFileOr<ManagedReviewManifest | undefined>(path.join(dir, "manifest.json"), undefined);
    if (manifest === undefined || !isPrBound(manifest.target)) continue;
    const ref = parseRef(manifest.target.ref);
    const info = await stat(path.join(dir, "manifest.json")).catch(() => undefined);
    found.push({ dir, id: manifest.reviewId, status: manifest.status, number: ref.number, repo: ref.repo, mtime: info?.mtimeMs ?? 0 });
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

/**
 * The refusal text when `command` would create a GitHub review on a pull request that has a managed review package which
 * is not READY, or `undefined` when the command is not such a review or no package is bound to the PR.
 */
export async function reviewPublishRefusal(command: string, cwd: string): Promise<string | undefined> {
  const attempts = reviewPublishAttempts(command);
  if (attempts.length === 0) return undefined;
  const packages = await boundPackages(cwd);
  if (packages.length === 0) return undefined;
  for (const attempt of attempts) {
    const candidates =
      attempt.number === undefined
        ? packages.filter((pkg) => pkg.status !== "completed")
        : packages.filter((pkg) => pkg.number === attempt.number && (attempt.repo === undefined || pkg.repo === undefined || pkg.repo === attempt.repo));
    const newest = candidates[0];
    if (newest === undefined) continue;
    const readiness = await computeReadiness(newest.dir);
    const failing = failingItems(readiness);
    if (failing.length === 0) continue;
    return [
      `Refused: review package ${newest.id} is bound to ${attempt.number === undefined ? "the pull request this command targets" : `PR #${attempt.number}`} and its readiness checklist is NOT READY (${failing.length} failing: ${failing.map((item) => item.id).join(", ")}).`,
      `A review reaches GitHub through the checklist, not around it: \`keryx review readiness ${newest.id}\` lists what is missing; \`keryx review publish ${newest.id}\` posts it once it passes, or \`keryx review publish ${newest.id} --partial\` posts it with a "Partial review" header that says what is not covered.`,
    ].join("\n");
  }
  return undefined;
}
