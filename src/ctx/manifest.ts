// The loss manifest: where the omitted content is, and how to get it back.
//
// Flow 235 / T9, AC4 (AFC-30). What gdctx had was a scalar —
// `compacted: 172,847 → 3,917 bytes (98% saved)` plus a path to the raw log.
// That says how much went missing and gives one all-or-nothing way to re-read
// everything. It cannot say WHERE the loss is, so a reader who wanted the one
// omitted region had to fetch the whole megabyte and search it again, which is
// exactly the re-search the criterion forbids ("доступный пропуск раскрывается
// по адресу без поиска").
//
// Two properties follow from the specification (§6) and neither is decorative:
//
//   1. Every entry is an ADDRESS. It names a line range and the literal command
//      that returns that range, so recovery is a copy-paste and not a search.
//   2. The manifest is itself bounded, and when it is cut that is stated
//      (`truncated=true`). A manifest that silently lists 20 of 63 omitted
//      ranges is the same defect one level up: a partial record that reads as
//      complete.

import type { OmittedRange } from "./lines";

/** How many ranges a rendered manifest will list before it truncates itself. */
export const MANIFEST_MAX_ENTRIES = 12;

export type LossManifestEntry = OmittedRange & {
  /** Lines in this range. */
  lines: number;
  /** The command that returns exactly this range. */
  recover: string;
};

export type LossManifest = {
  entries: LossManifestEntry[];
  /** Ranges the manifest could not list. */
  omittedEntries: number;
  /** True when the manifest itself was shortened. Never inferred by a reader. */
  truncated: boolean;
  /** Ranges before truncation. */
  totalRanges: number;
  /** Source lines the body does not contain. */
  omittedLines: number;
};

/**
 * Build a manifest over `ranges`, addressed at `artifactAddress`.
 *
 * `artifactAddress` is the project-relative path this run's raw copy is written
 * to — the same string the summary prints as `raw:` — so the recovery command
 * in an entry can be pasted straight back into a shell.
 */
export function buildLossManifest(
  ranges: OmittedRange[],
  artifactAddress: string,
  maxEntries: number = MANIFEST_MAX_ENTRIES,
): LossManifest {
  const omittedLines = ranges.reduce((total, range) => total + (range.end - range.start + 1), 0);
  // Largest gaps first: with a bounded list, the ranges worth naming are the
  // ones that hide the most, not the ones that happen to come first.
  const ordered = [...ranges].sort((a, b) => b.end - b.start - (a.end - a.start));
  const kept = ordered.slice(0, Math.max(0, maxEntries)).sort((a, b) => a.start - b.start);

  return {
    entries: kept.map((range) => ({
      ...range,
      lines: range.end - range.start + 1,
      recover: recoverCommand(artifactAddress, range),
    })),
    omittedEntries: ranges.length - kept.length,
    truncated: kept.length < ranges.length,
    totalRanges: ranges.length,
    omittedLines,
  };
}

/** `keryx ctx show <address> --raw --lines 121-2500`. */
export function recoverCommand(artifactAddress: string, range: OmittedRange): string {
  return `keryx ctx show ${artifactAddress} --raw --lines ${range.start}-${range.end}`;
}

/** The `## Omitted` section, or "" when nothing was dropped. */
export function renderLossManifest(manifest: LossManifest): string {
  if (manifest.totalRanges === 0) {
    return "";
  }
  const rows = manifest.entries.map(
    (entry) => `- lines ${entry.start}-${entry.end} (${entry.lines}) — \`${entry.recover}\``,
  );
  if (manifest.truncated) {
    rows.push(
      `- manifest truncated: ${manifest.omittedEntries} of ${manifest.totalRanges} omitted ranges are not listed above`,
    );
  }
  return `## Omitted

${manifest.omittedLines} of the source lines are not in the body above, in ${manifest.totalRanges} range(s). Each range is addressable — recover it without re-reading the whole artifact:

${rows.join("\n")}
`;
}
