// `keryx review state <verb>`: the durable review.json of a pull request's review (Desktop Review v3, spec «CLI»).
// Only this command writes review.json; the review-orchestrator skill calls it at each step of a Desktop review.
import { parseArgs, type ParseArgsConfig } from "node:util";
import { resolveProjectRoot } from "../lib/contained-path";
import { parsePullRequestUrl, reviewStateId } from "../review/review-state-id";
import {
  appendNote,
  listReviewStates,
  markReview,
  ON_HEAD_MOVE,
  openReviewRound,
  recordPublication,
  REVIEW_MARKS,
  REVIEW_SOURCES,
  REVIEWER_STATES,
  ReviewStateError,
  ROUND_STATES,
  showReviewState,
  updateReviewRound,
  VERDICTS,
  type OnHeadMove,
  type ReviewMark,
  type ReviewRecord,
  type ReviewRound,
  type ReviewSource,
  type ReviewStateOptions,
  type RoundFindings,
  type RoundPatch,
  type RoundPlan,
  type RoundReviewer,
  type RoundState,
  type RoundUsage,
  type Verdict,
} from "../review/review-state";

export const STATE_JSON_VERSION = 1;

export const STATE_USAGE = `keryx review state <verb> ... [--json] [--cwd <dir>]
  keryx review state open --pr <url> --base <sha> --head <sha> [--viewer <login>] [--session <id>] [--settings <key>]
                          [--source desktop|session|scheduled] [--on-head-move ask|follow|ignore] [--reopen]
  keryx review state round --review <id> [--round <n>] [--state planning|dispatching|reconciling|ready|paused]
                           [--package <dir>] [--session <id>] [--plan <slices>,<waves>,<done>/<total>]
                           [--reviewer <role>=running|done|failed[:<findings>]]... [--usage <tokens>[,<usd>]]
                           [--findings <b>,<M>,<m>,<i>[,<carried>,<rechecked>]] [--verdict approve|comment|request-changes]
  keryx review state publish --review <id> --verdict approve|comment|request-changes [--url <url>] [--round <n>]
  keryx review state mark --review <id> --state stale|closed|ready
  keryx review state note --review <id> --text <text>
  keryx review state show --review <id> | --pr <url> [--viewer <login>]
  keryx review state list [--pr <url>]

Keeps .metaproject/reviews/pr/<review-id>/review.json and journal.md. open applies the round rule: the first call opens
round 1; the same base, head and settings key (an unknown key matches any) keeps the round and records a new session;
otherwise round N+1. --session defaults to KERYX_REVIEW_SESSION_ID. --usage sets the round's total, it does not add.
A ready round takes only --verdict, --findings and --usage. --json prints { version: 1, review, round?, action? }
(list: { version: 1, reviews, unreadable }). Errors print one "error: ..." line: exit 1 for a refusal, 2 when
review.json is of another schema or version (left unchanged) or unreadable.`;

const VERBS = ["open", "round", "publish", "mark", "note", "show", "list"] as const;
type Verb = (typeof VERBS)[number];

type Options = NonNullable<ParseArgsConfig["options"]>;
const COMMON: Options = { json: { type: "boolean" }, cwd: { type: "string" } };
const FLAGS: Record<Verb, Options> = {
  open: {
    pr: { type: "string" }, base: { type: "string" }, head: { type: "string" }, viewer: { type: "string" },
    session: { type: "string" }, settings: { type: "string" }, source: { type: "string" },
    "on-head-move": { type: "string" }, reopen: { type: "boolean" },
  },
  round: {
    review: { type: "string" }, round: { type: "string" }, state: { type: "string" }, package: { type: "string" },
    session: { type: "string" }, plan: { type: "string" }, reviewer: { type: "string", multiple: true },
    usage: { type: "string" }, findings: { type: "string" }, verdict: { type: "string" },
  },
  publish: { review: { type: "string" }, verdict: { type: "string" }, url: { type: "string" }, round: { type: "string" } },
  mark: { review: { type: "string" }, state: { type: "string" } },
  note: { review: { type: "string" }, text: { type: "string" } },
  show: { review: { type: "string" }, pr: { type: "string" }, viewer: { type: "string" } },
  list: { pr: { type: "string" } },
};

export interface ReviewStateSeams extends ReviewStateOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

function usageError(message: string): ReviewStateError {
  return new ReviewStateError("invalid", message);
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw usageError(`${flag} must be one of ${allowed.join("|")}, got "${value}"`);
  return value as T;
}

function count(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw usageError(`${flag} needs a whole number, got "${value}"`);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw usageError(`${flag} is too large: ${value}`);
  return n;
}

function roundNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = count(value, "--round");
  if (n < 1) throw usageError("--round starts at 1");
  return n;
}

function required(value: string | undefined, flag: string, verb: Verb): string {
  if (value === undefined || value.trim() === "") throw usageError(`review state ${verb} needs ${flag}`);
  return value;
}

