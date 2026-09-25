// Flow 308 (AC8): the production data source behind `/conform` — recent
// reference documents, the three target options (current branch's PR, the
// most recent review package, the working diff), and running the check
// through the same core+adapter pipeline `keryx review conform` uses. Thin
// glue over `src/review/conform-*.ts` (core) and
// `src/harness/decision/jev-client.ts` (client) — `src/tui/` is a CLIENT
// zone (`src/lib/import-zones.ts`) and may import both freely.
//
// Same opt-in/credential gate as `keryx review conform`
// (`src/commands/review.ts`), checked again here rather than trusted from the
// CLI: the TUI is a second, independent entry point into the same
// conformance pipeline, and AC9 applies to every entry point.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  applyClauseTags,
  buildClauseTagQuestions,
  clauseTagFromChoice,
  extractReferenceClauses,
  type ReferenceClause,
} from "../review/conform-clauses";
import { cachedTagsFor, hashConformDocContent, readClauseTagCache, writeClauseTagCache } from "../review/conform-tag-cache";
import {
  computePrConformFacts,
  computeReportConformFacts,
  hunkClauseFacts,
  hunkRedactedStateText,
  hunkRegionsFromDiff,
  prClauseFacts,
  prRedactedStateText,
  reportClauseFacts,
  reportRedactedStateText,
  type ReportFindingLike,
} from "../review/conform-state";
import type { ScopedRegion } from "../review/scope";
import {
  aggregateConformVerdicts,
  batchConformItems,
  boundHunkRegions,
  DEFAULT_CONFORM_THRESHOLD,
  DEFAULT_MAX_HUNK_CALLS,
  DEFAULT_MAX_HUNKS,
  evaluatedVerdict,
  notCheckableVerdict,
  notEvaluatedVerdict,
  type ConformBatchItem,
  type ConformClauseAggregate,
  type ConformHunkLocation,
  type ConformVerdict,
} from "../review/conform-jev";
import { createGhConformPrPort } from "../review/conform-pr-port";
import { readConformEnabled, withRecentDoc, CONFORM_RECENTS_PATH } from "../review/conform-report";
import { callJevSystemOne, DEFAULT_JEV_MODEL, resolveJevApiKey } from "../harness/decision/jev-client";
import type { ConformClauseRow, ConformRunOutcome, ConformSetupRead, ConformTargetOption } from "./conform-inspector";

