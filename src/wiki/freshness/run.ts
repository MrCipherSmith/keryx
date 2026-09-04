// `keryx wiki freshness` orchestration (LWG-10, flow 226).
//
// Gathers the changed files for a revision range, classifies them, builds the
// report, and persists it. Exits 0 whatever it finds — see `report.ts` for
// why this is a report and not a gate.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadGdgraphConfig } from "../../gdgraph/config";
import { loadGraph } from "../../gdgraph/query";
import { runCapabilityOrFallback } from "../../capability/seam";
import { resolveTreesitterCapability } from "../../gdgraph/treesitter/adapter";
import type { SymbolLayer } from "../../gdgraph/types";
import { gitCmd } from "../../sync/provenance";
import { classifyChanges, type FileChange, type SymbolExtractor } from "./classify-change";
import { clearQueue, drainQueue, earliestRev } from "./queue";
import type { GitRunner } from "./page-freshness";
import { buildFreshnessReport, type FreshnessReport } from "./report";

export interface RunFreshnessInput {
  cwd: string;
  /** Base revision. Defaults to `HEAD~1` when git is available. */
  since?: string | undefined;
  git?: GitRunner;
  now?: () => Date;
}

export function freshnessDir(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "wiki", "freshness");
}

export async function runFreshness(input: RunFreshnessInput): Promise<FreshnessReport> {
  const git = input.git ?? gitCmd;
  const cwd = input.cwd;

  const head = (await git(cwd, ["rev-parse", "HEAD"])) ?? "";
  const gitAvailable = head.length > 0;

  // An explicit `--since` wins. Otherwise the queue supplies the base, which
  // is the whole point of accumulating it: nobody should have to remember
  // which revision they last looked at. With neither, fall back to the last
  // commit rather than inventing a wider range.
  const drained = input.since ? null : await drainQueue(cwd);
  const queueBase = drained ? earliestRev(drained.entries) : undefined;
  const fromRev = gitAvailable ? (input.since ?? queueBase ?? "HEAD~1") : undefined;

  const changes = gitAvailable ? await collectChanges(cwd, git, fromRev as string) : [];
  const extractor = await resolveSymbolExtractor(cwd);
  const classified = await classifyChanges({ changes, extractSymbols: extractor });

  const graph = await loadGraph(cwd);
  const report = await buildFreshnessReport({
    cwd,
    graph,
    changes: classified.changes,
    symbolLayerAvailable: classified.symbolLayerAvailable,
    git,
    fromRev,
    toRev: gitAvailable ? head : "working-tree",
    ...(drained ? { queueEntriesConsumed: drained.entries.length } : {}),
    ...(drained?.truncated ? { queueTruncated: true } : {}),
    ...(input.now ? { now: input.now } : {}),
  });

  if (drained && drained.corruptLines > 0) {
    // Skipped, counted, and declared. The queue is written by a shell hook
    // that a killed commit or a full disk can interrupt mid-append; a
    // half-written line must cost that one revision, not the report — and
    // must not cost it silently.
    report.limitations.push({
      code: "queue-truncated",
      detail: `${drained.corruptLines} unreadable queue line(s) were skipped. Those revisions are missing from this range; re-run with an explicit --since to cover them.`,
      affectedCount: drained.corruptLines,
    });
  }

  if (!gitAvailable) {
    // Declared, not implied. A short report from a git-free project must not
    // read as "little is stale" — the range simply could not be computed, and
    // every page fell back to the coarser scope-hash path.
    report.limitations.unshift({
      code: "not-a-git-repository",
      detail:
        "No git history was available, so no revision range could be computed and freshness fell back to VerifiedScope comparison. Findings are capped at `review-suggested`.",
    });
  }

  await persist(cwd, report);
  // Only after the report is safely on disk. Clearing first would lose the
  // range if persisting then failed, and the next run would silently report a
  // narrower window than the user asked about.
  if (drained && drained.entries.length > 0) {
    await clearQueue(cwd);
  }
  return report;
}

async function persist(cwd: string, report: FreshnessReport): Promise<void> {
  const dir = freshnessDir(cwd);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join(dir, "latest.md"), renderMarkdown(report), "utf8");
}