function pullRequest(url: string): { repo: string; number: number; url: string } {
  const pr = parsePullRequestUrl(url);
  if (!pr) throw usageError(`--pr must be a https://github.com/<owner>/<name>/pull/<n> URL, got "${url}"`);
  return { ...pr, url: url.trim() };
}

export function parsePlan(value: string): RoundPlan {
  const match = /^(\d+),(\d+),(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) throw usageError(`--plan must be <slices>,<waves>,<done>/<total>, got "${value}"`);
  const [slices, waves, done, total] = match.slice(1).map((part) => count(part, "--plan")) as [number, number, number, number];
  if (done > total) throw usageError(`--plan done ${done} is more than total ${total}`);
  return { slices, waves, assignments: { done, total } };
}

export function parseReviewer(value: string): RoundReviewer {
  const match = /^([^=\s]+)=([a-z]+)(?::(\d+))?$/.exec(value.trim());
  if (!match) throw usageError(`--reviewer must be <role>=running|done|failed[:<findings>], got "${value}"`);
  const state = oneOf(match[2], REVIEWER_STATES, "--reviewer state");
  return { role: match[1] as string, state: state as RoundReviewer["state"], ...(match[3] !== undefined && { findings: count(match[3], "--reviewer findings") }) };
}

export function parseUsage(value: string): RoundUsage {
  const match = /^(\d+)(?:,(\d+(?:\.\d+)?))?$/.exec(value.trim());
  if (!match) throw usageError(`--usage must be <tokens>[,<usd>], got "${value}"`);
  return { tokens: count(match[1] as string, "--usage"), costUsd: match[2] === undefined ? null : Number(match[2]) };
}

export function parseFindings(value: string): RoundFindings {
  const parts = value.trim().split(",");
  if ((parts.length !== 4 && parts.length !== 6) || parts.some((part) => !/^\d+$/.test(part))) {
    throw usageError(`--findings must be <b>,<M>,<m>,<i>[,<carried>,<rechecked>], got "${value}"`);
  }
  const [blocker, major, minor, info, carried = 0, rechecked = 0] = parts.map((part) => count(part, "--findings"));
  return { blocker: blocker as number, major: major as number, minor: minor as number, info: info as number, carried, rechecked };
}

async function write(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => process.stdout.write(text, (error) => (error ? reject(error) : resolve())));
}

function roundLine(round: ReviewRound): string {
  const plan = round.plan ? `, plan ${round.plan.slices}x${round.plan.waves} ${round.plan.assignments.done}/${round.plan.assignments.total}` : "";
  return `round ${round.number} ${round.state} ${round.baseSha.slice(0, 12)}..${round.headSha.slice(0, 12)}` +
    `${round.package ? `, package ${round.package}` : ""}${round.sessionId ? `, session ${round.sessionId}` : ""}${plan}` +
    `${round.verdict ? `, verdict ${round.verdict}` : ""}`;
}

function reviewLine(review: ReviewRecord): string {
  return `review ${review.id}: ${review.state}, ${review.rounds.length} round(s), ${review.pr.url}`;
}

async function emit(json: boolean, payload: { review: ReviewRecord; round?: ReviewRound; action?: string }): Promise<void> {
  if (json) {
    await write(`${JSON.stringify({ version: STATE_JSON_VERSION, review: payload.review, ...(payload.round && { round: payload.round }), ...(payload.action && { action: payload.action }) })}\n`);
    return;
  }
  const lines = [reviewLine(payload.review)];
  if (payload.round) lines.push(`${payload.action ? `${payload.action}: ` : ""}${roundLine(payload.round)}`);
  await write(`${lines.join("\n")}\n`);
}

