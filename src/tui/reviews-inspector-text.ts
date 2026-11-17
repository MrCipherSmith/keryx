// The pure, OpenTUI-free half of `reviews-inspector.ts`: the /reviews and /review layers|parity|readiness text
// the readline shell and the ACP `shell` profile print. `reviews-inspector.ts` re-exports it.

import { loadReviewDepth, renderReviewDegradationText, renderReviewDepthText, renderReviewLayersText, renderReviewParityText, renderReviewReadinessText, type ReviewDepthRow } from "./review-panel";
import { computeBotMetrics, formatRatio, renderBotMetrics, type BotMetrics, type ReviewRow } from "../review/bot/metrics";


export const REVIEWS_COMMAND = "/reviews";
export const REVIEWS_EMPTY = "No managed pull request reviews yet. Run `keryx review bot run --pr <n>`.";

/** `/review layers`: the layers of every managed review, as text. The bare `/review` stays the catch-up inspector. */
export function isReviewLayersCommand(line: string): boolean {
  const [token, sub] = line.trim().split(/\s+/);
  return token === "/review" && sub === "layers";
}

/** `/review parity`: Not run candidates, held severities and open follow-ups of every managed review, as text. */
export function isReviewParityCommand(line: string): boolean {
  const [token, sub] = line.trim().split(/\s+/);
  return token === "/review" && sub === "parity";
}

/** `/review readiness`: the readiness checklist of every managed review, as text. */
export function isReviewReadinessCommand(line: string): boolean {
  const [token, sub] = line.trim().split(/\s+/);
  return token === "/review" && sub === "readiness";
}

export { renderReviewDegradationText, renderReviewLayersText, renderReviewParityText, renderReviewReadinessText };

export function isReviewsCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === REVIEWS_COMMAND;
}

export function formatReviewsHeaderLines(metrics: BotMetrics): string[] {
  return [
    `${metrics.reviews} review(s) on ${metrics.pulls} pull request(s); ${metrics.raised} finding(s) raised, ${metrics.open} open`,
    `precision ${formatRatio(metrics.precision)}   resolved before merge ${formatRatio(metrics.resolvedBeforeMerge.ratio)}`,
  ];
}

export function formatReviewRowLines(row: ReviewRow): string[] {
  const resolved = row.resolvedBeforeMerge === null ? "n/a" : `${row.resolvedBeforeMerge} of ${row.findings}`;
  return [
    `${row.pull}  round ${row.round}  head ${row.head === null ? "unknown" : row.head.slice(0, 7)}`,
    `  findings ${row.findings}: acted on ${row.actedOn}, dismissed ${row.dismissed}, answered ${row.answeredDisagree}, open ${row.unknown}`,
    `  precision ${formatRatio(row.precision)}   resolved before merge ${resolved}`,
  ];
}

/** One block per managed review, a blank line between blocks. */
export function formatReviewsRowLines(metrics: BotMetrics): string[] {
  if (metrics.rows.length === 0) return [REVIEWS_EMPTY];
  return metrics.rows.flatMap((row, index) => (index === 0 ? formatReviewRowLines(row) : ["", ...formatReviewRowLines(row)]));
}

/** The readline shell's `/reviews`: the block `keryx review metrics` prints, then the review rows. */
export function renderReviewsText(metrics: BotMetrics, depth?: readonly ReviewDepthRow[]): string {
  const base = `${renderBotMetrics(metrics)}\n${formatReviewsRowLines(metrics).join("\n")}\n`;
  return depth === undefined ? base : `${base}\n${renderReviewDepthText(depth)}`;
}

/** The readline shell's `/reviews`, read from disk: the same numbers as `keryx review metrics`. Never throws. */
export async function readlineReviewsText(cwd: string): Promise<string> {
  try {
    return renderReviewsText(await computeBotMetrics(cwd), await loadReviewDepth(cwd));
  } catch {
    return "The managed reviews could not be read.\n";
  }
}
