import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
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

export function replayRaw(file: string, raw: string): ReplayRow {
  const empty = isEmptyOutput(raw);
  const old = legacyParseReviewResult(raw);
  const next = parseReviewResult(raw);
  const before = outcome(old, empty);
  const after = outcome(next, empty);
  const same = before === after;
  return {
    file,
    hash: createHash("sha256").update(raw).digest("hex").slice(0, 12),
    old: before,
    next: after,
    same,
    cause: same ? "none" : classify(raw, old, next),
  };
}

function rawDirs(root: string): string[] {
  const dirs: string[] = [];
  const parents = [".metaproject/flows", ".metaproject/data/review"];
  for (const parent of parents) {
    const base = path.join(root, parent);
    if (!existsSync(base)) continue;
    const stack = [base];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (!statSync(full).isDirectory()) continue;
        if (entry === "raw") dirs.push(full);
        else if (entry !== "node_modules" && entry !== "research-evidence" && entry !== "drivers") stack.push(full);
      }
    }
  }
  return dirs.sort();
}

export function replayRepository(root: string): ReplayRow[] {
  const rows: ReplayRow[] = [];
  for (const dir of rawDirs(root)) {
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".txt")).sort()) {
      const relative = path.relative(root, path.join(dir, name)).split(path.sep).join("/");
      rows.push(replayRaw(relative, readFileSync(path.join(dir, name), "utf8")));
    }
  }
  return rows;
}

export function renderReplayReport(rows: ReplayRow[]): string {
  const differing = rows.filter((row) => !row.same);
  const lines = [
    "# Replay of the closed review rounds (flow 441, AC16)",
    "",
    "Old parser = `legacyParseReviewResult` (`parseReviewResult` as of 249bc59b). New parser = `parseReviewResult` in `src/review/ledger.ts`.",
    "Outcome format: `reviewer|status|f=<findings>|reviewer-result=<bool>`; `none` = no result, `empty` = empty output.",
    "Regenerate with `bun src/review/replay.ts --write <path>`. The parser was not tuned to remove any row; every difference awaits an operator decision.",
    "",
    `Files replayed: ${rows.length}. Same: ${rows.length - differing.length}. Differences: ${differing.length}.`,
    "",
    "| File | sha256[:12] | Old | New | Cause | Decision |",
    "| --- | --- | --- | --- | --- | --- |",
    ...differing.map((row) => `| ${row.file} | ${row.hash} | ${row.old} | ${row.next} | ${row.cause} | undecided |`),
    "",
    "## Causes",
    "",
    "- `fence-inner-backticks`: the old parser cut a `REVIEW_RESULT` fence at the first triple backtick, even one inside a JSON string, found invalid JSON and returned no result; the new parser reads the whole fence and returns the reviewer result the file holds (F-016).",
    "- `status-only-fragment`: the old parser accepted any object with a string `status`; the file holds a verifier envelope with no reviewer name, which `loadRaws` already ignored as a non-reviewer result. The new parser returns none.",
    "- `unclassified`: a difference neither cause explains; the repository test fails on it.",
    "",
    "## Files with the same outcome",
    "",
    ...rows.filter((row) => row.same).map((row) => `- ${row.file} (${row.hash}): ${row.old}`),
    "",
  ];
  return lines.join("\n");
}

if (import.meta.main) {
  const root = process.cwd();
  const report = renderReplayReport(replayRepository(root));
  const flag = process.argv.indexOf("--write");
  if (flag === -1) process.stdout.write(report);
  else {
    const target = process.argv[flag + 1];
    if (!target) throw new Error("--write needs a target path");
    await Bun.write(path.resolve(root, target), report);
  }
}
