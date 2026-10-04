// Flow 403 (AC1): the five kinds of event, read from GitHub and the board.
//
// Every GitHub call is a catalogue tool with a fixed argv (`../trigger/granted-tools`), run through the same
// seam as the digest (`GhRunner`), with the identity of the pinned `gh` re-checked before each exec. A call that
// fails, or answers with something that is not the JSON it promises, becomes a failure ENTRY for that one source;
// the others still run. Nothing here writes: the catalogue holds no verb that could.
//
// Sources, per repository:
//   issue:<repo>    tickets assigned to the operator        -> `issue:<repo>#<n>`
//   review:<repo>   review requested from the operator      -> `review:<repo>#<n>`
//   pr:<repo>       the operator's own PRs and their comments -> `comment:<repo>#<n>:<commentId>`
//   ci:<repo>       failed runs on the branches of those PRs -> `ci:<repo>:<runId>`
// and one `board` source from the product index -> `board:<id>`.

import { identityOf, sameIdentity, type VerifiedFile } from "../trigger/granted-binary";
import { buildGrantedArgv, ghReadOnlyProblem, grantedToolSpec, INTAKE_TOOL_IDS } from "../trigger/granted-tools";
import type { GrantedCallRecord } from "../trigger/record";
import { readBoard } from "../scheduler/digest-board";
import type { GhRunner } from "../scheduler/digest-gh";
import type { RunLimits } from "../scheduler/digest-limits";
import type { IntakeEvent, IntakeFailure } from "./types";

const BODY_MAX = 4000;

export interface IntakeSourceRead {
  /** `issue:<repo>`, `review:<repo>`, `pr:<repo>`, `ci:<repo>` or `board`. */
  readonly source: string;
  readonly events: readonly IntakeEvent[];
}

export interface IntakeCollectInput {
  readonly projectRoot: string;
  readonly repos: readonly string[];
  readonly rows: number;
  readonly bin: string | undefined;
  readonly stats: readonly VerifiedFile[];
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly runGh: GhRunner;
  readonly limits: RunLimits;
}

export interface IntakeCollectResult {
  /** Sources read without error. A source that failed is absent: its events are neither new nor gone. */
  readonly reads: readonly IntakeSourceRead[];
  readonly failures: readonly IntakeFailure[];
  readonly calls: readonly GrantedCallRecord[];
  /** True when a limit stopped the collection before every source was read. */
  readonly stopped: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function login(value: unknown): string | undefined {
  return str(record(value)?.["login"]);
}

function rows(stdout: string): Record<string, unknown>[] | { readonly error: string } {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { error: "gh did not answer with JSON" };
  }
  if (!Array.isArray(data)) return { error: "gh answered with something other than a list" };
  return data.map(record).filter((r): r is Record<string, unknown> => r !== undefined);
}

function numberOf(r: Record<string, unknown>): string | undefined {
  return typeof r["number"] === "number" && Number.isInteger(r["number"]) && r["number"] > 0 ? String(r["number"]) : undefined;
}

type Parsed<T> = T | { readonly error: string };

/** Tickets assigned to the operator. The stamp is `updatedAt`; a later change of it never makes a second event. */
export function parseAssignedIssues(repo: string, stdout: string): Parsed<IntakeEvent[]> {
  const list = rows(stdout);
  if (!Array.isArray(list)) return list;
  const events: IntakeEvent[] = [];
  for (const r of list) {
    const n = numberOf(r);
    const updated = str(r["updatedAt"]);
    if (n === undefined || updated === undefined) continue;
    const url = str(r["url"]);
    const author = login(r["author"]);
    const body = str(r["body"]);
    events.push({
      key: `issue:${repo}#${n}`,
      kind: "issue",
      repo,
      ref: n,
      title: str(r["title"]) ?? `#${n}`,
      ...(url !== undefined ? { url } : {}),
      stamp: updated,
      ...(author !== undefined ? { author } : {}),
      ...(body !== undefined ? { body: body.slice(0, BODY_MAX) } : {}),
    });
  }
  return events;
}

