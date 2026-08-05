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
  "--follow", "--no-follow",
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

/**
 * Options the `search_code` TOOL refuses even though the CLI forwards them.
 *
 * `-e`/`--regexp` supplies the pattern through a flag, which moves every
 * positional operand from "the pattern" to "a path". A review used exactly that
 * to turn a `risk: "read"`, auto-approved tool into an arbitrary file reader:
 * `search_code {pattern: "/home/…/.aws/credentials", flags: ["-e", "."]}` built
 * `rg -e . -- /home/…/.aws/credentials`, and the root confinement never applied
 * because it only ever guarded `input.path`.
 *
 * The capability is not lost — the tool has a `pattern` field, which is the same
 * question asked in the shape the tool can confine. What is refused is the
 * SECOND way of asking it, because two pattern sources mean the operand's
 * meaning depends on which one was used.
 */
export const SEARCH_TOOL_REJECTED_OPTIONS: ReadonlySet<string> = new Set([
  "-e",
  "--regexp",
  // `--follow` is the second lesson of the same shape, one level up. Confining
  // the OPERAND is not confining the SEARCH: ripgrep given an in-root directory
  // will walk out of it through a symlink when told to follow one. A review
  // watched the tool correctly refuse a symlink as `path` and then read the
  // identical out-of-root file through that same symlink with `--follow` — no
  // approver, because `search_code` is `risk: "read"`, and the secret landed
  // unredacted in the gdctx raw log on the way past.
  //
  // Refused rather than silently neutralised: {@link SEARCH_TOOL_FORCED_OPTIONS}
  // appends `--no-follow` regardless, but a caller who asks for traversal should
  // be told it is not on offer instead of watching the flag do nothing.
  "--follow",
]);

/**
 * Options the tool appends to EVERY invocation, after the caller's flags and
 * before the pattern, so the last occurrence wins.
 *
 * This is the belt to {@link SEARCH_TOOL_REJECTED_OPTIONS}'s braces. The
 * rejection is a list and lists are behind; this is positional and holds even
 * for an alias nobody has thought of, because ripgrep resolves the last
 * occurrence of a boolean and this one is always last.
 */
export const SEARCH_TOOL_FORCED_OPTIONS: readonly string[] = ["--no-follow"];

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

/**
 * Classify one option token for the `search_code` tool: the CLI's allowlist,
 * minus the options that would move the meaning of a positional operand.
 */
export function checkSearchToolOption(token: string): RgOptionCheck {
  const [name] = token.split("=", 1) as [string];
  if (SEARCH_TOOL_REJECTED_OPTIONS.has(name)) {
    return {
      ok: false,
      reason:
        `${name} is not accepted here — it would supply a second pattern and turn the search ` +
        "target into a path. Put the expression in `pattern` instead.",
    };
  }
  return checkRgOption(token);
}
