// The ripgrep options `keryx ctx rg` forwards — the single source of truth.
//
// These tables were module-level constants inside `src/commands/ctx.ts`. They
// moved here so the `search_code` TOOL can forward exactly what the VERB
// forwards, and so the parity test can read one list instead of trusting two.
// A tool that accepts fewer options than the CLI it wraps teaches the model to
// bypass it through a default-deny shell (tool-surface.md §P4.1).
//
// The allowlist is what fails closed: an unknown `-…` is refused rather than
// passed to ripgrep, because ripgrep has options (`--pre`, `-f`) that execute an
// external program for every file it considers. An option added to a future
// ripgrep is therefore denied by default instead of inherited.
//
// Pure data plus one pure classifier — no imports, no side effects.

/** rg boolean flags keryx forwards (no value follows). */
export const RG_FORWARDED_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "-i", "--ignore-case",
  "-s", "--case-sensitive",
  "-S", "--smart-case",
  "-w", "--word-regexp",
  "-x", "--line-regexp",
  "-F", "--fixed-strings",
  "-v", "--invert-match",
  "-U", "--multiline",
  "--multiline-dotall",
  "-l", "--files-with-matches",
  "--files-without-match",
  "--files",
  "-c", "--count",
  "--count-matches",
  "--hidden",
  "--no-ignore",
  "--no-ignore-vcs",
  "--follow",
  "-n", "--line-number",
  "-N", "--no-line-number",
  "--column", "--no-column",
  "--no-heading", "--heading",
  "--stats",
  "--crlf",
]);

/** rg flags that consume a following value (or use the `--flag=value` form). */
export const RG_FORWARDED_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-e", "--regexp",
  "-g", "--glob",
  "--iglob",
  "-t", "--type",
  "-T", "--type-not",
  "-A", "--after-context",
  "-B", "--before-context",
  "-C", "--context",
  "-m", "--max-count",
  "-M", "--max-columns",
  "--max-depth",
  "--sort", "--sortr",
]);

/** Every option name `keryx ctx rg` forwards, sorted. */
export function forwardedRgOptions(): string[] {
  return [...RG_FORWARDED_BOOLEAN_FLAGS, ...RG_FORWARDED_VALUE_FLAGS].sort();
}

/** Outcome of validating one caller-supplied rg option token. */
export type RgOptionCheck =
  | { ok: true; consumesValue: boolean }
  | { ok: false; reason: string };

/**
 * Classify one `-…` token against the forwarded allowlist.
 *
 * `--flag=value` is accepted for a value flag and reported as NOT consuming a
 * following token. An unknown option is refused with the CLI's own reasoning, so
 * the tool and the verb say the same thing when they say no.
 */
export function checkRgOption(token: string): RgOptionCheck {
  const [name] = token.split("=", 1) as [string];
  const inlineValue = token.includes("=");
  if (RG_FORWARDED_VALUE_FLAGS.has(name)) {
    return { ok: true, consumesValue: !inlineValue };
  }
  if (RG_FORWARDED_BOOLEAN_FLAGS.has(name) && !inlineValue) {
    return { ok: true, consumesValue: false };
  }
  return {
    ok: false,
    reason:
      `unsupported ripgrep option ${name}. Only a reviewed set of options is forwarded, ` +
      "because ripgrep has options that execute external programs.",
  };
}
