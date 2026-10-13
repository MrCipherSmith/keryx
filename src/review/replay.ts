import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { withoutGitDiscoveryOverrides } from "../lib/git-env";
import { isEmptyOutput, isReviewerResult, parseReviewResult, type ParsedResult } from "./ledger";
import { legacyParseReviewResult } from "./legacy-result-parser";

export type ReplayCause = "fence-inner-backticks" | "status-only-fragment" | "unclassified" | "none";

export interface ReplayRow {
  file: string;
  hash: string;
  old: string;
  next: string;
  same: boolean;
  cause: ReplayCause;
}

const FLOW = ".metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews";
const ROUND2 = `${FLOW}/2026-10-13-pr-997-round2-d5a8cfdc/raw`;
const ROUND3 = `${FLOW}/2026-10-13-pr-997-round3-07730d87/raw`;
const POLL_161 = "accepted (operator, poll 161, 2026-10-13)";
const POLL_162_163 = "accepted (operator, polls 162 and 163, 2026-10-13)";

export function decisionKey(row: Pick<ReplayRow, "file" | "hash">): string {
  return `${row.file}@${row.hash}`;
}

/** One entry per differing file and content hash. A row not listed here is `undecided`, whatever its cause. */
export const DECISIONS: Record<string, string> = {
  [`${ROUND2}/review-security-code.txt@b852abf6c599`]: POLL_161,
  [`${ROUND2}/review-style.txt@22d76e0141da`]: POLL_161,
  [`${ROUND2}/review-testing-practices.txt@8c0f0b344d6d`]: POLL_161,
  [`${ROUND3}/review-architecture.txt@5dce5ec75377`]: POLL_161,
  [`${ROUND3}/review-clean-code.txt@ccf906348249`]: POLL_161,
  [`${ROUND3}/review-highload.txt@a70379671abb`]: POLL_161,
  [`${ROUND3}/review-logic.txt@f086de40ff96`]: POLL_161,
  [`${ROUND3}/review-performance.txt@38b52f339c27`]: POLL_161,
  [`${ROUND3}/review-security-code.txt@5ed15ca8cae1`]: POLL_161,
  [`${ROUND3}/review-style.txt@47607f71e020`]: POLL_161,
  [`${ROUND3}/review-testing-practices.txt@7b02605069a1`]: POLL_161,
  [`${ROUND3}/review-verifier.txt@fcbf6b25c7c4`]: POLL_162_163,
};

export function decisionFor(row: ReplayRow, decisions: Record<string, string> = DECISIONS): string {
  return row.same ? "none" : (decisions[decisionKey(row)] ?? "undecided");
}

const LABELLED = /```REVIEW_RESULT\s*\n([\s\S]*?)```/gi;

export function outcome(result: ParsedResult | undefined, empty: boolean): string {
  if (empty) return "empty";
  if (result === undefined) return "none";
  const findings = Array.isArray(result.findings) ? String(result.findings.length) : "-";
  return `${result.reviewer ?? "-"}|${result.status}|f=${findings}|reviewer-result=${isReviewerResult(result)}`;
}

function labelledCaptureBroken(raw: string): boolean {
  const labelled = [...raw.matchAll(LABELLED)];
  if (labelled.length === 0) return false;
  try {
    JSON.parse(labelled[labelled.length - 1]![1]!);
    return false;
  } catch {
    return true;
  }
}

export function classify(raw: string, old: ParsedResult | undefined, next: ParsedResult | undefined): ReplayCause {
  if (old === undefined && next !== undefined) return labelledCaptureBroken(raw) ? "fence-inner-backticks" : "unclassified";
  if (old !== undefined && !isReviewerResult(old) && next === undefined) return "status-only-fragment";
  return "unclassified";
}

export interface ReplayParsers {
  old: (raw: string) => ParsedResult | undefined;
  next: (raw: string) => ParsedResult | undefined;
}

export const REPORT_PATH = ".metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/replay-report.md";

const PARSERS: ReplayParsers = { old: legacyParseReviewResult, next: parseReviewResult };

export function replayRaw(file: string, raw: string, parsers: ReplayParsers = PARSERS): ReplayRow {
  const empty = isEmptyOutput(raw);
  const old = parsers.old(raw);
  const next = parsers.next(raw);
  const before = outcome(old, empty);
  const after = outcome(next, empty);
  const same = before === after && isDeepStrictEqual(old, next);
  return {
    file,
    hash: createHash("sha256").update(raw).digest("hex").slice(0, 12),
    old: before,
    next: after,
    same,
    cause: same ? "none" : classify(raw, old, next),
  };
}

const SKIPPED_DIRS = new Set(["node_modules", "research-evidence", "drivers"]);

function isReplayable(relative: string): boolean {
  const parts = relative.split("/");
  const name = parts[parts.length - 1]!;
  const ancestors = parts.slice(0, -2);
  return name.endsWith(".txt") && parts[parts.length - 2] === "raw" && !ancestors.some((part) => SKIPPED_DIRS.has(part) || part === "raw");
}

function walkFiles(root: string, relative: string): string[] {
  const files: string[] = [];
  if (!existsSync(path.join(root, relative))) return files;
  const stack = [relative];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  return files;
}

const GIT_OPTIONS = { encoding: "utf8" as const, env: withoutGitDiscoveryOverrides(process.env) };

