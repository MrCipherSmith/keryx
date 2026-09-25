// `keryx review learn --reviewer <id>` (W3 spec "Reviewer profiles"; plan
// module table; flow 312 T9). Renders the accepted, `domain:
// "review-conventions"` records generalized to one reviewer identity into
// `.metaproject/rules/reviewers/<reviewer-id>.mdc` — a per-reviewer sibling
// of the existing per-skill `keryx review learn` join, with the same
// discipline: file lock, `isPathInside` boundary, semver header, changelog,
// and (`code-review-learned-profile.mdc`'s guardrail) never the literal
// login.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isPathInside, pathExists, withFileLock } from "../lib/fs";
import { writeContained } from "../lib/contained-write";
import { loadReviewLearningConfig } from "../review/review-learning";
import { gateReviewerText, generalizeLesson } from "./reviewer-id";
import { scanLearnedText } from "./scan";
import { listPatterns, type StoreEnvOptions } from "./store";
import type { LearnedPattern } from "./types";

export class LearningReviewerProfileError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "LearningReviewerProfileError";
  }
}

const REVIEWER_ID_PATTERN = /^rv-[a-f0-9]{16}$/;

const VERSION_COMMENT = /<!--\s*reviewer-profile-version:\s*(\d+)\.(\d+)\.(\d+)\s*-->/;
const CONVENTIONS_SECTION = /## Conventions\n\n([\s\S]*?)\n\n## Changelog/;

export interface RenderReviewerProfileOptions {
  version: string;
  changelog: string[];
}

/**
 * Pure: `.mdc` frontmatter + a semver header comment + generalized,
 * deduplicated conventions + a changelog block + the no-attribution note.
 * Never receives raw comment text — callers pass already-generalized
 * `actions` (see `generalizeLesson`).
 */
export function renderReviewerProfile(reviewerId: string, actions: readonly string[], options: RenderReviewerProfileOptions): string {
  const conventions =
    actions.length > 0
      ? actions.map((action) => `- ${action}`).join("\n")
      : "- No generalized conventions recorded yet.";
  const changelog = options.changelog.length > 0 ? options.changelog.join("\n") : "- (none)";

  return `---
description: "Learned review conventions for reviewer profile ${reviewerId}"
alwaysApply: false
---
<!-- reviewer-profile-version: ${options.version} -->

# Reviewer Profile \`${reviewerId}\`

Generalized conventions this project has learned from this reviewer's pull-request
comments. This file describes conventions, not people: it states what tends to
get flagged, never who flagged it, and carries no literal login, display name, or
first-person phrasing — the same discipline
\`.metaproject/rules/core/code-review-learned-profile.mdc\` and
\`code-learned-review/SKILL.md\` already require of the per-skill learning path,
applied here to a per-reviewer rule instead. A finding raised from this profile
still may not restate a lesson as a claim about who is usually right — the
record says a comment was left, nothing more.

## Conventions

${conventions}

## Changelog

${changelog}
`;
}

function parseVersion(content: string): [number, number, number] | undefined {
  const match = content.match(VERSION_COMMENT);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function bumpMinor([major, minor]: [number, number, number]): string {
  return `${major}.${minor + 1}.0`;
}

function bumpPatch([major, minor, patch]: [number, number, number]): string {
  return `${major}.${minor}.${patch + 1}`;
}

function parseExistingActions(content: string): string[] {
  const match = content.match(CONVENTIONS_SECTION);
  if (!match || match[1] === undefined) return [];
  return match[1]
    .split("\n")
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => line.length > 0 && line !== "No generalized conventions recorded yet.");
}

function parseExistingChangelog(content: string): string[] {
  const start = content.indexOf("## Changelog");
  if (start < 0) return [];
  const body = content.slice(start + "## Changelog".length);
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") && line !== "- (none)");
}

/** Every distinct login `.metaproject/review-learning.config.json` configures — the set generalized text is stripped against, since a reviewer id cannot be reversed back to its login. Empty when the project has no config. */
async function configuredAuthors(root: string): Promise<string[]> {
  const config = await loadReviewLearningConfig(root);
  return config?.authors ?? [];
}

function generalizedActionsFor(records: readonly LearnedPattern[], authors: readonly string[]): string[] {
  const actions: string[] = [];
  for (const record of records) {
    const generalized = generalizeLesson(record.action, authors);
    if (generalized !== null && !actions.includes(generalized)) actions.push(generalized);
  }
  return actions;
}

/**
 * Refuses (via `gateReviewerText`, identifier-boundary match) if any
 * generalized action still carries a configured author's login — the final
 * gate independent of `generalizeLesson`'s own stripping (AC7).
 *
 * Checked ONLY over this variable content — each record's own `provenance`
 * (these are all `domain: "review-conventions"` records, which today only
 * the `reviewer-comment` signal ever produces) with its already-generalized
 * `action` — never the surrounding rendered document. This used to run a
 * plain, whole-rendered-document `String.includes` scan, which matched a
 * configured login sitting inside `renderReviewerProfile`'s OWN fixed
 * template prose rather than anything a reviewer said: `revie`/`conve`/
 * `learn`/`profi` are substrings of "review-conventions"/"Learned
 * conventions"/"reviewer profile" — literal words in the frontmatter
 * description, the `# Reviewer Profile` heading, and the "conventions this
 * project has **learn**ed" sentence — so a project that configured any of
 * those logins had EVERY reviewer-profile write refused, no matter what any
 * lesson said. Restricting the check to the variable text (and using the
 * same identifier-boundary rule `gateReviewerText`/`containsConfiguredLogin`
 * use everywhere else, rather than a separate raw substring test) fixes that
 * without reopening the attribution leak this gate exists to catch.
 *
 * R9-F1/R9-F2 (review round 9, PR #691): this used to also pass `reviewerId`
 * as a `gateReviewerText` `extraTokens` entry, as cheap defense-in-depth.
 * `reviewerId` is always `reviewerIdFor`'s opaque `rv-<16 hex chars>` output
 * (`REVIEWER_ID_PATTERN` validates that shape before this is ever called) —
 * it can never equal a human-configured login or a hyphen/underscore piece
 * of one, so the check could never fire. `extraTokens` itself is removed
 * from `gateReviewerText` (see that file) now that its one other caller,
 * `applyGraduation`'s stored-token re-check, is gone too — so `reviewerId`
 * is simply never checked here any more.
 */
