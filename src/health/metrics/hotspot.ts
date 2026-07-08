// Git-churn × complexity hotspot signal (Block D · D1; specification.md §7.1,
// §8.1). Pure, dependency-free, no I/O: it folds the already-loaded churn map
// (`getChurn`) and per-function complexity (`analyzeSourceFiles`) into a
// deterministic per-file hotspot ranking.
//
// score(file) = churn(file) × complexity(file). A file that is complex but
// never changes (or churns but is trivial) scores low — both dimensions are
// required, which is the CodeScene behavioral edge. The ranking is sorted by
// score desc, then file asc, so it is reproducible byte-for-byte (`XP4`).

import type { SourceFileAnalysis } from "../source-analysis";

export type FileHotspot = {
  file: string;
  churn: number;
  complexity: number;
  score: number;
};

// score = churn × complexity. Pure arithmetic; both inputs default to 0 when a
// file is unknown to git (churn 0) or has no functions (complexity 0).
export function hotspotScore(churn: number, complexity: number): number {
  return churn * complexity;
}

// Σ of per-function cyclomatic complexity for a file (0 when it has none).
export function fileComplexity(analysis: SourceFileAnalysis | undefined): number {
  if (!analysis) {
    return 0;
  }
  return analysis.complexity.reduce((sum, value) => sum + value, 0);
}

// Rank the given files by hotspot score (desc), tiebroken by file path (asc) so
// the output is deterministic and reproducible. Files absent from git churn
// count as churn 0; files with no analyzed functions count as complexity 0.
export function rankHotspots(
  files: string[],
  churn: Map<string, number>,
  sourceAnalysis: Map<string, SourceFileAnalysis>,
): FileHotspot[] {
  return files
    .map((file) => {
      const churnValue = churn.get(file) ?? 0;
      const complexity = fileComplexity(sourceAnalysis.get(file));
      return {
        file,
        churn: churnValue,
        complexity,
        score: hotspotScore(churnValue, complexity),
      };
    })
    .sort((a, b) => (b.score - a.score) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