/** `keryx review state …`. Never throws for a refusal: prints `error: …` to stderr and sets the exit code (1, or 2). */
export async function runReviewState(args: string[], seams: ReviewStateSeams = {}): Promise<void> {
  const verb = args[0];
  if (verb === undefined || verb === "--help" || verb === "-h" || (args.length === 2 && (args[1] === "--help" || args[1] === "-h"))) {
    console.log(STATE_USAGE);
    return;
  }
  try {
    if (!(VERBS as readonly string[]).includes(verb)) throw usageError(`unknown review state verb "${verb}"; expected one of ${VERBS.join("|")}`);
    await runVerb(verb as Verb, args.slice(1), seams);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message.split("\n")[0]}`);
    process.exitCode = error instanceof ReviewStateError && (error.code === "foreign" || error.code === "unreadable") ? 2 : 1;
  }
}

function parse(verb: Verb, args: string[]) {
  try {
    return parseArgs({ args, strict: true, allowPositionals: false, options: { ...COMMON, ...FLAGS[verb] } }).values as Record<string, string | string[] | boolean | undefined>;
  } catch (error) {
    const accepted = Object.keys({ ...COMMON, ...FLAGS[verb] }).map((flag) => `--${flag}`).join(" ");
    throw usageError(`${error instanceof Error ? error.message : String(error)} (review state ${verb} accepts ${accepted})`);
  }
}

async function runVerb(verb: Verb, args: string[], seams: ReviewStateSeams): Promise<void> {
  const v = parse(verb, args);
  const str = (name: string): string | undefined => v[name] as string | undefined;
  const json = v.json === true;
  const projectRoot = resolveProjectRoot(str("cwd") ?? seams.cwd ?? process.cwd());
  const options: ReviewStateOptions = seams.now ? { now: seams.now } : {};

  switch (verb) {
    case "open": {
      const env = seams.env ?? process.env;
      const result = await openReviewRound(projectRoot, {
        pr: pullRequest(required(str("pr"), "--pr", verb)),
        viewer: str("viewer") ?? null,
        baseSha: required(str("base"), "--base", verb),
        headSha: required(str("head"), "--head", verb),
        settingsKey: str("settings") ?? null,
        sessionId: str("session") ?? env.KERYX_REVIEW_SESSION_ID ?? null,
        ...(str("source") !== undefined && { source: oneOf(str("source"), REVIEW_SOURCES, "--source") as ReviewSource }),
        ...(str("on-head-move") !== undefined && { onHeadMove: oneOf(str("on-head-move"), ON_HEAD_MOVE, "--on-head-move") as OnHeadMove }),
        reopen: v.reopen === true,
      }, options);
      await emit(json, result);
      return;
    }
    case "round": {
      const round = roundNumber(str("round"));
      const patch: RoundPatch = {
        ...(round !== undefined && { round }),
        ...(str("state") !== undefined && { state: oneOf(str("state"), ROUND_STATES, "--state") as RoundState }),
        ...(str("package") !== undefined && { package: required(str("package"), "a non-empty --package", verb) }),
        ...(str("session") !== undefined && { sessionId: required(str("session"), "a non-empty --session", verb) }),
        ...(str("plan") !== undefined && { plan: parsePlan(str("plan") as string) }),
        ...(v.reviewer !== undefined && { reviewers: (v.reviewer as string[]).map(parseReviewer) }),
        ...(str("usage") !== undefined && { usage: parseUsage(str("usage") as string) }),
        ...(str("findings") !== undefined && { findings: parseFindings(str("findings") as string) }),
        ...(str("verdict") !== undefined && { verdict: oneOf(str("verdict"), VERDICTS, "--verdict") as Verdict }),
      };
      const fields = Object.keys(patch).filter((key) => key !== "round");
      if (fields.length === 0) throw usageError("review state round needs at least one field to set");
      await emit(json, await updateReviewRound(projectRoot, required(str("review"), "--review", verb), patch, options));
      return;
    }
    case "publish": {
      const verdict = oneOf(required(str("verdict"), "--verdict", verb), VERDICTS, "--verdict") as Verdict;
      const round = roundNumber(str("round"));
      const url = str("url");
      await emit(json, await recordPublication(projectRoot, required(str("review"), "--review", verb), {
        verdict, ...(url !== undefined && { url }), ...(round !== undefined && { round }),
      }, options));
      return;
    }
    case "mark": {
      const mark = oneOf(required(str("state"), "--state", verb), REVIEW_MARKS, "--state") as ReviewMark;
      await emit(json, await markReview(projectRoot, required(str("review"), "--review", verb), mark, options));
      return;
    }
    case "note": {
      await emit(json, await appendNote(projectRoot, required(str("review"), "--review", verb), required(str("text"), "--text", verb), options));
      return;
    }
    case "show": {
      const review = str("review");
      const pr = str("pr");
      if ((review === undefined) === (pr === undefined)) throw usageError("review state show needs exactly one of --review or --pr");
      if (review !== undefined && str("viewer") !== undefined) throw usageError("--viewer goes with --pr, not --review");
      const id = review ?? (() => {
        const parsed = pullRequest(pr as string);
        return reviewStateId(parsed.repo, parsed.number, str("viewer") ?? null);
      })();
      const record = await showReviewState(projectRoot, id);
      const round = record.rounds[record.rounds.length - 1];
      await emit(json, { review: record, ...(round && { round }) });
      return;
    }
    case "list": {
      const listing = await listReviewStates(projectRoot);
      const pr = str("pr");
      const filter = pr === undefined ? undefined : pullRequest(pr);
      const reviews = filter
        ? listing.reviews.filter((r) => r.pr.repo.toLowerCase() === filter.repo.toLowerCase() && r.pr.number === filter.number)
        : listing.reviews;
      if (json) {
        await write(`${JSON.stringify({ version: STATE_JSON_VERSION, reviews, unreadable: listing.unreadable })}\n`);
      } else {
        const lines = reviews.map(reviewLine);
        for (const bad of listing.unreadable) lines.push(`review ${bad.id}: unreadable (${bad.reason})`);
        await write(lines.length > 0 ? `${lines.join("\n")}\n` : "no reviews\n");
      }
      // A foreign or broken review.json makes the listing incomplete: say so with the "could not tell" code.
      if (listing.unreadable.length > 0) process.exitCode = 2;
      return;
    }
  }
}
