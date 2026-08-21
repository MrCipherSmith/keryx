// Pure version-compatibility logic (spec.md §3, AC8). Mirrors the comparator
// shape already established in the core keryx codebase at
// `src/harness/external/registry.ts` (`compareVersions`, `knownGoodRange:
// {min}`) — advisory only, never a hard block: "a CLI that renames its
// version banner must not become unusable" is that file's own precedent, and
// the same discipline applies here to the installed `keryx` binary.

/**
 * Compare two dotted numeric versions. Returns <0, 0 or >0. Missing
 * components count as 0; a non-numeric component (pre-release suffix, a
 * stale/garbled version banner) compares as 0 rather than throwing.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.split(".").map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** Extract a bare dotted version from `keryx --version` output ("0.2.49\n" → "0.2.49"). */
export function parseKeryxVersion(versionOutput: string): string | undefined {
  const match = /(\d+(?:\.\d+)*)/.exec(versionOutput);
  return match?.[1];
}

export type VersionCheckVerdict =
  | { readonly state: "ok" }
  | { readonly state: "below-minimum"; readonly installed: string; readonly minimum: string }
  | { readonly state: "undetermined" };

/**
 * AC8: judge the installed keryx version against the extension's declared
 * minimum. Never a hard block — "undetermined" (unparseable version output)
 * and "below-minimum" both resolve to a non-blocking warning at the call
 * site, never a refusal to activate.
 */
export function checkKeryxVersion(
  versionOutput: string,
  minKeryxVersion: string,
): VersionCheckVerdict {
  const installed = parseKeryxVersion(versionOutput);
  if (!installed) return { state: "undetermined" };
  if (compareVersions(installed, minKeryxVersion) < 0) {
    return { state: "below-minimum", installed, minimum: minKeryxVersion };
  }
  return { state: "ok" };
}

/** Non-blocking warning text for a below-minimum verdict. */
export function versionWarningMessage(verdict: Extract<VersionCheckVerdict, { state: "below-minimum" }>): string {
  return `Installed keryx (${verdict.installed}) is below this extension's minimum supported version (${verdict.minimum}). Some features may not work correctly — consider upgrading keryx.`;
}