async function readRecentConformDocs(cwd: string): Promise<readonly string[]> {
  try {
    const raw = JSON.parse(await readFile(path.join(cwd, CONFORM_RECENTS_PATH), "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as string[]) : [];
  } catch {
    return [];
  }
}

async function currentBranchPrTarget(cwd: string): Promise<ConformTargetOption | undefined> {
  const proc = Bun.spawn(["gh", "pr", "view", "--json", "number,title"], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) return undefined;
  try {
    const parsed = JSON.parse(stdout) as { number?: number; title?: string };
    if (typeof parsed.number !== "number") return undefined;
    return { id: `pr:${parsed.number}`, kind: "pr", label: `PR #${parsed.number} — ${parsed.title ?? ""} (current branch)` };
  } catch {
    return undefined;
  }
}

/** The most recently modified review-package directory (under `.metaproject/flows/<id>/reviews/`) that carries a `report.md`. */
async function mostRecentReviewPackage(cwd: string): Promise<string | undefined> {
  const flowsDir = path.join(cwd, ".metaproject", "flows");
  let best: { dir: string; mtimeMs: number } | undefined;
  try {
    for (const flowEntry of await readdir(flowsDir, { withFileTypes: true })) {
      if (!flowEntry.isDirectory()) continue;
      const reviewsDir = path.join(flowsDir, flowEntry.name, "reviews");
      let reviewEntries: import("node:fs").Dirent[];
      try {
        reviewEntries = await readdir(reviewsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const reviewEntry of reviewEntries) {
        if (!reviewEntry.isDirectory()) continue;
        const dir = path.join(reviewsDir, reviewEntry.name);
        try {
          const info = await stat(path.join(dir, "report.md"));
          if (best === undefined || info.mtimeMs > best.mtimeMs) best = { dir, mtimeMs: info.mtimeMs };
        } catch {
          // no report.md in this candidate — not a usable package
        }
      }
    }
  } catch {
    return undefined;
  }
  return best?.dir;
}

/** AC8: recent docs + the three target options, never throwing — a note explains an empty state. */
export async function loadConformSetup(cwd: string): Promise<ConformSetupRead> {
  if (!(await readConformEnabled(cwd))) {
    return {
      recents: await readRecentConformDocs(cwd),
      targets: [],
      note:
        'review.jev.conform is not enabled for this project. Enable it in .metaproject/tasks.config.json ({"review":{"jev":{"conform":true}}}) — conformance checking sends redacted PR/report/hunk text to OpenRouter/TypeSafe.',
    };
  }
  const recents = await readRecentConformDocs(cwd);
  const targets: ConformTargetOption[] = [];
  const pr = await currentBranchPrTarget(cwd);
  if (pr !== undefined) targets.push(pr);
  const reviewDir = await mostRecentReviewPackage(cwd);
  if (reviewDir !== undefined) {
    targets.push({ id: `report:${reviewDir}`, kind: "report", label: `most recent review package — ${path.relative(cwd, reviewDir)}` });
  }
  targets.push({ id: "diff:working", kind: "diff", label: "the working diff" });
  return { recents, targets };
}

async function readReportFindings(reportDir: string): Promise<readonly ReportFindingLike[]> {
  try {
    const raw = JSON.parse(await readFile(path.join(reportDir, "findings.json"), "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as ReportFindingLike[]) : [];
  } catch {
    return [];
  }
}

/** Flow 326, AC4: one row per clause — the aggregate the CLI's own report reads, not one row per hunk × clause. */
function toRow(agg: ConformClauseAggregate): ConformClauseRow {
  return {
    clause_id: agg.clause_id,
    state_kind: agg.state_kind,
    status: agg.status,
    ...(agg.probability !== undefined ? { probability: agg.probability } : {}),
    ...(agg.reason !== undefined ? { reason: agg.reason } : {}),
    evidence: agg.factLines,
    ...(agg.hunksJudged > 0 ? { hunksJudged: agg.hunksJudged, hunksBelowThreshold: agg.hunksBelowThreshold } : {}),
    ...(agg.worst !== undefined ? { worst: agg.worst } : {}),
    ...(agg.furtherViolations.length > 0 ? { furtherViolations: agg.furtherViolations } : {}),
  };
}

/**
 * AC8: run the whole conformance check for one (refPath, target) pair —
 * clause extraction/tagging, state gathering, and Jev scoring, exactly the
 * pipeline `keryx review conform` runs. `signal` cancels an in-flight Jev
 * call when the modal closes mid-run (same discipline `runCiTriageForItem`
 * already established for `/ci`).
 */
export async function runConformForTarget(
  cwd: string,
  refPath: string,
  target: ConformTargetOption,
  signal?: AbortSignal,
): Promise<ConformRunOutcome> {
  if (!(await readConformEnabled(cwd))) {
    return { ok: false, reason: "review.jev.conform is not enabled for this project." };
  }
  const apiKey = resolveJevApiKey(process.env);
  if (apiKey === undefined || apiKey.length === 0) {
    return { ok: false, reason: "OPENROUTER_API_KEY is not set, and no openrouterKey is saved in the keryx shell config." };
  }
  try {
    const docText = await readFile(refPath, "utf8");
    const rawClauses = extractReferenceClauses(docText);
    const contentHash = hashConformDocContent(docText);
    const cache = await readClauseTagCache(cwd);
    const cachedTags = cachedTagsFor(cache, refPath, contentHash) ?? {};
    const resolved = new Map<string, { source: "jev" | "cache"; tag: ReturnType<typeof clauseTagFromChoice> }>();
    for (const [id, tag] of Object.entries(cachedTags)) resolved.set(id, { source: "cache", tag });
    const needsTagging = rawClauses.filter((c) => c.explicit === undefined && cachedTags[c.clause_id] === undefined);
    const tagQuestions = buildClauseTagQuestions(needsTagging);
    if (Object.keys(tagQuestions).length > 0) {
      const tagResult = await callJevSystemOne(
        globalThis.fetch,
        { model: DEFAULT_JEV_MODEL, state: "Reference-document clause classification.", questions: tagQuestions },
        { ...(signal !== undefined ? { signal } : {}) },
      );
      const fresh: Record<string, ReturnType<typeof clauseTagFromChoice>> = {};
      for (const [id, answer] of Object.entries(tagResult.answers)) {
        if (answer.type !== "choice") continue;
        const tag = clauseTagFromChoice(answer.choice);
        resolved.set(id, { source: "jev", tag });
        fresh[id] = tag;
      }
      if (Object.keys(fresh).length > 0) await writeClauseTagCache(cwd, refPath, contentHash, fresh);
    }
    const clauses: ReferenceClause[] = applyClauseTags(rawClauses, resolved);
    await writeRecentConformDoc(cwd, refPath);

    const notCheckable = clauses.filter((c) => !c.checkable);
    const checkable = clauses.filter((c) => c.checkable);
    const supplied = new Set<string>();
    let evaluated: ConformVerdict[] = [];

    const score = async (
      items: readonly ConformBatchItem[],
      sharedRedactedText: string,
      location?: ConformHunkLocation,
    ): Promise<ConformVerdict[]> => {
      const out: ConformVerdict[] = [];
      for (const batch of batchConformItems(items, sharedRedactedText)) {
        const result = await callJevSystemOne(
          globalThis.fetch,
          { model: DEFAULT_JEV_MODEL, state: batch.state, questions: batch.questions },
          { ...(signal !== undefined ? { signal } : {}) },
        );
        for (const item of batch.items) {
          const answer = result.answers[item.clause.clause_id];
          const probability = answer?.type === "noul" ? answer.noul : 0;
          out.push(evaluatedVerdict(item.clause, item.facts, probability, DEFAULT_CONFORM_THRESHOLD, location));
        }
      }
      return out;
    };

    // Flow 326, AC3: the same hunk × clause question budget the CLI applies —
    // the TUI is a second, independent entry point into the same pipeline.
    const scoreHunkRegions = async (hunkClauses: readonly ReferenceClause[], regions: readonly ScopedRegion[]): Promise<void> => {
      if (regions.length > 0) for (const clause of hunkClauses) supplied.add(clause.clause_id);
      const bounded = boundHunkRegions(regions, hunkClauses.length, DEFAULT_MAX_HUNK_CALLS);
      for (const region of bounded.regions) {
        evaluated = evaluated.concat(
          await score(hunkClauses.map((clause) => ({ clause, facts: hunkClauseFacts(region) })), hunkRedactedStateText(region), {
            path: region.path,
            startLine: region.startLine,
            endLine: region.endLine,
          }),
        );
      }
    };

    if (target.kind === "pr") {
      const number = Number(target.id.slice("pr:".length));
      const port = createGhConformPrPort(undefined, undefined);
      const info = await port.pr(number);
      const facts = computePrConformFacts(info);
      const redacted = prRedactedStateText(info);
      const prClauses = checkable.filter((c) => c.state_kind === "pr");
      for (const clause of prClauses) supplied.add(clause.clause_id);
      evaluated = evaluated.concat(await score(prClauses.map((clause) => ({ clause, facts: prClauseFacts(clause, facts) })), redacted));

      const hunkClauses = checkable.filter((c) => c.state_kind === "hunk");
      await scoreHunkRegions(hunkClauses, hunkRegionsFromDiff(info.diff));
    } else if (target.kind === "report") {
      const reportDir = target.id.slice("report:".length);
      const reportMarkdown = await readFile(path.join(reportDir, "report.md"), "utf8").catch(() => "");
      const findings = await readReportFindings(reportDir);
      const facts = computeReportConformFacts(reportMarkdown, findings);
      const redacted = reportRedactedStateText(reportMarkdown);
      const reportClauses = checkable.filter((c) => c.state_kind === "report");
      for (const clause of reportClauses) supplied.add(clause.clause_id);
      evaluated = await score(reportClauses.map((clause) => ({ clause, facts: reportClauseFacts(clause, facts) })), redacted);
    } else {
      const proc = Bun.spawn(["git", "diff", "--no-color"], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const diff = await new Response(proc.stdout).text();
      await proc.exited;
      const hunkClauses = checkable.filter((c) => c.state_kind === "hunk");
      await scoreHunkRegions(hunkClauses, hunkRegionsFromDiff(diff));
    }

    const notEvaluated = checkable.filter((c) => !supplied.has(c.clause_id)).map((c) => notEvaluatedVerdict(c));
    const verdicts = [...evaluated, ...notEvaluated, ...notCheckable.map((c) => notCheckableVerdict(c))];
    const aggregates = aggregateConformVerdicts(verdicts, DEFAULT_MAX_HUNKS);
    return { ok: true, refPath, target, clauses: aggregates.map(toRow) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function writeRecentConformDoc(cwd: string, refPath: string): Promise<void> {
  const { writeFileAtomic } = await import("../lib/fs");
  const current = await readRecentConformDocs(cwd);
  // 0o600: local filesystem paths other users on the same machine should not see.
  await writeFileAtomic(path.join(cwd, CONFORM_RECENTS_PATH), `${JSON.stringify(withRecentDoc(current, refPath), null, 2)}\n`, {
    mode: 0o600,
  }).catch(() => {});
}