export function parseReviewRequests(repo: string, stdout: string): Parsed<IntakeEvent[]> {
  const list = rows(stdout);
  if (!Array.isArray(list)) return list;
  const events: IntakeEvent[] = [];
  for (const r of list) {
    const n = numberOf(r);
    const updated = str(r["updatedAt"]);
    if (n === undefined || updated === undefined) continue;
    const url = str(r["url"]);
    const author = login(r["author"]);
    events.push({
      key: `review:${repo}#${n}`,
      kind: "review",
      repo,
      ref: n,
      title: str(r["title"]) ?? `#${n}`,
      ...(url !== undefined ? { url } : {}),
      stamp: updated,
      ...(author !== undefined ? { author } : {}),
    });
  }
  return events;
}

export interface OwnPrs {
  readonly comments: readonly IntakeEvent[];
  /** `headRefName` of every open PR of the operator: the failed runs worth a card are the ones on these. */
  readonly branches: ReadonlySet<string>;
}

/** The operator's own PRs: a comment event per comment somebody else wrote, and the branches. */
export function parseOwnPrs(repo: string, stdout: string): Parsed<OwnPrs> {
  const list = rows(stdout);
  if (!Array.isArray(list)) return list;
  const comments: IntakeEvent[] = [];
  const branches = new Set<string>();
  for (const pr of list) {
    const n = numberOf(pr);
    if (n === undefined) continue;
    const branch = str(pr["headRefName"]);
    if (branch !== undefined) branches.add(branch);
    const prAuthor = login(pr["author"]);
    const prTitle = str(pr["title"]) ?? `#${n}`;
    const prUrl = str(pr["url"]);
    const raw = pr["comments"];
    if (!Array.isArray(raw)) continue;
    for (const c of raw) {
      const r = record(c);
      if (r === undefined) continue;
      const id = str(r["id"]);
      const created = str(r["createdAt"]);
      if (id === undefined || created === undefined) continue;
      const author = login(r["author"]);
      if (r["viewerDidAuthor"] === true || (author !== undefined && author === prAuthor)) continue;
      const url = str(r["url"]) ?? prUrl;
      const body = str(r["body"]);
      comments.push({
        key: `comment:${repo}#${n}:${id}`,
        kind: "comment",
        repo,
        ref: id,
        title: `PR #${n}: ${prTitle}`,
        ...(url !== undefined ? { url } : {}),
        stamp: created,
        ...(author !== undefined ? { author } : {}),
        ...(body !== undefined ? { body: body.slice(0, BODY_MAX) } : {}),
      });
    }
  }
  return { comments, branches };
}

/** Failed runs, kept only when they ran on a branch of one of the operator's PRs. */
export function parseFailedRuns(repo: string, stdout: string, branches: ReadonlySet<string>): Parsed<IntakeEvent[]> {
  const list = rows(stdout);
  if (!Array.isArray(list)) return list;
  const events: IntakeEvent[] = [];
  for (const r of list) {
    const id = typeof r["databaseId"] === "number" ? String(r["databaseId"]) : undefined;
    const created = str(r["createdAt"]);
    const branch = str(r["headBranch"]);
    if (id === undefined || created === undefined || branch === undefined || !branches.has(branch)) continue;
    const url = str(r["url"]);
    events.push({
      key: `ci:${repo}:${id}`,
      kind: "ci",
      repo,
      ref: id,
      title: `${str(r["displayTitle"]) ?? "workflow run"} (${branch})`,
      ...(url !== undefined ? { url } : {}),
      stamp: created,
    });
  }
  return events;
}

