// Flow 353 AC3: "did you mean" suggestions for an unknown command or
// subcommand. A SEPARATE small edit-distance matcher from
// `standard/help-groups.ts`'s `closestHelpTopics` (deliberately not reused
// or exported from there): that one scales its threshold with the query's
// length for a free-text `keryx help <topic>` lookup over a much larger
// vocabulary. AC3 pins a FIXED "edit distance ≤ 2" over a short, closed set
// of command/subcommand names, where a length-scaled threshold would start
// matching almost anything for a one- or two-letter typo on a short word.

const MAX_SUGGESTIONS = 3;
const MAX_EDIT_DISTANCE = 2;

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) {
    const row = dp[i];
    if (row !== undefined) row[0] = i;
  }
  const first = dp[0];
  if (first !== undefined) {
    for (let j = 0; j < cols; j += 1) first[j] = j;
  }
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const same = a[i - 1] === b[j - 1];
      const up = dp[i - 1]?.[j] ?? 0;
      const left = dp[i]?.[j - 1] ?? 0;
      const diag = dp[i - 1]?.[j - 1] ?? 0;
      const row = dp[i];
      if (row !== undefined) row[j] = same ? diag : 1 + Math.min(up, left, diag);
    }
  }
  return dp[rows - 1]?.[cols - 1] ?? Math.max(a.length, b.length);
}

/**
 * Up to {@link MAX_SUGGESTIONS} names from `known` closest to `input`, by
 * edit distance ≤ {@link MAX_EDIT_DISTANCE}, closest first — ties broken
 * alphabetically so the output is deterministic rather than depending on
 * `known`'s own order. Empty when nothing is within range: a nonsense word
 * gets no suggestions, never a forced "closest" match that is not actually
 * close.
 */
export function suggestClosest(input: string, known: readonly string[]): string[] {
  const needle = input.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }
  return [...new Set(known)]
    .map((candidate) => ({ candidate, distance: levenshtein(needle, candidate.toLowerCase()) }))
    .filter((entry) => entry.distance <= MAX_EDIT_DISTANCE)
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.candidate);
}

/**
 * The exact one-line message AC3 pins, verbatim — one fixed template for
 * both an unknown top-level command and an unknown subcommand of a known
 * group; the frozen criterion's own template says "Unknown command:" in
 * both cases, never "subcommand". The "Did you mean" clause is dropped
 * entirely (not printed empty) when {@link suggestClosest} found nothing.
 * `helpCommand` names the help that lists the right set: the group's own
 * help for a subcommand, so the reader is not sent to the top-level usage
 * for a name that only lives under `keryx mcp`.
 */
export function formatUnknownCommandMessage(
  input: string,
  known: readonly string[],
  helpCommand = "keryx --help",
): string {
  const suggestions = suggestClosest(input, known);
  const didYouMean = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
  return `Unknown command: ${input}.${didYouMean} Run \`${helpCommand}\` for the list.`;
}
