// Flow 389 (AC2): the digest's calls to GitHub.
//
// For every allowed repository and every granted digest tool, one fixed-argv,
// read-only catalogue call (`gh pr list`, `gh issue list`, the review-requested
// search, failed CI runs). The answers are parsed into `DigestItem`s and also
// kept verbatim (capped) for the run report. A call that fails, or answers with
// something that is not the JSON the tool promises, becomes a failure ENTRY for that
// one source; the other sources still run.
//
// The model never sees these calls and chooses nothing here: the argv comes from
// the catalogue and the repositories from `action.grants.repos`.

import { identityOf, sameIdentity, type VerifiedFile } from "../trigger/granted-binary";
import type { AgentTaskAction } from "../trigger/config";
import { buildGrantedArgv, DIGEST_TOOL_IDS, grantedToolSpec } from "../trigger/granted-tools";
import type { GrantedCallRecord } from "../trigger/record";
import type { DigestFailure } from "./digest-content";
import type { GhRunner } from "./digest-gh";
import type { RunLimits } from "./digest-limits";
import type { DigestItem, DigestSourceKind } from "./digest-snapshot";

/** Which source kind each digest tool feeds. */
const KIND_OF_TOOL: Readonly<Record<string, DigestSourceKind>> = {
  "gh.pr.list": "pr",
  "gh.issue.list": "issue",
  "gh.pr.review-requested": "review",
  "gh.run.failed": "ci",
};

/** Rows asked of each list call. The catalogue caps it at 999. */
export const DIGEST_ROWS = 100;
const ROWS = String(DIGEST_ROWS);
/** Raw answers kept in the report, per call. */
export const RAW_REPORT_CHARS = 20_000;

export interface RawAnswer {
  readonly source: string;
  readonly tool: string;
  readonly argv: readonly string[];
  readonly ok: boolean;
  readonly text: string;
}

export interface CollectResult {
  readonly items: readonly DigestItem[];
  readonly failures: readonly DigestFailure[];
  /** `pr:<repo>`, ... — sources that could not be read, so the diff does not mistake them for "gone". */
  readonly failedSources: ReadonlySet<string>;
  /**
   * Sources that answered with as many rows as were asked for (`DIGEST_ROWS`): the answer may be
   * only the newest part of a longer list. The snapshot keeps their previous entries and the diff
   * reports none of them as "gone", exactly like a failed source, but this run's items still count.
   */
  readonly truncatedSources: ReadonlySet<string>;
  readonly raw: readonly RawAnswer[];
  readonly calls: readonly GrantedCallRecord[];
  /** True when a limit stopped the collection before every source was read. */
  readonly stopped: boolean;
}

