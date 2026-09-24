// Shared CLI flag/positional parser for `keryx learn` (`src/commands/learn.ts`)
// and `keryx review learn --reviewer`'s own flag parsing
// (`src/commands/review.ts`'s `runLearnReviewer`) — review round 1, R1-F3 +
// R1-F5. Before this module existed, each command tested boolean flags with
// `args.includes("--dry-run")` and picked the id with
// `args.find((arg) => !arg.startsWith("-"))`. Both break the same way:
//
//  - `--dry-run=true` (or any `--flag=value` on a flag that is meant to be a
//    bare boolean) is accepted as "the flag is present" by an unrelated
//    unknown-flag check (it strips the `=value` before comparing names), but
//    `args.includes("--dry-run")` reads it as ABSENT — so `prune --dry-run=true`
//    deletes for real, `apply --dry-run=1` writes the skill for real, `accept
//    --refresh=1` runs a full accept instead of a refresh, and `review learn
//    --reviewer <id> --dry-run=1` writes the `.mdc` file for real. A preview
//    flag silently becoming a durable/destructive write is exactly the
//    consent-invariant class this workstream exists to prevent.
//  - `args.find((arg) => !arg.startsWith("-"))` takes a value-flag's own value
//    as the positional when that flag precedes it: `reject --scope user foo`
//    reads `id: "user"`, not `"foo"`; `apply --skill m/n <id>` reads
//    `id: "m/n"`.
//
// `parseLearnArgs` fixes both classes at once: a flag declared `boolean` never
// accepts `=value` (that spelling is reported back in `bad`, refused by the
// caller exactly like a genuinely unknown flag — same message, same
// "unknown flag(s)" substring existing tests already assert on), and a flag
// declared `value` always consumes its own next token (space or `=` form)
// before positionals are collected, so a value-flag's value is never
// mistaken for a positional.
export interface LearnArgSpec {
  /** Flags that take no value. `--name=value` for one of these is refused (`bad`). */
  boolean?: readonly string[];
  /** Flags that take exactly one value, `--name value` or `--name=value`. Missing the value is refused (`bad`). */
  value?: readonly string[];
}

export interface ParsedLearnArgs {
  /** Every boolean flag present (bare — an `=value` spelling is never added here; it goes to `bad` instead). */
  flags: ReadonlySet<string>;
  /** The value for each `value` flag seen. The last occurrence wins. */
  values: ReadonlyMap<string, string>;
  /** Every arg that is neither a recognized flag nor a value consumed by one — in order. */
  positionals: readonly string[];
  /**
   * Raw `--...` args this spec refuses: an unrecognized flag name, a boolean
   * flag given `=value`, or a value flag given no value (a trailing flag, or
   * one immediately followed by another `--flag`). Empty when every flag in
   * `args` was well-formed and known. The caller decides how to report this
   * (`learn.ts`/`review.ts` both render it as `unknown flag(s): <bad.join(", ")>`).
   */
  bad: readonly string[];
}

/**
 * Parses `args` against `spec`. Never throws — a malformed or unrecognized
 * flag is collected into `ParsedLearnArgs.bad` for the caller to refuse
 * uniformly (see module header for why "refuse the same way as unknown"
 * matters here).
 */
export function parseLearnArgs(args: readonly string[], spec: LearnArgSpec): ParsedLearnArgs {
  const booleanNames = new Set(spec.boolean ?? []);
  const valueNames = new Set(spec.value ?? []);
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];
  const bad: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (!arg.startsWith("--")) {
      // R2-F2: a single-dash arg other than the lone `-` (a real, if unusual,
      // positional some CLIs use for "stdin") is refused like an unknown
      // flag, not silently accepted as a positional — `prune -n` or
      // `extract -x` used to fall straight through to the positional list
      // (ignored by every verb that takes none) instead of being reported.
      if (arg.startsWith("-") && arg !== "-") {
        bad.push(arg);
        continue;
      }
      positionals.push(arg);
      continue;
    }

    const equals = arg.indexOf("=");
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    const inlineValue = equals >= 0 ? arg.slice(equals + 1) : undefined;

    if (booleanNames.has(name)) {
      if (inlineValue !== undefined) {
        bad.push(arg); // a boolean flag takes no value, in either spelling
        continue;
      }
      flags.add(name);
      continue;
    }

    if (valueNames.has(name)) {
      if (inlineValue !== undefined) {
        values.set(name, inlineValue);
        continue;
      }
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        bad.push(arg); // no value to consume — a trailing flag or one immediately followed by another flag
        continue;
      }
      values.set(name, next);
      index += 1;
      continue;
    }

    bad.push(arg);
  }

  return { flags, values, positionals, bad };
}
