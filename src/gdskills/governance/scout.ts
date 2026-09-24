// Flow 309, W1 Lane C — `keryx skills scout`, the pre-creation dedupe gate
// (W1-AC9). Deterministic, lexical, offline: the same `normalizeRouteText`/
// `routeTokens` tokenizer the skill router itself scores with
// (`src/lib/route-tokens.ts`), so a scout decision and a live routing
// decision can never silently disagree about what counts as a shared term.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { jaccardSimilarity } from "../bundled-eval";
import { normalizeRouteText, routeTokens } from "../../lib/route-tokens";
import type { CatalogEntry } from "./catalog-index";

/**
 * Overlap score at or above which an existing skill should be used as-is
 * rather than forked or duplicated. Calibrated against the real bundled
 * catalog: scouting an existing skill's own description returns its own id
 * at or above this score (the description IS the bulk of that skill's
 * scored text), and an unrelated query scores every entry well below it.
 */
export const SCOUT_USE_THRESHOLD = 0.55;

/** Overlap score at or above which a fork (partial reuse) is recommended over a fresh `create`. */
export const SCOUT_FORK_THRESHOLD = 0.3;

export type ScoutDecision = "use" | "fork" | "create";

export interface ScoutMatch {
  readonly skillId: string;
  readonly overlapScore: number;
  readonly reason: string;
}

export interface ScoutResult {
  readonly query: string;
  readonly decision: ScoutDecision;
  readonly thresholds: { readonly use: number; readonly fork: number };
  readonly matches: readonly ScoutMatch[];
}

export interface ScoutOptions {
  readonly threshold?: { readonly use?: number; readonly fork?: number };
}

function scoreEntry(queryTokens: ReadonlySet<string>, entry: CatalogEntry): { score: number; reason: string } {
  const haystack = [entry.name, entry.description, ...entry.triggers].join(" ");
  const entryTokens = routeTokens(normalizeRouteText(haystack));
  const score = jaccardSimilarity(queryTokens, entryTokens);
  const shared = [...queryTokens].filter((token) => entryTokens.has(token)).sort();
  return { score, reason: shared.length > 0 ? `shared terms: ${shared.join(", ")}` : "no shared terms" };
}

/**
 * Score `query` against `catalog` and decide `use | fork | create`. Top 5
 * matches, sorted by score descending then id (a deterministic tie-break so
 * two runs against the same catalog always report the same order).
 */
export function scoutSkill(query: string, catalog: readonly CatalogEntry[], options: ScoutOptions = {}): ScoutResult {
  const use = options.threshold?.use ?? SCOUT_USE_THRESHOLD;
  const fork = options.threshold?.fork ?? SCOUT_FORK_THRESHOLD;
  const queryTokens = routeTokens(normalizeRouteText(query));

  const scored = catalog
    .map((entry) => {
      const { score, reason } = scoreEntry(queryTokens, entry);
      return { skillId: entry.id, overlapScore: score, reason };
    })
    .sort((a, b) => b.overlapScore - a.overlapScore || a.skillId.localeCompare(b.skillId));

  const matches = scored.slice(0, 5);
  const top = scored[0];
  let decision: ScoutDecision = "create";
  if (top !== undefined) {
    if (top.overlapScore >= use) decision = "use";
    else if (top.overlapScore >= fork) decision = "fork";
  }

  return { query, decision, thresholds: { use, fork }, matches };
}

// ---------------------------------------------------------------------------
// Scout log (`--record <pack-dir>`)
// ---------------------------------------------------------------------------

export interface ScoutRecordEntry {
  readonly query: string;
  readonly decision: ScoutDecision;
  readonly topMatch: string | null;
  readonly recordedAt: string;
  readonly skillName: string;
}

function scoutLogPath(packDir: string): string {
  return path.join(packDir, "governance", "scout.json");
}

/** The scout log for `packDir`, `[]` when none has been recorded yet. The guard tests' entry point (W1's Lane D dispatch names this export explicitly). */
export function readScoutRecord(packDir: string): ScoutRecordEntry[] {
  const file = scoutLogPath(packDir);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as ScoutRecordEntry[];
  return Array.isArray(parsed) ? parsed : [];
}

/** Append one scout run to `<packDir>/governance/scout.json`, sorted for a stable diff. */
export function recordScout(packDir: string, entry: ScoutRecordEntry): void {
  const file = scoutLogPath(packDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const next = [...readScoutRecord(packDir), entry].sort(
    (a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.query.localeCompare(b.query) || a.skillName.localeCompare(b.skillName),
  );
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// `--include-imports` (W4 not built yet)
// ---------------------------------------------------------------------------

export interface ScoutImportsReport {
  readonly searched: boolean;
  readonly reason: string;
}

/** Honest "not built yet" answer for `--include-imports` — W4 (bundle import) ships no imported-bundle store this workstream can search. */
export function scoutImports(): ScoutImportsReport {
  return { searched: false, reason: "no imported bundles (W4 not installed)" };
}

// ---------------------------------------------------------------------------
// `--candidate <dir>` (W8 vetting)
// ---------------------------------------------------------------------------

export interface ScoutVettingSummary {
  readonly available: boolean;
  readonly reason?: string;
  readonly summary?: { readonly findings: number; readonly bySeverity: Readonly<Record<string, number>> };
}

/**
 * Runs W8's `runHarnessAudit` over a scout candidate directory, when asked
 * (`--candidate <dir>`).
 *
 * `runHarnessAudit(root)` audits a PROJECT root — instructions, settings,
 * MCP configs, hooks, agent definitions, skills, imported bundles — not an
 * arbitrary directory. A bare skill candidate directory has none of those
 * surfaces, so most runs report every surface `not-applicable` and zero
 * findings; that is still an honest answer (nothing suspicious found in what
 * WAS scannable), not a fabricated pass. If the call throws — the directory
 * does not exist, or a surface reader chokes on an unexpected shape — this
 * reports `available: false` with the reason, per the "no fake pass"
 * instruction: an audit that could not run is not a clean audit.
 *
 * A nonexistent or non-directory `candidateDir` is refused up front, the
 * same guard `keryx security audit-harness` itself added at its CLI layer
 * (see `src/commands/security-audit-harness.ts`'s "F5" comment):
 * `runHarnessAudit` does not check this itself, and calling it on a missing
 * directory reports a scan of nothing as a clean pass — exactly the fake
 * pass this function exists to refuse.
 */
export async function scoutVetCandidate(candidateDir: string): Promise<ScoutVettingSummary> {
  const stat = existsSync(candidateDir) ? statSync(candidateDir) : undefined;
  if (stat === undefined || !stat.isDirectory()) {
    return { available: false, reason: `no such directory: ${candidateDir}` };
  }
  try {
    const { runHarnessAudit } = await import("../../security/audit-harness/index");
    const report = await runHarnessAudit(candidateDir);
    const bySeverity: Record<string, number> = {};
    for (const finding of report.findings) {
      bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
    }
    return { available: true, summary: { findings: report.findings.length, bySeverity } };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