/** Tracked paths under `relative`, or `undefined` when `root` is not the top of a git checkout (or git cannot run). A failing `ls-files` inside a checkout is an error, never a reason to walk. */
function trackedFiles(root: string, relative: string): string[] | undefined {
  const top = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], GIT_OPTIONS);
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(root)) return undefined;
  const listed = spawnSync("git", ["-C", root, "ls-files", "-z", "--", relative], { ...GIT_OPTIONS, maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed in ${root} (${listed.error?.message ?? `exit ${listed.status}`}): ${listed.stderr.trim()}`);
  }
  return listed.stdout.split("\0").filter((entry) => entry !== "");
}

/** True when the file exists and its real location is exactly `relative` under the real root: no symbolic link in the path, a tracked file deleted from the working tree or a symlink loop is skipped. */
function isPlainFileUnder(realRoot: string, relative: string): boolean {
  try {
    return realpathSync(path.join(realRoot, relative)) === path.join(realRoot, relative);
  } catch {
    return false;
  }
}

export function replayRepository(root: string): ReplayRow[] {
  const realRoot = realpathSync(root);
  const candidates = trackedFiles(root, ".metaproject/flows") ?? walkFiles(root, ".metaproject/flows");
  return candidates
    .filter(isReplayable)
    .filter((relative) => isPlainFileUnder(realRoot, relative))
    .sort()
    .map((relative) => replayRaw(relative, readFileSync(path.join(realRoot, relative), "utf8")));
}

const cell = (value: string): string => value.replaceAll("|", "\\|");

export function renderReplayReport(rows: ReplayRow[], decisions: Record<string, string> = DECISIONS): string {
  const differing = rows.filter((row) => !row.same);
  const lines = [
    "# Replay of the closed review rounds (flow 441, AC16)",
    "",
    "Old parser = `legacyParseReviewResult` (`parseReviewResult` as of 249bc59b). New parser = `parseReviewResult` in `src/review/ledger.ts`.",
    "Outcome format: `reviewer|status|f=<findings>|reviewer-result=<bool>`; `none` = no result, `empty` = empty output.",
    `Regenerate with \`bun src/review/replay.ts --write ${REPORT_PATH}\` (from any directory). The parser was not tuned to remove any row; each difference carries the operator decision recorded for that file and hash in \`DECISIONS\`, or \`undecided\`.`,
    "",
    "Replayed: files named `*.txt` whose parent directory is `raw`, under `.metaproject/flows`, with no `raw`, `drivers`, `research-evidence` or `node_modules` directory above that `raw`. Where the replayed root is the top of a git checkout, only the files git tracks are listed (`git ls-files`; a git failure there is an error, not a reason to walk). Where it is not (a root below the checkout top, or no git), the directory is walked instead. A path that resolves through a symbolic link, and a tracked file missing from the working tree, are skipped. `.metaproject/data/**/raw/` is gitignored local working state and is not replayed. The PR 992 round 3 package (`.metaproject/reviews/2026-10-13-pr-992-round3-d20089aa/`) has no `raw/` directory on main, so its nine replies are not part of this replay.",
    "",
    `Files replayed: ${rows.length}. Same: ${rows.length - differing.length}. Differences: ${differing.length}.`,
    "",
    "| File | sha256[:12] | Old | New | Cause | Decision |",
    "| --- | --- | --- | --- | --- | --- |",
    ...differing.map((row) => `| ${row.file} | ${row.hash} | ${cell(row.old)} | ${cell(row.next)} | ${row.cause} | ${decisionFor(row, decisions)} |`),
    "",
    "## Causes",
    "",
    "- `fence-inner-backticks`: the old parser cut a `REVIEW_RESULT` fence at the first triple backtick, even one inside a JSON string, found invalid JSON and returned no result; the new parser reads the whole fence and returns the reviewer result the file holds (finding F-016 of the PR 997 round 2 package, `2026-10-13-pr-997-round2-d5a8cfdc`).",
    "- `status-only-fragment`: the old parser accepted any object with a string `status`; the file holds a verifier envelope with no reviewer name; the new parser returns none, so `loadRaws` keeps the file with no result and `ledger build` records one gap for it, \"no parseable REVIEW_RESULT block\". Accepted by the operator in polls 162 and 163.",
    "- `unclassified`: a difference neither cause explains; the repository test fails on it.",
    "- Any difference, whatever its cause, is `undecided` until `DECISIONS` lists its file and hash; the repository test fails on `undecided`.",
    "",
    "## Files with the same outcome",
    "",
    ...rows.filter((row) => row.same).map((row) => `- ${row.file} (${row.hash}): ${row.old}`),
    "",
  ];
  return lines.join("\n");
}

export function replayReport(root: string): string {
  const rows = replayRepository(root);
  if (rows.length === 0) throw new Error(`no tracked raw reviewer replies found under ${root}/.metaproject/flows`);
  return renderReplayReport(rows);
}

if (import.meta.main) {
  const report = replayReport(path.resolve(import.meta.dir, "..", ".."));
  const flag = process.argv.indexOf("--write");
  if (flag === -1) process.stdout.write(report);
  else {
    const target = process.argv[flag + 1];
    if (!target) throw new Error("--write needs a target path");
    await Bun.write(path.resolve(target), report);
  }
}