/** Changed files between `fromRev` and the working tree, with rename info. */
async function collectChanges(
  cwd: string,
  git: GitRunner,
  fromRev: string,
): Promise<FileChange[]> {
  const status = await git(cwd, ["diff", "--name-status", "-M", fromRev]);
  if (status === null) {
    return [];
  }

  const changes: FileChange[] = [];
  for (const line of status.split("\n")) {
    const parts = line.split("\t");
    const code = parts[0];
    if (!code) continue;

    if (code.startsWith("R") && parts[1] && parts[2]) {
      changes.push({
        path: parts[2],
        previousPath: parts[1],
        before: await showFile(cwd, git, fromRev, parts[1]),
        after: await readCurrent(cwd, parts[2]),
      });
      continue;
    }
    const file = parts[1];
    if (!file) continue;

    if (code.startsWith("A")) {
      changes.push({ path: file, after: await readCurrent(cwd, file) });
    } else if (code.startsWith("D")) {
      changes.push({ path: file, before: await showFile(cwd, git, fromRev, file) });
    } else {
      changes.push({
        path: file,
        before: await showFile(cwd, git, fromRev, file),
        after: await readCurrent(cwd, file),
      });
    }
  }
  return changes;
}

async function showFile(
  cwd: string,
  git: GitRunner,
  rev: string,
  file: string,
): Promise<string | undefined> {
  const content = await git(cwd, ["show", `${rev}:${file}`]);
  return content ?? undefined;
}

async function readCurrent(cwd: string, file: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(cwd, file), "utf8");
  } catch {
    return undefined;
  }
}

async function resolveSymbolExtractor(cwd: string): Promise<SymbolExtractor | null> {
  try {
    const config = await loadGdgraphConfig(cwd);
    const adapter = await resolveTreesitterCapability(cwd, {
      languages: config.treesitter.languages,
      grammarsPath: config.treesitter.grammarsPath,
    });
    if (!adapter) {
      return null;
    }
    return async (files) =>
      runCapabilityOrFallback<{ files: typeof files }, SymbolLayer>(
        adapter as never,
        { files },
        () => ({ symbols: [], calls: [] }),
      );
  } catch {
    return null;
  }
}

/**
 * Human view. `fyi` rows are hidden unless asked for: measured on this
 * repository, one signature change in a hub module reaches 37 of 50 pages,
 * and a backlog nobody reads is a backlog that does not exist. The data stays
 * complete in `latest.json`; only the default view is trimmed.
 */
export function renderMarkdown(report: FreshnessReport, options?: { all?: boolean }): string {
  const shown = options?.all ? report.pages : report.pages.filter((p) => p.confidence !== "fyi");
  const hidden = report.pages.length - shown.length;
  const lines: string[] = [
    "# Wiki freshness",
    "",
    `Generated: ${report.generatedAt}`,
    `Range: ${report.range.fromRev ?? "(none)"} → ${report.range.toRev}`,
    "",
    `- pages: ${report.totals.pagesTotal} total, ${report.totals.pagesFresh} fresh, ` +
      `${report.totals.pagesAffected} affected, ${report.totals.pagesUndecidable} undecidable`,
    `- files: ${report.totals.filesChanged} changed, ${report.totals.filesCosmetic} cosmetic`,
    "",
  ];

  if (shown.length === 0) {
    lines.push("No pages need attention in this range.", "");
  } else {
    lines.push("## Pages", "");
    for (const entry of shown) {
      const behind = entry.commitsBehind > 0 ? `${entry.commitsBehind} commits behind` : "no commit count";
      lines.push(`### ${entry.path}`, "", `${entry.category} · ${entry.confidence} · ${behind}`, "");
      for (const reason of entry.reasons.slice(0, 5)) {
        const via = reason.edgePath.join(" → ");
        const symbols = reason.symbols.length > 0 ? ` (${reason.symbols.join(", ")})` : "";
        lines.push(`- \`${reason.sourcePath}\` ${reason.changeClass}${symbols} via ${via}`);
      }
      lines.push("");
    }
  }

  if (hidden > 0) {
    lines.push(`_${hidden} advisory (\`fyi\`) row(s) hidden; pass \`--all\` or read latest.json._`, "");
  }

  if (report.limitations.length > 0) {
    lines.push("## What this report could not see", "");
    for (const limitation of report.limitations) {
      const count = limitation.affectedCount === undefined ? "" : ` (${limitation.affectedCount})`;
      lines.push(`- **${limitation.code}**${count} — ${limitation.detail}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