function refuseIfAttributed(records: readonly LearnedPattern[], authors: readonly string[]): void {
  if (authors.length === 0) return;
  const refused = records.some((record) => {
    const generalized = generalizeLesson(record.action, authors);
    if (generalized === null) return false; // dropped by generalizeLesson itself; contributes nothing to render either.
    return gateReviewerText({ provenance: record.provenance, trigger: "", action: generalized }, authors).refused;
  });
  if (refused) {
    throw new LearningReviewerProfileError(
      "reviewer-profile-attribution-refused",
      `refusing to write a reviewer profile containing a configured author's login`,
    );
  }
}

export interface ApplyReviewerProfileOptions extends StoreEnvOptions {
  dryRun?: boolean;
  now?: () => Date;
}

export interface ApplyReviewerProfileResult {
  path: string;
  version: string;
  added: number;
}

/**
 * Gathers every `status: "accepted"`, `scope: "project"`,
 * `domain: "review-conventions"` record whose `reviewerProfile.reviewerId`
 * matches `reviewerId`, rescans their text, generalizes their `action`s, and
 * (unless `dryRun`) writes/updates
 * `.metaproject/rules/reviewers/<reviewerId>.mdc`. Refuses:
 *  - a malformed id (`reviewer-profile-invalid-id`) — also closes the
 *    traversal case, since `rv-[a-f0-9]{16}` cannot contain `/` or `..`;
 *  - no matching accepted record (`reviewer-profile-no-accepted-records`);
 *  - `trigger`/`action` failing the security scan (`learning-text-refused`);
 *  - a resolved target outside `.metaproject/rules/reviewers/`
 *    (`reviewer-profile-path-outside-root`, via `isPathInside` — defence in
 *    depth behind the id-pattern check above);
 *  - the reviewer id or any generalized action still carrying a configured
 *    author's literal login (`reviewer-profile-attribution-refused`).
 */
export async function applyReviewerProfile(
  root: string,
  reviewerId: string,
  opts: ApplyReviewerProfileOptions = {},
): Promise<ApplyReviewerProfileResult> {
  if (!REVIEWER_ID_PATTERN.test(reviewerId)) {
    throw new LearningReviewerProfileError("reviewer-profile-invalid-id", `not a reviewer id: ${JSON.stringify(reviewerId)}`);
  }

  const storeOptions: StoreEnvOptions = {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
  };

  const candidates = await listPatterns(root, { scope: "project", status: "accepted", domain: "review-conventions" }, storeOptions);
  const records = candidates.filter((record) => record.reviewerProfile?.reviewerId === reviewerId);
  if (records.length === 0) {
    throw new LearningReviewerProfileError(
      "reviewer-profile-no-accepted-records",
      `no accepted review-conventions record for reviewer profile "${reviewerId}"`,
    );
  }

  const scan = await scanLearnedText(root, records.flatMap((record) => [record.trigger, record.action]));
  if (scan.findings.length > 0) {
    throw new LearningReviewerProfileError(
      "learning-text-refused",
      `reviewer profile "${reviewerId}" refused by the security scan: ${scan.findings.join(", ")}`,
    );
  }

  const reviewersDir = path.join(root, ".metaproject", "rules", "reviewers");
  const target = path.join(reviewersDir, `${reviewerId}.mdc`);
  if (!isPathInside(reviewersDir, target)) {
    throw new LearningReviewerProfileError(
      "reviewer-profile-path-outside-root",
      `refusing to write outside .metaproject/rules/reviewers/: ${target}`,
    );
  }

  const authors = await configuredAuthors(root);
  const actions = generalizedActionsFor(records, authors);
  refuseIfAttributed(records, authors);
  const now = (opts.now ?? ((): Date => new Date()))();
  const dateStamp = now.toISOString().slice(0, 10);

  return withFileLock(path.join(reviewersDir, "reviewers.lock"), async () => {
    const exists = await pathExists(target);
    const previous = exists ? await readFile(target, "utf8") : undefined;
    const previousVersion = previous !== undefined ? parseVersion(previous) : undefined;
    const previousActions = previous !== undefined ? new Set(parseExistingActions(previous)) : new Set<string>();
    const previousChangelog = previous !== undefined ? parseExistingChangelog(previous) : [];

    const added = actions.filter((action) => !previousActions.has(action)).length;
    const version =
      previousVersion === undefined ? "0.1.0" : added > 0 ? bumpMinor(previousVersion) : bumpPatch(previousVersion);

    const changelogEntry = `- ${version} (${dateStamp}): ${added > 0 ? `${added} convention(s) added` : "reinforced, no new conventions"}.`;
    const rendered = renderReviewerProfile(reviewerId, actions, {
      version,
      changelog: [...previousChangelog, changelogEntry],
    });

    if (opts.dryRun !== true) {
      await writeContained(root, path.relative(root, target), rendered);
    }

    return { path: path.posix.join(".metaproject", "rules", "reviewers", `${reviewerId}.mdc`), version, added };
  });
}