export async function collectIntakeEvents(input: IntakeCollectInput): Promise<IntakeCollectResult> {
  const { limits } = input;
  const reads: IntakeSourceRead[] = [];
  const failures: IntakeFailure[] = [];
  const calls: GrantedCallRecord[] = [];
  let stopped = false;

  const call = async (toolId: string, repo: string, source: string): Promise<string | undefined> => {
    const spec = grantedToolSpec(toolId);
    if (spec === undefined) {
      failures.push({ source, detail: `tool ${toolId} is not in the catalogue` });
      return undefined;
    }
    // Intake runs only the tools it was built for, and only while each is still a read-only `gh` command: a catalogue
    // entry that gained a mutating verb, or one that was never meant for intake, is refused before anything is spawned.
    if (!INTAKE_TOOL_IDS.includes(toolId)) {
      failures.push({ source, detail: `refused — tool ${toolId} is not one of the tools intake may run` });
      return undefined;
    }
    const readOnly = ghReadOnlyProblem(spec);
    if (readOnly.length > 0) {
      failures.push({ source, detail: `refused — ${readOnly.join("; ")}` });
      return undefined;
    }
    const built = buildGrantedArgv(spec, { repo, limit: String(input.rows) }, input.repos);
    if (!built.ok) {
      failures.push({ source, detail: built.reason });
      return undefined;
    }
    if (input.bin === undefined) {
      failures.push({ source, detail: 'no absolute path for "gh" was verified for this run' });
      return undefined;
    }
    // The binary was hashed at run start; before each exec it must still be the same file.
    const changed = input.stats.find((f) => !sameIdentity(f.identity, identityOf(f.file)));
    if (changed !== undefined) {
      failures.push({ source, detail: `refused — ${changed.file} changed since it was verified at the start of this run` });
      return undefined;
    }
    const result = await input.runGh({ bin: input.bin, argv: built.argv, env: input.env, cwd: input.cwd, signal: limits.signal, secrets: [] });
    calls.push({ tool: spec.tool, argv: [input.bin, ...built.argv], exitCode: result.exitCode, ok: result.ok });
    if (limits.checkpoint()) {
      stopped = true;
      return undefined;
    }
    if (!result.ok) {
      failures.push({ source, detail: `${spec.tool} failed: ${result.detail}` });
      return undefined;
    }
    return result.stdout;
  };

  outer: for (const repo of input.repos) {
    const fail = (source: string, error: string): void => {
      failures.push({ source, detail: error });
    };

    const issues = await call("gh.issue.assigned", repo, `issue:${repo}`);
    if (stopped) break outer;
    if (issues !== undefined) {
      const parsed = parseAssignedIssues(repo, issues);
      if ("error" in parsed) fail(`issue:${repo}`, parsed.error);
      else reads.push({ source: `issue:${repo}`, events: parsed });
    }

    const reviews = await call("gh.pr.review-requested", repo, `review:${repo}`);
    if (stopped) break outer;
    if (reviews !== undefined) {
      const parsed = parseReviewRequests(repo, reviews);
      if ("error" in parsed) fail(`review:${repo}`, parsed.error);
      else reads.push({ source: `review:${repo}`, events: parsed });
    }

    let branches: ReadonlySet<string> | undefined;
    const own = await call("gh.pr.comments", repo, `pr:${repo}`);
    if (stopped) break outer;
    if (own !== undefined) {
      const parsed = parseOwnPrs(repo, own);
      if ("error" in parsed) fail(`pr:${repo}`, parsed.error);
      else {
        reads.push({ source: `pr:${repo}`, events: parsed.comments });
        branches = parsed.branches;
      }
    }

    // A failed run is the operator's only when it ran on one of his PR branches, so without that list the source is not read.
    if (branches === undefined) {
      fail(`ci:${repo}`, "not read — the operator's own pull requests could not be listed, so failed runs cannot be matched to them");
    } else {
      const runs = await call("gh.run.failed", repo, `ci:${repo}`);
      if (stopped) break outer;
      if (runs !== undefined) {
        const parsed = parseFailedRuns(repo, runs, branches);
        if ("error" in parsed) fail(`ci:${repo}`, parsed.error);
        else reads.push({ source: `ci:${repo}`, events: parsed });
      }
    }
  }

  if (!stopped && !limits.checkpoint()) {
    const board = await readBoard(input.projectRoot);
    if (board.failure !== undefined) failures.push(board.failure);
    else {
      reads.push({
        source: "board",
        events: board.items.map((item) => ({ key: item.key, kind: "board" as const, ref: item.id, title: item.title, stamp: item.stamp })),
      });
    }
  } else if (!stopped) {
    stopped = true;
  }
  return { reads, failures, calls, stopped };
}