export interface CollectInput {
  readonly action: AgentTaskAction;
  readonly bin: string | undefined;
  readonly stats: Readonly<Record<string, readonly VerifiedFile[]>>;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly runGh: GhRunner;
  readonly limits: RunLimits;
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

/** How many rows the answer held, counting rows `parseDigestItems` skips. 0 for an answer that is not a JSON list. */
export function rowCount(stdout: string): number {
  try {
    const data: unknown = JSON.parse(stdout);
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

/** The note a truncated source puts in the digest. */
export function truncationNote(source: string): DigestFailure {
  return {
    source,
    detail: `truncated at ${DIGEST_ROWS} — only ${DIGEST_ROWS} rows were read, so older entries are kept from the last digest and none is reported as closed or merged`,
  };
}

/** Parse one tool's JSON answer. Returns the items, or the reason the answer is unusable. */
export function parseDigestItems(kind: DigestSourceKind, repo: string, stdout: string): DigestItem[] | { readonly error: string } {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { error: "gh did not answer with JSON" };
  }
  if (!Array.isArray(data)) return { error: "gh answered with something other than a list" };
  const items: DigestItem[] = [];
  for (const row of data) {
    const r = record(row);
    if (r === undefined) continue;
    if (kind === "ci") {
      const id = typeof r["databaseId"] === "number" ? String(r["databaseId"]) : undefined;
      const created = str(r["createdAt"]);
      if (id === undefined || created === undefined) continue;
      const title = `${str(r["displayTitle"]) ?? "workflow run"}${str(r["headBranch"]) !== undefined ? ` (${str(r["headBranch"])})` : ""}`;
      const url = str(r["url"]);
      items.push({ key: `ci:${repo}#${id}`, kind, repo, id, title, ...(url !== undefined ? { url } : {}), stamp: created });
      continue;
    }
    const number = typeof r["number"] === "number" ? String(r["number"]) : undefined;
    const updated = str(r["updatedAt"]);
    if (number === undefined || updated === undefined) continue;
    const author = login(r["author"]);
    const url = str(r["url"]);
    const decision = str(r["reviewDecision"]);
    items.push({
      key: `${kind}:${repo}#${number}`,
      kind,
      repo,
      id: number,
      title: str(r["title"]) ?? `#${number}`,
      ...(url !== undefined ? { url } : {}),
      stamp: updated,
      ...(author !== undefined ? { author } : {}),
      ...(typeof r["isDraft"] === "boolean" ? { draft: r["isDraft"] } : {}),
      ...(decision !== undefined ? { reviewDecision: decision } : {}),
    });
  }
  return items;
}

export async function collectFromGithub(input: CollectInput): Promise<CollectResult> {
  const { action, limits } = input;
  const items: DigestItem[] = [];
  const failures: DigestFailure[] = [];
  const failedSources = new Set<string>();
  const truncatedSources = new Set<string>();
  const raw: RawAnswer[] = [];
  const calls: GrantedCallRecord[] = [];
  const tools = DIGEST_TOOL_IDS.filter((id) => action.grants.tools.includes(id));
  let stopped = false;

  if (tools.length === 0) failures.push({ source: "github", detail: "no digest tool is granted to this schedule" });

  outer: for (const repo of action.grants.repos) {
    for (const id of tools) {
      if (limits.signal.aborted) {
        stopped = true;
        break outer;
      }
      const spec = grantedToolSpec(id);
      const kind = KIND_OF_TOOL[id];
      if (spec === undefined || kind === undefined) continue;
      const source = `${kind}:${repo}`;
      const built = buildGrantedArgv(spec, { repo, limit: ROWS }, action.grants.repos);
      if (!built.ok) {
        failures.push({ source, detail: built.reason });
        failedSources.add(source);
        continue;
      }
      if (input.bin === undefined) {
        failures.push({ source, detail: `no absolute path for "gh" was confirmed with this schedule` });
        failedSources.add(source);
        continue;
      }
      // The binary was hashed at run start; before each exec it must still be the same file.
      const changed = (input.stats[spec.program] ?? []).find((f) => !sameIdentity(f.identity, identityOf(f.file)));
      if (changed !== undefined) {
        failures.push({ source, detail: `refused — ${changed.file} changed since it was verified at the start of this run` });
        failedSources.add(source);
        continue;
      }
      const result = await input.runGh({ bin: input.bin, argv: built.argv, env: input.env, cwd: input.cwd, signal: limits.signal, secrets: [] });
      calls.push({ tool: spec.tool, argv: [input.bin, ...built.argv], exitCode: result.exitCode, ok: result.ok });
      raw.push({ source, tool: spec.tool, argv: built.argv, ok: result.ok, text: result.ok ? result.stdout.slice(0, RAW_REPORT_CHARS) : result.detail });
      if (limits.checkpoint()) {
        stopped = true;
        break outer;
      }
      if (!result.ok) {
        failures.push({ source, detail: `${spec.tool} failed: ${result.detail}` });
        failedSources.add(source);
        continue;
      }
      const parsed = parseDigestItems(kind, repo, result.stdout);
      if ("error" in parsed) {
        failures.push({ source, detail: `${spec.tool}: ${parsed.error}` });
        failedSources.add(source);
        continue;
      }
      if (rowCount(result.stdout) >= DIGEST_ROWS) truncatedSources.add(source);
      items.push(...parsed);
    }
  }
  return { items, failures, failedSources, truncatedSources, raw, calls, stopped };
}
